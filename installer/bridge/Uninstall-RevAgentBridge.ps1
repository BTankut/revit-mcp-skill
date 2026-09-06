<#
.SYNOPSIS
    EU-20/M6 (P3-T10) cutover uninstaller for the revAgent Bridge: removes
    the E4/P-INST-3 machine wipe-list, structurally preserves the three
    P-SEQ-2 rollback anchors, applies the bounded two-section Codex MCP
    config edit, and emits wipe-report.json. Idempotent re-run;
    -WhatIf/-DryRun performs zero mutations.

.DESCRIPTION
    Scope LegacyCutover (default) retains the original legacy wipe/task/Codex
    behavior. Scope BridgeOwned removes only verified Bridge payload, known
    runtime state and an exact owned manifest. It requires the signed package,
    trusted keys and a fresh report outside the affected roots. It does not
    run legacy task/tree/Codex cleanup or modify shared Autodesk directory ACLs.

    This script is repo-preparation for EU-20: the true gate (destructive
    lab-machine removal) is NOT exercised here and is not granted. Run only
    against redirected roots in a non-machine-mutating test/dry-run context
    unless you are the operator executing the gated lab session.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('LegacyCutover','BridgeOwned')][string]$Scope = 'LegacyCutover',
    [string]$PackageRoot = '',
    [string]$TrustedKeysPath = '',
    [string]$RevitVersion = '2022',
    [string]$ProgramDataRoot = $env:ProgramData,
    [string]$LocalAppDataRoot = $env:LOCALAPPDATA,
    [string]$CodexConfigPath = '',
    [string]$InstallRoot = '',
    [string]$StateRoot = '',
    [string]$AddinProgramFilesRoot = '',
    [string]$RevitAddinsRoot = '',
    [string]$MachineReportPath = '',
    [switch]$DryRun,
    [switch]$SkipScheduledTaskRemoval,
    [switch]$SkipServiceRemoval
)

$ErrorActionPreference = 'Stop'
$Scope = if ($Scope -ieq 'BridgeOwned') { 'BridgeOwned' } else { 'LegacyCutover' }
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Import-Module (Join-Path $PSScriptRoot 'lib\RevAgent.BridgeInstall.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.Reporting.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.CodexRegistration.psm1') -Force

$isDryRun = [bool]$DryRun -or ($WhatIfPreference -eq $true)
$startedAtUtc = (Get-Date).ToUniversalTime()
$steps = [System.Collections.Generic.List[object]]::new()
$reportStatus = 'success'
$reportMessage = 'Uninstall completed.'
$errors = [System.Collections.Generic.List[string]]::new()
$ownedReportValidated = $false

function Get-BridgeLayoutArgs {
    $layoutArgs = @{}
    if ($InstallRoot) { $layoutArgs.InstallRoot = $InstallRoot }
    if ($StateRoot) { $layoutArgs.StateRoot = $StateRoot }
    if ($AddinProgramFilesRoot) { $layoutArgs.AddinProgramFilesRoot = $AddinProgramFilesRoot }
    if ($RevitAddinsRoot) { $layoutArgs.RevitAddinsRoot = $RevitAddinsRoot }
    return $layoutArgs
}

$anchors = Get-RevAgentBridgeRollbackAnchors -ProgramDataRoot $ProgramDataRoot
$keepList = Get-RevAgentBridgeKeepList -ProgramDataRoot $ProgramDataRoot
$anchorHashesBefore = Get-RevAgentBridgeAnchorHashes -Anchors $anchors

# Symmetric with Install-RevAgentBridge.ps1's evidence-forgeability fields
# (config/bridge-machine-report.schema.json): this script never calls
# icacls, so icaclsInvokerInjected is always false, but the process
# elevation state is still recorded so the same true-gate-evidence
# acceptance rule in docs/plan/M6_EU20_LAB_RUNBOOK.md applies uniformly to
# both reports.
$isCurrentlyElevated = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

