<#
.SYNOPSIS
    EU-20/M6 (P3-T9) workstation installer for the revAgent Bridge: verifies
    the signed payload, lays down the P-INST-1 disjoint install/state roots,
    deploys the Revit add-in + deterministic manifest, registers the Bridge
    Windows service, hands off the one-time enrollment token, and emits a
    machine report. Idempotent re-run; -WhatIf/-DryRun performs zero
    mutations.

.DESCRIPTION
    Every machine-mutating step (directory/ACL creation, binary copy,
    service registration, enrollment-artifact write, service start) is
    routed through the single guarded choke point
    Invoke-RevAgentBridgeGuardedMutation from
    installer\bridge\lib\RevAgent.BridgeInstall.psm1. Under -WhatIf or
    -DryRun that function records a 'skipped_dry_run' plan entry and never
    invokes the underlying action -- there is exactly one place a caller
    (or a test) needs to intercept to prove zero mutation.

    This script is repo-preparation for EU-20: the true gate (destructive
    lab-machine install + live Revit read) is NOT exercised here and is not
    granted. Run only against redirected -InstallRoot/-StateRoot/etc. in a
    non-machine-mutating test/dry-run context unless you are the operator
    executing the gated lab session in docs\plan\M6_EU20_LAB_RUNBOOK.md.

.PARAMETER PackageRoot
    Directory containing the signed release payload:
      - bridge-release.json           (signed content: component manifest)
      - bridge-release.json.sig       (detached RS256 signature envelope)
      - host\revagent-bridge-host.exe
      - worker\revagent-bridge.exe (+ dependencies)
      - addin\revAgentPlugin\revAgentPlugin.dll (+ dependencies)

.PARAMETER TrustedKeysPath
    Path to the trusted-keys JSON consumed by
    installer\lib\RevAgent.DistributionIntegrity.psm1's
    Test-RevitMcpDetachedJsonSignatureFile.

.PARAMETER EnrollmentToken
    The single-use, admin-minted P-ENROLL-1 enrollment token. Required for a
    fresh machine; omitted (or ignored) on an idempotent re-run once a
    device credential already exists.

.PARAMETER EnrollmentTokenExpiresAtUtc
    The token's absolute expiry (UTC). Must leave at least 50 seconds and at
    most 24h+5s of remaining lifetime at write time (P-ENROLL-1 TTL cap).

.PARAMETER PromptForEnrollment
    Prepare the genuine machine identity, display its public fingerprint and
    request a bound token with a secure prompt inside this same invocation.

.PARAMETER WaitForEnrollmentArtifact
    Prepare the genuine identity, emit only a public fingerprint readiness
    record, and wait for an out-of-band admin to atomically supply the canonical
    SYSTEM/Administrators enrollment.json. Never reads the secret in PowerShell.

.PARAMETER EnrollmentHandoffTimeoutSeconds
    Bound the protected-file handoff wait to 1-900 seconds (default 300).

.PARAMETER GatewayHostName
    DNS hostname with optional port, such as eu20-gateway.lab:8443. A fresh
    committed install requires it and emits wss://<authority>/bridge/v1.
    Existing configuration is preserved byte-for-byte. A dry run may report
    an unresolved endpoint; that does not claim a usable configuration.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
    [string]$EnrollmentToken = '',
    [Nullable[datetime]]$EnrollmentTokenExpiresAtUtc = $null,
    [switch]$PromptForEnrollment,
    [switch]$WaitForEnrollmentArtifact,
    [ValidateRange(1,900)][int]$EnrollmentHandoffTimeoutSeconds = 300,
    [string]$RevitVersion = '2022',
    [string]$GatewayHostName = '',
    [string]$InstallRoot = '',
    [string]$StateRoot = '',
    [string]$AddinProgramFilesRoot = '',
    [string]$RevitAddinsRoot = '',
    [string]$MachineReportPath = '',
    [switch]$DryRun,
    [switch]$SkipRevitDetection,
    [switch]$SkipServiceStart,
    # Test/advanced injection point for the ACL primitive every icacls.exe
    # call in this script is routed through. Production callers must never
    # pass this -- omitting it is what makes the elevation gate below
    # meaningful. Tests inject a mock here (an explicit parameter, not
    # command-name shadowing, which is not reliable across every depth of
    # nested script invocation -- see the focused test suite) so the rest
    # of a real, non-dry-run install can run hermetically as a non-admin
    # identity without ever calling the real icacls.exe.
    [scriptblock]$IcaclsInvoker = $null
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Import-Module (Join-Path $PSScriptRoot 'lib\RevAgent.BridgeInstall.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.Reporting.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.RevitVersions.psm1') -Force