$uninstallSummary = [ordered]@{
    scope                  = $Scope
    ownedCleanup           = $null
    scheduledTasks         = @()
    legacyTrees             = @()
    codexConfig             = $null
    anchors                 = @()
    serviceRemoved          = $false
    icaclsInvokerInjected   = $false
    elevated                = $isCurrentlyElevated
}

try {
    $bridgeLayoutArgs = Get-BridgeLayoutArgs
    $layout = Get-RevAgentBridgeLayout @bridgeLayoutArgs

    if ($Scope -eq 'BridgeOwned') {
        if (-not $PackageRoot -or -not $TrustedKeysPath -or -not $MachineReportPath) { throw 'bridge_owned_package_keys_and_external_report_required' }
        if ($CodexConfigPath -or $SkipScheduledTaskRemoval) { throw 'bridge_owned_legacy_options_not_applicable' }
        $addin = Get-RevAgentBridgeAddinLayout -Layout $layout -RevitVersion $RevitVersion
        $external = [IO.Path]::GetFullPath($MachineReportPath)
        foreach ($root in @($layout.InstallRoot,$layout.StateRoot,$layout.AddinProgramFilesRoot,$layout.RevitAddinsRoot)) {
            if ($external -ieq $root -or $external.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'bridge_owned_report_inside_affected_root' }
        }
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $external -GuardRoot ([IO.Path]::GetPathRoot($external)))
        if ((Test-Path -LiteralPath $external) -or -not (Test-Path -LiteralPath (Split-Path $external -Parent) -PathType Container)) { throw 'bridge_owned_report_must_be_fresh_with_existing_parent' }
        $ownedReportValidated = $true
        if (-not $isDryRun -and -not $isCurrentlyElevated) { throw 'bridge_owned_cleanup_requires_administrator' }
        $owned = Get-RevAgentBridgeOwnedCleanupPlan -Layout $layout -RevitVersion $RevitVersion -PackageRoot $PackageRoot -TrustedKeysPath $TrustedKeysPath -Anchors $anchors
        if (@(Get-Process -Name Revit -ErrorAction SilentlyContinue).Count) { throw 'bridge_owned_revit_must_be_closed' }
        $service = @(Get-CimInstance Win32_Service -Filter "Name='revAgentBridge'" -ErrorAction Stop)
        if ($service.Count -gt 1) { throw 'bridge_owned_service_ambiguous' }
        if ($service.Count -eq 1) {
            if ($SkipServiceRemoval -or $service[0].PathName.Trim() -cne ('"'+$layout.HostExecutablePath+'"') -or $service[0].StartName -cne 'LocalSystem') { throw 'bridge_owned_service_identity_mismatch' }
            [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'stop_owned_bridge_service' -DryRun $isDryRun -Steps $steps -Apply {
                Stop-Service -Name $layout.ServiceName -ErrorAction Stop
                return 'stopped'
            })
            $record = Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'remove_owned_bridge_service' -DryRun $isDryRun -Steps $steps -Apply {
                $saved=$ErrorActionPreference
                try { $ErrorActionPreference='Continue'; $output=& "$env:SystemRoot\System32\sc.exe" delete $layout.ServiceName 2>&1; $exit=$LASTEXITCODE }
                finally { $ErrorActionPreference=$saved }
                if($exit -ne 0){throw "bridge_owned_service_delete_failed: exit=$exit"}
                $deadline=[DateTime]::UtcNow.AddSeconds(10)
                do { $remaining=@(Get-CimInstance Win32_Service -Filter "Name='revAgentBridge'" -ErrorAction Stop); if(-not $remaining.Count){return 'removed'};Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $deadline)
                throw 'bridge_owned_service_removal_unverified'
            }
            $uninstallSummary.serviceRemoved = $record.status -eq 'applied'
        }
        if (-not $isDryRun) {
            if (@(Get-Process -Name revagent-bridge,revagent-bridge-host -ErrorAction SilentlyContinue).Count) { throw 'bridge_owned_process_still_running' }
            # Normal shutdown can flush known state files. Revalidate the whole
            # inventory after shutdown, before the first file is removed.
            $owned = Get-RevAgentBridgeOwnedCleanupPlan -Layout $layout -RevitVersion $RevitVersion -PackageRoot $PackageRoot -TrustedKeysPath $TrustedKeysPath -Anchors $anchors
        }
        $uninstallSummary.ownedCleanup = [ordered]@{ roots=$owned.roots; manifestDisposition=$owned.manifestDisposition; items=$owned.items; emptyAncestorCandidates=$owned.pruneEmpty; completed=$false; stateContentsRead=$false }
        Invoke-RevAgentBridgeOwnedCleanupPlan -Plan $owned -DryRun $isDryRun -Steps $steps
        $uninstallSummary.ownedCleanup.completed = -not $isDryRun
    }
    else {
    # --- 1. Managed scheduled tasks (named exactly, per E4/P-INST-3) ---
    if (-not $SkipScheduledTaskRemoval) {
        foreach ($taskName in Get-RevAgentBridgeManagedScheduledTaskNames) {
            $taskExists = $false
            try {
                $taskExists = ($null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue))
            }
            catch { $taskExists = $false }

            if (-not $taskExists) {
                $uninstallSummary.scheduledTasks += [pscustomobject][ordered]@{ name = $taskName; found = $false; disposition = 'not_found' }
                continue
            }

            $record = Invoke-RevAgentBridgeGuardedMutation -Target $taskName -MutationAction 'remove_scheduled_task' -DryRun $isDryRun -Steps $steps -Apply {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
                return 'removed'
            }.GetNewClosure()
            $uninstallSummary.scheduledTasks += [pscustomobject][ordered]@{ name = $taskName; found = $true; disposition = $record.status }
        }
    }

    # --- 2. Windows service (revAgentBridge) ---
    if (-not $SkipServiceRemoval) {
        $serviceExists = $false
        try { $serviceExists = ($null -ne (Get-Service -Name $layout.ServiceName -ErrorAction SilentlyContinue)) } catch { $serviceExists = $false }
        if ($serviceExists) {
            [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'stop_service' -DryRun $isDryRun -Steps $steps -Apply {
                    Stop-Service -Name $layout.ServiceName -Force -ErrorAction SilentlyContinue
                    return 'stopped'
                })
            $record = Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'unregister_service' -DryRun $isDryRun -Steps $steps -Apply {
                if (Test-Path -LiteralPath $layout.HostExecutablePath -PathType Leaf) {
                    $output = & $layout.HostExecutablePath 'uninstall' 2>&1
                    if ($LASTEXITCODE -ne 0) { throw "bridge_host_uninstall_failed: exit=$LASTEXITCODE output=$output" }
                }
                else {
                    & sc.exe delete $layout.ServiceName | Out-Null
                }
                return 'unregistered'
            }
            $uninstallSummary.serviceRemoved = ($record.status -eq 'applied')
        }
    }

    # --- 3. Legacy machine trees, with the P-SEQ-2 anchors structurally excluded ---
    foreach ($target in (Get-RevAgentBridgeLegacyRemovalTargets -ProgramDataRoot $ProgramDataRoot -LocalAppDataRoot $LocalAppDataRoot)) {
        if (-not (Test-Path -LiteralPath $target)) {
            $uninstallSummary.legacyTrees += [pscustomobject][ordered]@{ root = $target; found = $false; items = @() }
            continue
        }

        # No separate dry-run branch here: Invoke-RevAgentBridgeTreeWipePlan
        # routes every per-item removal through Invoke-RevAgentBridgeGuardedMutation
        # (passing this same $steps list), which is the only place DryRun is
        # gated. Under -DryRun this call performs zero deletions and every
        # planned removal comes back as 'would_remove'.
        $plan = Get-RevAgentBridgeTreeWipePlan -Root $target -Anchors $anchors
        $itemResults = Invoke-RevAgentBridgeTreeWipePlan -Plan $plan -DryRun $isDryRun -Steps $steps
        $failed = @($itemResults | Where-Object { $_.disposition -eq 'failed' })
        if (-not $isDryRun -and $failed.Count -gt 0) {
            throw "legacy_tree_wipe_incomplete: $($failed.Count) item(s) under $target could not be removed."
        }
        $uninstallSummary.legacyTrees += [pscustomobject][ordered]@{ root = $target; found = $true; items = $itemResults }
    }

    # --- 4. Bounded Codex config edit: exactly the two managed legacy sections ---
    if ($CodexConfigPath) {
        $codexResult = Remove-RevAgentBridgeManagedCodexSections -ConfigPath $CodexConfigPath -DryRun $isDryRun
        $uninstallSummary.codexConfig = $codexResult
        [void]$steps.Add([pscustomobject][ordered]@{
                target = $CodexConfigPath
                action = 'remove_managed_codex_sections'
                status = if ($isDryRun) { 'skipped_dry_run' } else { 'applied' }
                detail = "sectionsRemoved=$($codexResult.sectionsRemoved -join ',')"
            })
    }
    }

    # --- 5. Anchor preservation proof (hash-before == hash-after) ---
    $anchorHashesAfter = Get-RevAgentBridgeAnchorHashes -Anchors $anchors
    foreach ($anchor in $anchors) {
        $before = $anchorHashesBefore.$anchor
        $after = $anchorHashesAfter.$anchor
        $preserved = ($before -eq $after)
        $uninstallSummary.anchors += [pscustomobject][ordered]@{
            path        = $anchor
            hashBefore   = $before
            hashAfter    = $after
            preserved    = $preserved
        }
        if (-not $preserved) {
            throw "rollback_anchor_changed: $anchor changed during uninstall (before=$before after=$after)."
        }
    }

    $reportMessage = if ($isDryRun) { 'Dry run completed; zero mutations performed.' } else { 'Uninstall completed.' }
}
catch {
    $reportStatus = 'failed'
    $reportMessage = $_.Exception.Message
    [void]$errors.Add($_.Exception.Message)
}