$isDryRun = [bool]$DryRun -or ($WhatIfPreference -eq $true)
$startedAtUtc = (Get-Date).ToUniversalTime()
$steps = [System.Collections.Generic.List[object]]::new()
$reportStatus = 'success'
$reportMessage = 'Install completed.'
$errors = [System.Collections.Generic.List[string]]::new()
# Computed once, unconditionally, so the report always records the real
# process elevation state and whether the caller substituted the ACL
# primitive -- regardless of dry-run/step-failure branching, so evidence
# forgeability is bounded: a report cannot claim "success" from a mocked
# ACL invoker without also disclosing icaclsInvokerInjected=true, and the
# lab runbook rejects such a report as true-gate evidence (see
# docs/plan/M6_EU20_LAB_RUNBOOK.md).
$isCurrentlyElevated = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$installSummary = [ordered]@{
    revitVersion            = $RevitVersion
    revitDetected            = $null
    addinManifestPath        = $null
    addinManifestSha256      = $null
    serviceName              = 'revAgentBridge'
    enrollmentAttempted      = $false
    enrollmentArtifactWritten = $false
    machineFingerprint       = $null
    alreadyEnrolled          = $false
    serviceAlreadyInstalled  = $false
    icaclsInvokerInjected    = ($null -ne $IcaclsInvoker)
    elevated                 = $isCurrentlyElevated
    configurationDisposition = 'not_planned'
}

function Get-BridgeLayoutArgs {
    $layoutArgs = @{}
    if ($InstallRoot) { $layoutArgs.InstallRoot = $InstallRoot }
    if ($StateRoot) { $layoutArgs.StateRoot = $StateRoot }
    if ($AddinProgramFilesRoot) { $layoutArgs.AddinProgramFilesRoot = $AddinProgramFilesRoot }
    if ($RevitAddinsRoot) { $layoutArgs.RevitAddinsRoot = $RevitAddinsRoot }
    return $layoutArgs
}

try {
    $bridgeLayoutArgs = Get-BridgeLayoutArgs
    $layout = Get-RevAgentBridgeLayout @bridgeLayoutArgs
    $addinLayout = Get-RevAgentBridgeAddinLayout -Layout $layout -RevitVersion $RevitVersion

    # Every directory create/write below is guarded (New-RevAgentBridgeGuardedDirectory /
    # Write-RevAgentBridgeGuardedAtomicBytes / Assert-RevAgentBridgeNoReparsePoint,
    # this package's own link-safe primitives -- see the module for why they
    # are not installer\lib\RevAgent.Reporting.psm1's equivalents, which are
    # private to that module), which refuses to walk through a reparse point
    # (junction/symlink) anywhere between GuardRoot and the target and throws
    # before any bytes are written. GuardRoot must already
    # exist, so each top-level root is guarded from its own drive root (the
    # one ancestor guaranteed to pre-exist); once a root is created and
    # verified, deeper paths under it are guarded from that root instead.
    $installRootGuard = [System.IO.Path]::GetPathRoot($layout.InstallRoot)
    $stateRootGuard = [System.IO.Path]::GetPathRoot($layout.StateRoot)
    $addinProgramFilesGuard = [System.IO.Path]::GetPathRoot($addinLayout.AddinBinRoot)
    $revitAddinsGuard = [System.IO.Path]::GetPathRoot($addinLayout.ManifestDirectory)

    # --- 1. Signature verification (fails closed; nothing below runs on failure) ---
    $contentPath = Join-Path $PackageRoot 'bridge-release.json'
    $signaturePath = Join-Path $PackageRoot 'bridge-release.json.sig'
    if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) {
        throw "trusted_keys_missing: $TrustedKeysPath"
    }
    $trustedKeysRaw = Get-Content -Raw -LiteralPath $TrustedKeysPath | ConvertFrom-Json
    $trustedKeys = ConvertTo-RevitMcpTrustedKeyMap -TrustedKeys $trustedKeysRaw
    $verifiedContent = $null
    $verification = Test-RevitMcpDetachedJsonSignatureFile `
        -ContentPath $contentPath `
        -SignaturePath $signaturePath `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @('release-manifest') `
        -VerifiedContent ([ref]$verifiedContent)
    if (-not [bool]$verification.success) {
        throw "signature_verification_failed: $($verification.reason) $($verification.message)"
    }
    [void]$steps.Add([pscustomobject][ordered]@{ target = $contentPath; action = 'verify_signature'; status = 'verified'; detail = $null })

    # --- 2. Component hash verification against the signed manifest ---
    $hostSourcePath = Join-Path $PackageRoot ([string]$verifiedContent.host.relativePath)
    $workerSourceDirectory = Join-Path $PackageRoot ([string]$verifiedContent.worker.relativeDirectory)
    $addinSourceDirectory = Join-Path $PackageRoot ([string]$verifiedContent.addin.relativeDirectory)
    foreach ($componentCheck in @(
            @{ Path = $hostSourcePath; ExpectedSha256 = [string]$verifiedContent.host.sha256; Label = 'host executable'; IsDirectory = $false }
        )) {
        if (-not (Test-Path -LiteralPath $componentCheck.Path -PathType Leaf)) {
            throw "signed_component_missing: $($componentCheck.Label) not found at $($componentCheck.Path)"
        }
        $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $componentCheck.Path).Hash
        if (-not [string]::Equals($actualSha256, $componentCheck.ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "signed_component_hash_mismatch: $($componentCheck.Label) does not match the signed manifest. path=$($componentCheck.Path)"
        }
    }
    foreach ($directoryCheck in @(
            @{ Path = $workerSourceDirectory; ExpectedSha256 = [string]$verifiedContent.worker.sha256; Label = 'worker payload' },
            @{ Path = $addinSourceDirectory; ExpectedSha256 = [string]$verifiedContent.addin.sha256; Label = 'addin payload' }
        )) {
        if (-not (Test-Path -LiteralPath $directoryCheck.Path -PathType Container)) {
            throw "signed_component_missing: $($directoryCheck.Label) not found at $($directoryCheck.Path)"
        }
        $actualTreeSha256 = Get-RevAgentBridgeDirectoryTreeSha256 -Path $directoryCheck.Path
        if (-not [string]::Equals($actualTreeSha256, $directoryCheck.ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "signed_component_hash_mismatch: $($directoryCheck.Label) does not match the signed manifest. path=$($directoryCheck.Path)"
        }
    }
    [void]$steps.Add([pscustomobject][ordered]@{ target = $PackageRoot; action = 'verify_component_hashes'; status = 'verified'; detail = $null })

    # --- 3. Revit-version presence (reuses installer\lib\RevAgent.RevitVersions.psm1 detection) ---
    if (-not $SkipRevitDetection) {
        try {
            $revitInstallRoot = Resolve-RevitMcpInstallRoot -Version $RevitVersion -RepoRoot $RepoRoot
            $installSummary.revitDetected = $revitInstallRoot
        }
        catch {
            throw "revit_not_detected: $($_.Exception.Message)"
        }
    }

    # --- 4. Idempotent-rerun probes (read-only) ---
    $serviceAlreadyExists = $false
    try {
        $existingService = Get-Service -Name $layout.ServiceName -ErrorAction SilentlyContinue
        $serviceAlreadyExists = ($null -ne $existingService)
    }
    catch { $serviceAlreadyExists = $false }
    $installSummary.serviceAlreadyInstalled = $serviceAlreadyExists

    $deviceCredentialAlreadyExists = Test-Path -LiteralPath $layout.DeviceCredentialPath -PathType Leaf
    $installSummary.alreadyEnrolled = $deviceCredentialAlreadyExists

    # Resolve configuration before the first directory/ACL/binary mutation.
    $configurationPlan = Get-RevAgentBridgeConfigurationPlan -Path $layout.ConfigurationPath `
        -GuardRoot $stateRootGuard -GatewayHostName $GatewayHostName -AllowUnresolved:$isDryRun
    $installSummary.configurationDisposition = $configurationPlan.Disposition
    [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.ConfigurationPath; action = 'plan_bridge_config'; status = 'verified'; detail = $configurationPlan.Disposition })

    # --- Elevation gate (fails closed before any mutation) ---
    # P-INST-1's ACL lockdown (icacls /inheritance:r + /grant:r, and
    # /setowner NT AUTHORITY\SYSTEM for the credential directory) requires
    # an elevated Administrator process for real; running it unelevated
    # does not fail loudly at the ACL call -- icacls can silently strip the
    # calling identity's own inherited write access via /grant:r's replace
    # semantics, which then surfaces later as an unrelated-looking
    # "Access is denied" on the next directory this script tries to create.
    # Refuse up front instead. This check is skipped only when the caller
    # supplies -IcaclsInvoker (the test injection point above) or is
    # already in -DryRun (which performs zero mutations regardless).
    if (-not $isDryRun -and $null -eq $IcaclsInvoker -and -not $isCurrentlyElevated) {
        throw 'not_elevated: this installer must run in an elevated (Administrator) process to apply the P-INST-1 ACL lockdown; refusing before any mutation.'
    }

    # --- 5. Install root + state root + credential directory (ACL'd) ---
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.InstallRoot -MutationAction 'create_install_root' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentBridgeGuardedDirectory -Path $layout.InstallRoot -GuardRoot $installRootGuard)
            Set-RevAgentBridgeDistributionAcl -Path $layout.InstallRoot -IcaclsInvoker $IcaclsInvoker
            return $layout.InstallRoot
        }.GetNewClosure())
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.CurrentWorkerDirectory -MutationAction 'create_worker_directory' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentBridgeGuardedDirectory -Path $layout.CurrentWorkerDirectory -GuardRoot $layout.InstallRoot)
            return $layout.CurrentWorkerDirectory
        })
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.StateRoot -MutationAction 'create_state_root' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentBridgeGuardedDirectory -Path $layout.StateRoot -GuardRoot $stateRootGuard)
            Set-RevAgentBridgeDistributionAcl -Path $layout.StateRoot -IcaclsInvoker $IcaclsInvoker
            return $layout.StateRoot
        }.GetNewClosure())
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.CredentialDirectory -MutationAction 'create_credential_directory' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentBridgeGuardedDirectory -Path $layout.CredentialDirectory -GuardRoot $layout.StateRoot)
            Set-RevAgentBridgeSystemOnlyAcl -Path $layout.CredentialDirectory -IcaclsInvoker $IcaclsInvoker
            return $layout.CredentialDirectory
        }.GetNewClosure())

    # --- 6. Copy signed binaries into the disjoint install root ---
    $hostPayloadIdentical = -not $isDryRun -and (Test-RevAgentBridgeIdenticalPayload `
        -DestinationPath $layout.HostExecutablePath `
        -ExpectedSha256 ([string]$verifiedContent.host.sha256) `
        -GuardRoot $layout.InstallRoot)
    if ($hostPayloadIdentical) {
        [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.HostExecutablePath; action = 'deploy_host_executable'; status = 'verified'; detail = 'retained_identical_signed_payload' })
    }
    else {
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.HostExecutablePath -MutationAction 'deploy_host_executable' -DryRun $isDryRun -Steps $steps -Apply {
                [void](Assert-RevAgentBridgeNoReparsePoint -Path $layout.HostExecutablePath -GuardRoot $layout.InstallRoot)
                Copy-Item -LiteralPath $hostSourcePath -Destination $layout.HostExecutablePath -Force
                return $layout.HostExecutablePath
            })
    }
    $workerPayloadIdentical = -not $isDryRun -and (Test-RevAgentBridgeIdenticalPayload `
        -SourceDirectory $workerSourceDirectory `
        -DestinationPath $layout.CurrentWorkerDirectory `
        -ExpectedSha256 ([string]$verifiedContent.worker.sha256) `
        -GuardRoot $layout.InstallRoot `
        -Directory)
    if ($workerPayloadIdentical) {
        [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.CurrentWorkerDirectory; action = 'deploy_worker_payload'; status = 'verified'; detail = 'retained_identical_signed_payload' })
    }
    else {
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.CurrentWorkerDirectory -MutationAction 'deploy_worker_payload' -DryRun $isDryRun -Steps $steps -Apply {
                [void](Assert-RevAgentBridgeNoReparsePoint -Path $layout.CurrentWorkerDirectory -GuardRoot $layout.InstallRoot)
                Copy-RevAgentBridgeDirectoryContents -SourceDirectory $workerSourceDirectory -DestinationDirectory $layout.CurrentWorkerDirectory
                return $layout.CurrentWorkerDirectory
            })
    }

    # --- 7. Strict configuration; existing settings are never replaced. ---
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ConfigurationPath -MutationAction 'write_bridge_config' -DryRun $isDryRun -Steps $steps -Apply {
            $disposition = Write-RevAgentBridgeConfigurationPlan -Plan $configurationPlan -GuardRoot $layout.StateRoot
            $installSummary.configurationDisposition = $disposition
            return $disposition
        })

    # --- 8. Add-in payload + deterministic manifest (P-INST-1 / P3-T9) ---
    $addinPayloadIdentical = -not $isDryRun -and (Test-RevAgentBridgeIdenticalPayload `
        -SourceDirectory $addinSourceDirectory `
        -DestinationPath $addinLayout.AddinBinRoot `
        -ExpectedSha256 ([string]$verifiedContent.addin.sha256) `
        -GuardRoot $addinProgramFilesGuard `
        -Directory)
    if ($addinPayloadIdentical) {
        [void]$steps.Add([pscustomobject][ordered]@{ target = $addinLayout.AddinBinRoot; action = 'deploy_addin_payload'; status = 'verified'; detail = 'retained_identical_signed_payload' })
    }
    else {
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $addinLayout.AddinBinRoot -MutationAction 'deploy_addin_payload' -DryRun $isDryRun -Steps $steps -Apply {
                [void](New-RevAgentBridgeGuardedDirectory -Path $addinLayout.AddinBinRoot -GuardRoot $addinProgramFilesGuard)
                Copy-RevAgentBridgeDirectoryContents -SourceDirectory $addinSourceDirectory -DestinationDirectory $addinLayout.AddinBinRoot
                Set-RevAgentBridgeDistributionAcl -Path $addinLayout.AddinBinRoot -IcaclsInvoker $IcaclsInvoker
                return $addinLayout.AddinBinRoot
            }.GetNewClosure())
    }
    $manifestContract = New-RevAgentBridgeAddinManifestContract -AssemblyPath $addinLayout.AssemblyPath
    $installSummary.addinManifestPath = $addinLayout.ManifestPath
    $installSummary.addinManifestSha256 = $manifestContract.sha256
    $addinManifestIdentical = -not $isDryRun -and (Test-RevAgentBridgeIdenticalPayload `
        -DestinationPath $addinLayout.ManifestPath `
        -ExpectedSha256 $manifestContract.sha256 `
        -GuardRoot $revitAddinsGuard)
    if ($addinManifestIdentical) {
        [void]$steps.Add([pscustomobject][ordered]@{ target = $addinLayout.ManifestPath; action = 'write_addin_manifest'; status = 'verified'; detail = 'retained_identical_signed_payload' })
    }
    else {
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $addinLayout.ManifestPath -MutationAction 'write_addin_manifest' -DryRun $isDryRun -Steps $steps -Apply {
                [void](New-RevAgentBridgeGuardedDirectory -Path $addinLayout.ManifestDirectory -GuardRoot $revitAddinsGuard)
                [void](Write-RevAgentBridgeOwnedManifest -Path $addinLayout.ManifestPath -AssemblyPath $addinLayout.AssemblyPath -GuardRoot $addinLayout.ManifestDirectory -IcaclsInvoker $IcaclsInvoker)
                return $manifestContract.sha256
            }.GetNewClosure())
    }

    # --- 9. Prepare identity and enrollment before the first service start ---
    if ($deviceCredentialAlreadyExists) {
        [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.EnrollmentArtifactPath; action = 'write_enrollment_artifact'; status = 'skipped_already_enrolled'; detail = $null })
    }
    elseif ([string]::IsNullOrWhiteSpace($EnrollmentToken) -and -not $PromptForEnrollment -and -not $WaitForEnrollmentArtifact) {
        throw "enrollment_token_required: no device credential exists yet and -EnrollmentToken was not supplied."
    }
    else {
        if ($WaitForEnrollmentArtifact -and ($PromptForEnrollment -or -not [string]::IsNullOrWhiteSpace($EnrollmentToken) -or $null -ne $EnrollmentTokenExpiresAtUtc)) {
            throw 'ambiguous_enrollment_source'
        }
        if ($WaitForEnrollmentArtifact -and (Test-Path -LiteralPath $layout.EnrollmentArtifactPath)) {
            throw 'enrollment_handoff_already_present'
        }
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.CredentialDirectory -MutationAction 'prepare_enrollment_identity' -DryRun $isDryRun -Steps $steps -Apply {
                $canonicalLayout = Get-RevAgentBridgeLayout
                if (-not [string]::Equals($layout.StateRoot, $canonicalLayout.StateRoot, [StringComparison]::OrdinalIgnoreCase) -or
                    -not [string]::Equals($layout.InstallRoot, $canonicalLayout.InstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'identity_preparation_requires_canonical_layout'
                }
                $preparedOutput = & $layout.HostExecutablePath 'prepare-enrollment' 2>$null
                if ($LASTEXITCODE -ne 0) { throw 'bridge_identity_preparation_failed' }
                $prepared = ($preparedOutput -join "`n") | ConvertFrom-Json
                if ($prepared.ok -ne $true -or $prepared.action -ne 'prepare_bridge_enrollment' -or $prepared.machineFingerprint -cnotmatch '^sha256:[0-9a-f]{64}$') {
                    throw 'bridge_identity_preparation_invalid'
                }
                $installSummary.machineFingerprint = $prepared.machineFingerprint
                return $prepared.machineFingerprint
            })
        if ($WaitForEnrollmentArtifact) {
            [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.EnrollmentArtifactPath -MutationAction 'await_enrollment_artifact' -DryRun $isDryRun -Steps $steps -Apply {
                    # Public metadata only. The admin mints against this identity
                    # and atomically delivers the protected artifact out-of-band.
                    Write-Host (ConvertTo-Json -Compress -InputObject ([ordered]@{
                        action = 'enrollment_handoff_ready'
                        machineFingerprint = $installSummary.machineFingerprint
                    }))
                    $handoffDeadline = [datetime]::UtcNow.AddSeconds($EnrollmentHandoffTimeoutSeconds)
                    while (-not (Test-Path -LiteralPath $layout.EnrollmentArtifactPath -PathType Leaf)) {
                        if ([datetime]::UtcNow -ge $handoffDeadline) { throw 'enrollment_handoff_timeout' }
                        Start-Sleep -Milliseconds 250
                    }
                    # The real worker validates ACL, no-follow handle, size/TTL,
                    # cleanup and exchange. The installer never reads this token.
                    return 'protected_artifact_handed_off'
                })
        }
        if ($PromptForEnrollment -and [string]::IsNullOrWhiteSpace($EnrollmentToken)) {
            if ($isDryRun) {
                # The minting admin cannot bind a not-yet-created fingerprint.
                # Dry run plans the handoff without prompting or inventing one.
                [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.EnrollmentArtifactPath; action = 'request_bound_enrollment_token'; status = 'skipped_dry_run'; detail = $null })
            }
            else {
                Write-Host "revAgent machine fingerprint: $($installSummary.machineFingerprint)"
                Write-Host 'Mint a single-use enrollment token for this fingerprint, then enter it below.'
                $secureEnrollmentToken = Read-Host 'Enrollment token' -AsSecureString
                try {
                    $EnrollmentToken = [System.Net.NetworkCredential]::new('', $secureEnrollmentToken).Password
                    $EnrollmentTokenExpiresAtUtc = [datetime]::Parse((Read-Host 'Token expiry (UTC ISO 8601)'), [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
                }
                finally { $secureEnrollmentToken.Dispose() }
            }
        }
        if ($WaitForEnrollmentArtifact) {
            $installSummary.enrollmentAttempted = -not $isDryRun
        }
        elseif ($PromptForEnrollment -and $isDryRun -and [string]::IsNullOrWhiteSpace($EnrollmentToken)) {
            [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.EnrollmentArtifactPath; action = 'write_enrollment_artifact'; status = 'skipped_dry_run'; detail = $null })
        }
        else {
        if ($null -eq $EnrollmentTokenExpiresAtUtc) {
            throw "enrollment_token_expiry_required: -EnrollmentTokenExpiresAtUtc must accompany -EnrollmentToken."
        }
        # Fails closed here (before any write) on bad shape/expiry.
        $artifactBytes = New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $EnrollmentToken -ExpiresAtUtc $EnrollmentTokenExpiresAtUtc
        $installSummary.enrollmentAttempted = $true
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.EnrollmentArtifactPath -MutationAction 'write_enrollment_artifact' -DryRun $isDryRun -Steps $steps -Apply {
                [void](Write-RevAgentBridgeCredentialArtifact -Path $layout.EnrollmentArtifactPath -Bytes $artifactBytes -GuardRoot $layout.CredentialDirectory -IcaclsInvoker $IcaclsInvoker)
                return $layout.EnrollmentArtifactPath
            }.GetNewClosure())
        $installSummary.enrollmentArtifactWritten = $true
        }
        $EnrollmentToken = ''
    }

    # --- 10. Register/start the service only after the enrollment artifact is ready ---
    if (-not $serviceAlreadyExists) {
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'register_service' -DryRun $isDryRun -Steps $steps -Apply {
                $output = & $layout.HostExecutablePath 'install' 2>&1
                if ($LASTEXITCODE -ne 0) {
                    throw "bridge_host_install_failed: exit=$LASTEXITCODE output=$output"
                }
                return "$($layout.HostExecutablePath) install"
            })
    }
    else {
        [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.ServiceName; action = 'register_service'; status = 'skipped_already_registered'; detail = $null })
    }

    # --- 11. Start the service so the worker consumes the artifact and connects ---
    if (-not $SkipServiceStart) {
        $needsStart = $true
        try {
            $currentService = Get-Service -Name $layout.ServiceName -ErrorAction SilentlyContinue
            $needsStart = ($null -eq $currentService) -or ($currentService.Status -ne 'Running')
        }
        catch { $needsStart = $true }
        if ($needsStart) {
            [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'start_service' -DryRun $isDryRun -Steps $steps -Apply {
                    Start-Service -Name $layout.ServiceName
                    return 'started'
                })
        }
        else {
            [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.ServiceName; action = 'start_service'; status = 'skipped_already_running'; detail = $null })
        }
    }

    $reportMessage = if ($isDryRun) { 'Dry run completed; zero mutations performed.' } else { 'Install completed.' }
}
catch {
    $reportStatus = 'failed'
    $reportMessage = $_.Exception.Message
    [void]$errors.Add($_.Exception.Message)
}