$completedAtUtc = (Get-Date).ToUniversalTime()
$report = New-RevAgentBridgeMachineReport `
    -Action 'uninstall' `
    -DryRun $isDryRun `
    -StartedAtUtc $startedAtUtc `
    -CompletedAtUtc $completedAtUtc `
    -Status $reportStatus `
    -Message $reportMessage `
    -Steps $steps `
    -Uninstall ([pscustomobject]$uninstallSummary) `
    -Errors $errors.ToArray()

if ($Scope -eq 'LegacyCutover') { try {
    $reportLayoutArgs = Get-BridgeLayoutArgs
    $layoutForReport = Get-RevAgentBridgeLayout @reportLayoutArgs
    $reportsDirectory = if (Test-Path -LiteralPath $layoutForReport.StateRoot) { $layoutForReport.ReportsDirectory } else { $null }
    if ($reportsDirectory) {
        [void](Write-RevAgentBridgeMachineReport -Report $report -ReportsDirectory $reportsDirectory -DryRun $isDryRun)
    }
}
catch {
    [void]$errors.Add("report_persistence_failed: $($_.Exception.Message)")
} }

if ($MachineReportPath -and ($Scope -eq 'LegacyCutover' -or $ownedReportValidated)) {
    $reportJson = ($report | ConvertTo-Json -Depth 10)
    $reportDirectory = Split-Path -Parent $MachineReportPath
    if ($Scope -eq 'LegacyCutover' -and $reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
        [void](New-Item -ItemType Directory -Path $reportDirectory -Force)
    }
    if ($Scope -eq 'BridgeOwned') {
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $MachineReportPath -GuardRoot ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($MachineReportPath))))
        if (-not (Test-Path -LiteralPath $reportDirectory -PathType Container)) { throw 'bridge_owned_external_report_parent_changed' }
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes($reportJson)
        $stream=[IO.File]::Open($MachineReportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    } else { Set-Content -LiteralPath $MachineReportPath -Value $reportJson -Encoding UTF8 }
}

Write-Output ([pscustomobject]$report)

if ($reportStatus -ne 'success') {
    throw $reportMessage
}