$completedAtUtc = (Get-Date).ToUniversalTime()
$report = New-RevAgentBridgeMachineReport `
    -Action 'install' `
    -DryRun $isDryRun `
    -StartedAtUtc $startedAtUtc `
    -CompletedAtUtc $completedAtUtc `
    -Status $reportStatus `
    -Message $reportMessage `
    -Steps $steps `
    -Install ([pscustomobject]$installSummary) `
    -Errors $errors.ToArray()

try {
    $reportLayoutArgs = Get-BridgeLayoutArgs
    $layoutForReport = Get-RevAgentBridgeLayout @reportLayoutArgs
    [void](Write-RevAgentBridgeMachineReport -Report $report -ReportsDirectory $layoutForReport.ReportsDirectory -DryRun $isDryRun)
}
catch {
    # Report persistence failure never masks the primary install outcome.
    [void]$errors.Add("report_persistence_failed: $($_.Exception.Message)")
}

if ($MachineReportPath) {
    $reportJson = ($report | ConvertTo-Json -Depth 10)
    $reportDirectory = Split-Path -Parent $MachineReportPath
    if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
        [void](New-Item -ItemType Directory -Path $reportDirectory -Force)
    }
    Set-Content -LiteralPath $MachineReportPath -Value $reportJson -Encoding UTF8
}

Write-Output ([pscustomobject]$report)

if ($reportStatus -ne 'success') {
    throw $reportMessage
}
