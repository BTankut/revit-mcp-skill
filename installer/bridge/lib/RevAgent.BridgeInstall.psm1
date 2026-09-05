<#
.SYNOPSIS
    Shared primitives for the EU-20/M6 workstation Bridge installer and
    cutover uninstaller (P3-T9/P3-T10, docs/implementation-plan/03-bridge-addin-installer.md).

.DESCRIPTION
    This module intentionally does not duplicate:
      - `installer/lib/RevAgent.DistributionIntegrity.psm1` (RS256 detached
        signature verification, frozen and reused read-only).
      - `installer/lib/RevAgent.RevitVersions.psm1` (Resolve-RevitMcpInstallRoot
        Revit-install detection).
      - `installer/lib/RevAgent.CodexRegistration.psm1`
        (Remove-RevitMcpCodexMcpServerConfig for the two managed legacy
        Codex MCP sections).
    It layers new, EU-20-specific logic on top: the P-INST-1 Bridge install/
    state-root layout (mirrors `packages/bridge/src/RevAgent.Bridge.Bootstrap/BridgeInstallLayout.cs`
    field-for-field), the deterministic revAgent.addin manifest for the Bridge
    add-in root (mirrors `installer/install-self-contained.ps1`'s
    `New-RevAgentCanonicalAddinManifestContract`), the M4 enrollment-artifact
    writer (mirrors the exact contract enforced by
    `packages/bridge/src/RevAgent.Bridge/Enrollment/BridgeEnrollmentArtifactConsumer.cs`
    and `WindowsBridgeEnrollmentArtifactSource.cs`), the single guarded
    mutation choke point, and the P-INST-3 uninstall wipe-list/keep-list.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# P-INST-1 layout (mirrors BridgeInstallLayout.cs)
# ---------------------------------------------------------------------------

function Get-RevAgentBridgeLayout {
    [CmdletBinding()]
    param(
        [string]$InstallRoot = (Join-Path $env:ProgramFiles 'revAgent\Bridge'),
        [string]$StateRoot = (Join-Path $env:ProgramData 'revAgent\bridge'),
        [string]$AddinProgramFilesRoot = (Join-Path $env:ProgramFiles 'revAgent\Addin'),
        [string]$RevitAddinsRoot = (Join-Path $env:ProgramData 'Autodesk\Revit\Addins')
    )

    $installRootFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $stateRootFull = [System.IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
    $addinRootFull = [System.IO.Path]::GetFullPath($AddinProgramFilesRoot).TrimEnd('\')
    $revitAddinsRootFull = [System.IO.Path]::GetFullPath($RevitAddinsRoot).TrimEnd('\')
    $credentialDirectory = Join-Path $stateRootFull 'credentials'

    return [pscustomobject][ordered]@{
        InstallRoot            = $installRootFull
        StateRoot               = $stateRootFull
        AddinProgramFilesRoot   = $addinRootFull
        RevitAddinsRoot          = $revitAddinsRootFull
        HostExecutableName      = 'revagent-bridge-host.exe'
        WorkerExecutableName    = 'revagent-bridge.exe'
        ServiceName              = 'revAgentBridge'
        ServiceDisplayName       = 'revAgent Bridge'
        ServiceAccount           = 'LocalSystem'
        HostExecutablePath       = Join-Path $installRootFull 'revagent-bridge-host.exe'
        VersionsRoot             = Join-Path $installRootFull 'versions'
        CurrentWorkerDirectory   = Join-Path (Join-Path $installRootFull 'versions') 'current'
        WorkerExecutablePath     = Join-Path (Join-Path (Join-Path $installRootFull 'versions') 'current') 'revagent-bridge.exe'
        ConfigurationPath        = Join-Path $stateRootFull 'bridge-config.json'
        HostLogDirectory         = Join-Path (Join-Path $stateRootFull 'logs') 'host'
        WorkerLogDirectory       = Join-Path (Join-Path $stateRootFull 'logs') 'worker'
        JournalPath              = Join-Path $stateRootFull 'journal.db'
        CredentialDirectory      = $credentialDirectory
        MachineIdentityPath      = Join-Path $credentialDirectory 'machine-identity.dpapi'
        MachineFingerprintPath   = Join-Path $credentialDirectory 'machine-fingerprint.json'
        DeviceCredentialPath     = Join-Path $credentialDirectory 'device-credential.dpapi'
        AuthDiagnosticPath       = Join-Path $credentialDirectory 'auth-diagnostic.json'
        EnrollmentLockPath       = Join-Path $credentialDirectory 'enrollment.lock'
        BundleExtractionRoot     = Join-Path $stateRootFull 'bundle-extract'
        # New for the installer handoff: the exact file name/location the
        # bridge's WindowsBridgeEnrollmentArtifactSource opens
        # (ExpectedFileName = "enrollment.json").
        EnrollmentArtifactPath   = Join-Path $credentialDirectory 'enrollment.json'
        ReportsDirectory         = Join-Path $stateRootFull 'reports'
    }
}

function Get-RevAgentBridgeAddinLayout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][string]$RevitVersion
    )

    if ($RevitVersion -notmatch '^[0-9]{4}$') {
        throw "RevitVersion must be a bounded 4-digit year: '$RevitVersion'."
    }

    $addinBinRoot = Join-Path $Layout.AddinProgramFilesRoot $RevitVersion
    $manifestDirectory = Join-Path $Layout.RevitAddinsRoot $RevitVersion
    return [pscustomobject][ordered]@{
        RevitVersion       = $RevitVersion
        AddinBinRoot        = $addinBinRoot
        AssemblyPath         = Join-Path $addinBinRoot 'revAgentPlugin\revAgentPlugin.dll'
        ManifestDirectory    = $manifestDirectory
        ManifestPath         = Join-Path $manifestDirectory 'revAgent.addin'
    }
}

# ---------------------------------------------------------------------------
# Link-safe directory creation and atomic write.
#
# installer/lib/RevAgent.Reporting.psm1 has equivalent-shaped helpers
# (Assert-RevAgentExistingPathNoLink, New-RevAgentGuardedDirectory,
# Write-RevAgentGuardedAtomicBytes) but does not export them -- they are
# that module's own private internals, reachable only from code physically
# defined inside it. Calling them unqualified from here throws "term ... is
# not recognized" (caught by a non-dry-run test; see
# scripts/test-eu20-bridge-install.ps1). Rather than depend on another
# module's unexported implementation details, this package owns a small,
# self-contained equivalent: every existing path segment between GuardRoot
# (which must already exist and must not itself be a reparse point) and the
# target is checked for the reparse-point attribute before any directory is
# created or any file is written, and the atomic write always goes through
# a create-new temp file plus File.Replace/Move.
# ---------------------------------------------------------------------------

function Get-RevAgentBridgeNormalizedFullPath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    # [System.IO.Path]::GetFullPath("C:\").TrimEnd('\') collapses a drive
    # root to the 2-character "C:", which Windows treats as "current
    # directory on drive C" -- a different, ambiguous path, NOT the drive
    # root. This preserves the trailing backslash exactly when the path IS
    # a drive root, and strips it everywhere else, mirroring the same
    # drive-root edge case installer/lib/RevAgent.Reporting.psm1's own
    # (unexported) Get-RevAgentNormalizedFullPath guards against.
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\'), $root.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
        return $root
    }
    return $full.TrimEnd('\')
}

function Get-RevAgentBridgePathState {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    # [System.IO.File]::GetAttributes queries the filesystem entry AT this
    # exact path without resolving/following a reparse point to its target
    # (unlike Test-Path, Get-Item, [System.IO.Directory]::Exists, and
    # [System.IO.File]::Exists, which all resolve through a directory
    # junction/symlink to check whether the TARGET exists). A dangling or
    # CI-runner-inaccessible junction target therefore makes those
    # target-resolving checks report "does not exist", silently skipping
    # every reparse-point check that gates on them and falling through to
    # Directory.CreateDirectory -- which then fails (or, worse, succeeds by
    # writing through the link) instead of refusing. GetAttributes succeeds
    # and reports the reparse point's own attributes regardless of whether
    # its target is valid, present, or accessible, so it is the only check
    # used here to decide both existence and reparse-point-ness.
    try {
        $attributes = [System.IO.File]::GetAttributes($Path)
        return [pscustomobject][ordered]@{
            Exists         = $true
            IsReparsePoint = (([int]$attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0)
            IsDirectory    = (([int]$attributes -band [int][System.IO.FileAttributes]::Directory) -ne 0)
        }
    }
    catch [System.IO.DirectoryNotFoundException] {
        return [pscustomobject][ordered]@{ Exists = $false; IsReparsePoint = $false; IsDirectory = $false }
    }
    catch [System.IO.FileNotFoundException] {
        return [pscustomobject][ordered]@{ Exists = $false; IsReparsePoint = $false; IsDirectory = $false }
    }
    catch {
        # GetAttributes failed for any other reason (UnauthorizedAccessException,
        # or a filesystem/driver edge case around a broken link). This is not
        # clean absence, and Directory.Exists/File.Exists cannot be trusted to
        # disambiguate either -- they follow the very reparse point in
        # question. Fail closed: report it as a reparse point so every caller
        # refuses rather than guesses its way through an unreadable segment.
        return [pscustomobject][ordered]@{ Exists = $true; IsReparsePoint = $true; IsDirectory = $false }
    }
}

function Assert-RevAgentBridgeNoReparsePoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $fullRoot = Get-RevAgentBridgeNormalizedFullPath -Path $GuardRoot
    $fullPath = Get-RevAgentBridgeNormalizedFullPath -Path $Path
    $rootState = Get-RevAgentBridgePathState -Path $fullRoot
    if (-not $rootState.Exists -or -not $rootState.IsDirectory) {
        throw "bridge_guard_root_missing: $fullRoot"
    }
    if ($rootState.IsReparsePoint) {
        throw "bridge_guard_root_is_reparse_point: $fullRoot"
    }
    $rootPrefix = if ($fullRoot.EndsWith('\')) { $fullRoot } else { $fullRoot + '\' }
    if (-not [string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "bridge_path_escapes_guard_root: path=$fullPath root=$fullRoot"
    }

    $relative = if ([string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) { '' } else { $fullPath.Substring($fullRoot.Length).TrimStart('\') }
    $cursor = $fullRoot
    foreach ($segment in @($relative -split '\\' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $cursor = Join-Path $cursor $segment
        $segmentState = Get-RevAgentBridgePathState -Path $cursor
        if ($segmentState.IsReparsePoint) {
            throw "bridge_path_contains_reparse_point: $cursor"
        }
        if (-not $segmentState.Exists) {
            # A segment that genuinely does not exist (clean
            # DirectoryNotFoundException/FileNotFoundException, not an
            # unreadable/dangling entry) means nothing deeper can exist
            # either on a normal filesystem.
            break
        }
    }

    return $fullPath
}

function New-RevAgentBridgeGuardedDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $fullPath = Assert-RevAgentBridgeNoReparsePoint -Path $Path -GuardRoot $GuardRoot
    $fullRoot = Get-RevAgentBridgeNormalizedFullPath -Path $GuardRoot
    $relative = if ([string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) { '' } else { $fullPath.Substring($fullRoot.Length).TrimStart('\') }
    $cursor = $fullRoot
    foreach ($segment in @($relative -split '\\' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $cursor = Join-Path $cursor $segment
        # The reparse-point check runs BEFORE CreateDirectory is ever
        # considered for this segment, using the same target-independent
        # attribute probe -- a dangling or unreadable junction refuses here
        # instead of falling through to a native CreateDirectory failure (or
        # a silent write through the link).
        $segmentState = Get-RevAgentBridgePathState -Path $cursor
        if ($segmentState.IsReparsePoint) {
            throw "bridge_path_contains_reparse_point: $cursor"
        }
        if (-not $segmentState.Exists) {
            [void][System.IO.Directory]::CreateDirectory($cursor)
            $segmentState = Get-RevAgentBridgePathState -Path $cursor
            if ($segmentState.IsReparsePoint) {
                throw "bridge_path_contains_reparse_point: $cursor"
            }
        }
        if (-not $segmentState.IsDirectory) {
            throw "bridge_path_not_a_directory: $cursor"
        }
    }

    return $fullPath
}

function Write-RevAgentBridgeGuardedAtomicBytes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][string]$GuardRoot,
        [switch]$CreateOnly
    )

    $fullPath = Assert-RevAgentBridgeNoReparsePoint -Path $Path -GuardRoot $GuardRoot
    $directory = Split-Path -Parent $fullPath
    [void](New-RevAgentBridgeGuardedDirectory -Path $directory -GuardRoot $GuardRoot)
    if (Test-Path -LiteralPath $fullPath) {
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $fullPath -GuardRoot $GuardRoot)
    }

    $leaf = [System.IO.Path]::GetFileName($fullPath)
    $temporaryPath = Join-Path $directory (".{0}.{1}.tmp" -f $leaf, [guid]::NewGuid().ToString('N'))
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $temporaryPath -GuardRoot $GuardRoot)

        if ($CreateOnly) {
            # A config that appeared after planning must never be replaced.
            [System.IO.File]::Move($temporaryPath, $fullPath)
        }
        elseif (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            [void](Assert-RevAgentBridgeNoReparsePoint -Path $fullPath -GuardRoot $GuardRoot)
            # PowerShell binds untyped $null to an empty string for this string
            # parameter. Explicit NullString preserves the no-backup overload.
            [System.IO.File]::Replace($temporaryPath, $fullPath, [NullString]::Value)
        }
        else {
            [System.IO.File]::Move($temporaryPath, $fullPath)
        }
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $fullPath -GuardRoot $GuardRoot)
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            try { [System.IO.File]::Delete($temporaryPath) } catch {}
        }
    }

    return $fullPath
}

function Get-RevAgentBridgeConfigurationPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot,
        [string]$GatewayHostName = '',
        [switch]$AllowUnresolved
    )
    $fullPath = Assert-RevAgentBridgeNoReparsePoint -Path $Path -GuardRoot $GuardRoot
    $gatewayUri = $null
    if (-not [string]::IsNullOrEmpty($GatewayHostName)) {
        # Preserve the installer's existing IP-literal refusal/report contract.
        $hostForIpCheck = $GatewayHostName
        if ($hostForIpCheck.StartsWith('[') -and $hostForIpCheck.EndsWith(']')) {
            $hostForIpCheck = $hostForIpCheck.Substring(1, $hostForIpCheck.Length - 2)
        }
        $zone = $hostForIpCheck.IndexOf('%')
        if ($zone -ge 0) { $hostForIpCheck = $hostForIpCheck.Substring(0, $zone) }
        $parsedIp = $null
        if ([System.Net.IPAddress]::TryParse($hostForIpCheck, [ref]$parsedIp)) {
            throw "gateway_host_must_not_be_ip: $GatewayHostName"
        }
        # DNS authority with optional port; no scheme, IP literal or suffix.
        if ($GatewayHostName.Trim() -cne $GatewayHostName -or
            $GatewayHostName -notmatch '^[^:\s/\\?#@%]+(?::[0-9]{1,5})?$') {
            throw 'gateway_host_invalid: supply a DNS hostname with an optional port'
        }
        [System.Uri]$parsed = $null
        if (-not [System.Uri]::TryCreate("wss://$GatewayHostName/bridge/v1", [System.UriKind]::Absolute, [ref]$parsed) -or
            $parsed.HostNameType -ne [System.UriHostNameType]::Dns -or
            [System.Uri]::CheckHostName($parsed.DnsSafeHost) -ne [System.UriHostNameType]::Dns -or
            $parsed.DnsSafeHost.StartsWith('.') -or $parsed.DnsSafeHost.EndsWith('.') -or
            $parsed.Port -lt 1 -or $parsed.Port -gt 65535 -or $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment -or
            $parsed.AbsolutePath -cne '/bridge/v1') {
            throw 'gateway_host_invalid: an absolute DNS-only WSS endpoint is required'
        }
        $gatewayUri = $parsed.AbsoluteUri
    }
    $state = Get-RevAgentBridgePathState -Path $fullPath
    if ($state.Exists) {
        if ($state.IsDirectory) { throw 'bridge_configuration_path_is_directory' }
        # Preserve bytes; this is not a claim that they passed the strict reader.
        return [pscustomobject]@{ Path = $fullPath; Disposition = 'preserved_existing'; Bytes = $null }
    }
    if ($null -eq $gatewayUri) {
        if (-not $AllowUnresolved) { throw 'gateway_host_required_for_fresh_configuration' }
        return [pscustomobject]@{ Path = $fullPath; Disposition = 'unresolved_endpoint'; Bytes = $null }
    }
    $config = [ordered]@{
        schemaVersion = 1
        gateway = [ordered]@{ uri = $gatewayUri }
        addin = [ordered]@{ scanStartPort = 8080; scanEndPort = 8085 }
        # Existing production stable Host rolling-log policy.
        logging = [ordered]@{ maxFileBytes = 10 * 1024 * 1024; retainedFileCount = 7 }
    }
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    return [pscustomobject]@{ Path = $fullPath; Disposition = 'create'; Bytes = $encoding.GetBytes(($config | ConvertTo-Json -Depth 4)) }
}

function Write-RevAgentBridgeConfigurationPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Plan, [Parameter(Mandatory = $true)][string]$GuardRoot)
    $path = Assert-RevAgentBridgeNoReparsePoint -Path $Plan.Path -GuardRoot $GuardRoot
    $state = Get-RevAgentBridgePathState -Path $path
    if ($state.Exists) {
        if ($state.IsDirectory) { throw 'bridge_configuration_path_is_directory' }
        return 'preserved_existing'
    }
    if ($Plan.Disposition -ne 'create' -or $null -eq $Plan.Bytes) { throw 'bridge_configuration_plan_has_no_fresh_endpoint' }
    try {
        [void](Write-RevAgentBridgeGuardedAtomicBytes -Path $path -Bytes $Plan.Bytes -GuardRoot $GuardRoot -CreateOnly)
        return 'created'
    }
    catch [System.IO.IOException] {
        # A concurrent regular config wins; link/directory failures stay closed.
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $path -GuardRoot $GuardRoot)
        $state = Get-RevAgentBridgePathState -Path $path
        if ($state.Exists -and -not $state.IsDirectory) { return 'preserved_existing' }
        throw
    }
}

# ---------------------------------------------------------------------------
# Deterministic revAgent.addin manifest
#
# Mirrors installer/install-self-contained.ps1's
# New-RevAgentCanonicalAddinManifestContract (lines ~909-954) byte-for-byte:
# same Name/ClientId/VendorId/FullClassName identity, same UTF8-no-BOM +
# `\n` line-ending construction so the manifest hash is deterministic across
# Windows PowerShell 5.1 and PowerShell 7. Only the assembly path changes,
# because P-INST-1 moves the add-in payload under the new disjoint
# `C:\Program Files\revAgent\Addin\<RevitVersion>\` root. This is a
# deliberate parallel implementation (not a dot-source) because
# install-self-contained.ps1 is a top-level entrypoint script, not an
# importable module, and the legacy installer is reuse-by-convention only,
# never a mutation target for this package.
# ---------------------------------------------------------------------------

function New-RevAgentBridgeAddinManifestContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$AssemblyPath
    )

    $canonicalAssemblyPath = [System.IO.Path]::GetFullPath($AssemblyPath)
    $escapedAssembly = [System.Security.SecurityElement]::Escape($canonicalAssemblyPath)
    $content = [string]::Join("`n", @(
            '<?xml version="1.0" encoding="utf-8"?>',
            '<RevitAddIns>',
            '  <AddIn Type="Application">',
            '    <Name>revAgent</Name>',
            "    <Assembly>$escapedAssembly</Assembly>",
            '    <FullClassName>RevAgentPlugin.Core.Application</FullClassName>',
            '    <ClientId>090A4C8C-61DC-426D-87DF-E4BAE0F80EC1</ClientId>',
            '    <VendorId>DPE</VendorId>',
            '    <VendorDescription>DPE internal revAgent add-in</VendorDescription>',
            '  </AddIn>',
            '</RevitAddIns>',
            ''
        ))
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    $bytes = $encoding.GetBytes($content)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $sha256 = ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $algorithm.Dispose()
    }

    return [pscustomobject][ordered]@{
        assemblyPath  = $canonicalAssemblyPath
        clientId       = '090A4C8C-61DC-426D-87DF-E4BAE0F80EC1'
        fullClassName  = 'RevAgentPlugin.Core.Application'
        vendorId       = 'DPE'
        content        = $content
        bytes          = $bytes
        sha256         = $sha256
    }
}

# ---------------------------------------------------------------------------
# Single guarded mutation choke point.
#
# Every machine-mutating action in the installer/uninstaller routes through
# this function -- including, per legacy-tree item, the uninstaller's
# Invoke-RevAgentBridgeTreeWipePlan below, which has no dry-run branch of its
# own precisely so this stays the only gate. When DryRun is $true, Apply is
# never invoked -- only a 'skipped_dry_run' plan entry is recorded. This is
# what makes "-WhatIf/dry-run performs zero mutations" mechanically true
# rather than a documentation promise: a test can pass an Apply scriptblock
# that throws, or that increments a counter, and assert it never ran under
# DryRun.
# ---------------------------------------------------------------------------

function Invoke-RevAgentBridgeGuardedMutation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$MutationAction,
        [Parameter(Mandatory = $true)][scriptblock]$Apply,
        [Parameter(Mandatory = $true)][bool]$DryRun,
        [System.Collections.Generic.List[object]]$Steps
    )

    $entry = [ordered]@{
        target = $Target
        action = $MutationAction
        status = 'planned'
        detail = $null
    }

    if ($DryRun) {
        $entry.status = 'skipped_dry_run'
        $record = [pscustomobject]$entry
        if ($null -ne $Steps) { [void]$Steps.Add($record) }
        return $record
    }

    try {
        $result = & $Apply
        $entry.status = 'applied'
        if ($null -ne $result) { $entry.detail = [string]$result }
        $record = [pscustomobject]$entry
        if ($null -ne $Steps) { [void]$Steps.Add($record) }
        return $record
    }
    catch {
        $entry.status = 'failed'
        $entry.detail = $_.Exception.Message
        $record = [pscustomobject]$entry
        if ($null -ne $Steps) { [void]$Steps.Add($record) }
        throw
    }
}

# ---------------------------------------------------------------------------
# P-ENROLL-1 enrollment-token handling + the M4 enrollment-artifact contract.
#
# Field shape, bounds, and error codes mirror
# packages/bridge/src/RevAgent.Bridge.Bootstrap/Enrollment/BridgeEnrollmentToken.cs
# (32..4096 bounded visible-ASCII opaque token) and
# packages/bridge/src/RevAgent.Bridge/Enrollment/BridgeEnrollmentArtifactConsumer.cs
# (contractVersion "revagent.m4-enrollment-artifact/v1", enrollmentToken,
# expiresAtMs; remaining lifetime must be >= 50s and <= 24h+5s at write time
# so the bridge's own independent re-check at consumption time has margin).
# This function fails closed: any out-of-bounds token or expiry throws
# before a single byte is written to disk.
# ---------------------------------------------------------------------------

function Assert-RevAgentBridgeEnrollmentTokenShape {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$EnrollmentToken)

    if ($EnrollmentToken.Length -lt 32 -or $EnrollmentToken.Length -gt 4096) {
        throw "enrollment_token_invalid_length: the enrollment token must be 32-4096 characters."
    }
    foreach ($character in $EnrollmentToken.ToCharArray()) {
        $code = [int]$character
        if ($code -lt 0x21 -or $code -gt 0x7e) {
            throw "enrollment_token_invalid_characters: the enrollment token must be visible ASCII only."
        }
    }
}

function New-RevAgentBridgeEnrollmentArtifactBytes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$EnrollmentToken,
        [Parameter(Mandatory = $true)][datetime]$ExpiresAtUtc,
        [datetime]$NowUtc = (Get-Date).ToUniversalTime()
    )

    Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken $EnrollmentToken

    $expires = [System.DateTimeOffset]::new($ExpiresAtUtc.ToUniversalTime(), [System.TimeSpan]::Zero)
    $now = [System.DateTimeOffset]::new($NowUtc.ToUniversalTime(), [System.TimeSpan]::Zero)
    $remaining = $expires - $now
    if ($remaining.TotalSeconds -lt 50) {
        throw "enrollment_token_expired_or_too_close: the enrollment token must have at least 50 seconds of remaining lifetime."
    }
    $maximumRemaining = [System.TimeSpan]::FromHours(24) + [System.TimeSpan]::FromSeconds(5)
    if ($remaining -gt $maximumRemaining) {
        throw "enrollment_token_ttl_exceeds_24h: P-ENROLL-1 caps enrollment-token TTL at 24 hours."
    }

    $expiresAtMs = $expires.ToUnixTimeMilliseconds()
    # Deliberately hand-built (not ConvertTo-Json) so the wire bytes are an
    # exact, reviewable match for the bridge's fixed 3-field schema -- no
    # ConvertTo-Json depth/formatting surprises reach a security-critical
    # secret-bearing file.
    $escapedToken = $EnrollmentToken.Replace('\', '\\').Replace('"', '\"')
    $json = '{"contractVersion":"revagent.m4-enrollment-artifact/v1","enrollmentToken":"' + $escapedToken + '","expiresAtMs":' + [string]$expiresAtMs + '}'
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    $bytes = $encoding.GetBytes($json)
    if ($bytes.Length -gt 4096) {
        throw "enrollment_artifact_too_large: the enrollment artifact must stay under the bridge's 4096-byte bound."
    }
    return $bytes
}

# ---------------------------------------------------------------------------
# Credential-directory / enrollment-artifact ACL lockdown.
#
# The bridge worker (packages/bridge/src/RevAgent.Bridge/Enrollment/WindowsBridgeEnrollmentArtifactSource.cs
# HasExactNarrowAccess) refuses to read the artifact unless the containing
# directory and file are access-rules-protected (no inheritance), owned by
# the identity that opens them, and carry exactly two explicit FullControl
# Allow ACEs: NT AUTHORITY\SYSTEM and BUILTIN\Administrators (the bridge
# service runs as LocalSystem per BridgeInstallLayout.ServiceAccount, so the
# reading identity's own SID collapses into that SYSTEM entry). Reassigning
# ownership to SYSTEM from an elevated-but-not-SYSTEM installer process
# requires SeRestorePrivilege; rather than hand-rolling
# AdjustTokenPrivileges in PowerShell (the bridge's own
# WindowsRestorePrivilege.cs already owns that natively), this function
# shells out to the standard, auditable `icacls.exe`, which performs the
# same privilege dance under an elevated Administrator token. If icacls
# fails for any reason, this throws -- the guarded mutation records
# 'failed' and the installer aborts rather than leaving a wrongly-ACL'd
# secret-bearing file on disk. The bridge's own independent ACL check is a
# second, fail-closed line of defense even if this were somehow wrong.
# ---------------------------------------------------------------------------

function Set-RevAgentBridgeSystemOnlyAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$IcaclsInvoker
    )

    # Do not silently remove unrelated explicit permissions, or attempt to
    # repair a deny ACE. Inherited allows are removed only after the intended
    # explicit access is established. The same non-propagating policy applies
    # to both the credential directory and each individually protected file.
    $sidType = [System.Security.Principal.SecurityIdentifier]
    $allowedSids = @('S-1-5-18', 'S-1-5-32-544')
    [void](Assert-RevAgentBridgeNoReparsePoint -Path $Path -GuardRoot (Split-Path -Parent $Path))
    $before = Get-Acl -LiteralPath $Path -ErrorAction Stop
    foreach ($rule in $before.GetAccessRules($true, $true, $sidType)) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            (-not $rule.IsInherited -and $rule.IdentityReference.Value -notin $allowedSids)) {
            throw 'bridge_credential_acl_unexpected_ace'
        }
    }

    if ($null -eq $IcaclsInvoker) {
        $IcaclsInvoker = {
            param([string[]]$Arguments)
            # Windows PowerShell turns native stderr into an ErrorRecord. Keep
            # it nonterminating until we have captured the actual native exit.
            $savedPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $output = & "$env:SystemRoot\System32\icacls.exe" @Arguments 2>&1
                $nativeExit = $LASTEXITCODE
            }
            finally { $ErrorActionPreference = $savedPreference }
            if ($nativeExit -ne 0) {
                throw "bridge_credential_icacls_failed: exit=$nativeExit operation=$($Arguments[1])"
            }
            return $output
        }
    }

    [void](& $IcaclsInvoker @($Path, '/grant:r', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)', '/Q'))
    [void](& $IcaclsInvoker @($Path, '/inheritance:r', '/Q'))
    [void](& $IcaclsInvoker @($Path, '/setowner', '*S-1-5-18', '/Q'))

    Assert-RevAgentBridgeExactCredentialAcl -Security (Get-Acl -LiteralPath $Path -ErrorAction Stop)
}

function Assert-RevAgentBridgeExactCredentialAcl {
    param([Parameter(Mandatory=$true)][System.Security.AccessControl.FileSystemSecurity]$Security,
        [string[]]$AllowedOwnerSids = @('S-1-5-18'))
    $sidType = [System.Security.Principal.SecurityIdentifier]
    $rules = @($Security.GetAccessRules($true, $true, $sidType))
    if (-not $Security.AreAccessRulesProtected -or $Security.GetOwner($sidType).Value -cnotin $AllowedOwnerSids -or $rules.Count -ne 2) {
        throw 'bridge_credential_acl_verification_failed'
    }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $matches = @($rules | Where-Object { $_.IdentityReference.Value -ceq $sid })
        if ($matches.Count -ne 1 -or $matches[0].IsInherited -or
            $matches[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            $matches[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
            $matches[0].InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None -or
            $matches[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
            throw 'bridge_credential_acl_verification_failed'
        }
    }
}

function Write-RevAgentBridgeCredentialArtifact {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][byte[]]$Bytes,
        [Parameter(Mandatory=$true)][string]$GuardRoot,
        [scriptblock]$IcaclsInvoker
    )
    $fullPath = Assert-RevAgentBridgeNoReparsePoint -Path $Path -GuardRoot $GuardRoot
    $directory = Split-Path -Parent $fullPath
    Assert-RevAgentBridgeExactCredentialAcl -Security (Get-Acl -LiteralPath $directory -ErrorAction Stop)
    if (Test-Path -LiteralPath $fullPath) { throw 'bridge_credential_artifact_already_exists' }

    # Passing security to CreateNew avoids the token default DACL, including
    # its logon SID. The empty file is private from its first instant; only
    # SYSTEM/Administrators may read bytes before ownership is finalized.
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $security.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new($sid),
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow))
    }
    $temporaryPath = Join-Path $directory ('.enrollment.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $stream = $null
    $created = $false
    try {
        if ($PSVersionTable.PSEdition -eq 'Desktop') {
            $stream = [System.IO.FileStream]::new($temporaryPath, [System.IO.FileMode]::CreateNew,
                [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::ReadPermissions,
                [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $security)
            $created = $true
            $createdSecurity = $stream.GetAccessControl()
        }
        else {
            $stream = [System.IO.FileSystemAclExtensions]::Create([System.IO.FileInfo]::new($temporaryPath),
                [System.IO.FileMode]::CreateNew,
                [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::ReadPermissions,
                [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $security)
            $created = $true
            $createdSecurity = [System.IO.FileSystemAclExtensions]::GetAccessControl($stream)
        }
        Assert-RevAgentBridgeExactCredentialAcl -Security $createdSecurity -AllowedOwnerSids @('S-1-5-32-544')
        if ($stream.Length -ne 0) { throw 'bridge_credential_creation_not_empty' }
        Write-Verbose 'bridge_credential_private_empty_file_verified'
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose(); $stream = $null
        Set-RevAgentBridgeSystemOnlyAcl -Path $temporaryPath -IcaclsInvoker $IcaclsInvoker
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $fullPath -GuardRoot $GuardRoot)
        # Create-only publication: a concurrent or preexisting artifact wins.
        [System.IO.File]::Move($temporaryPath, $fullPath)
        Assert-RevAgentBridgeExactCredentialAcl -Security (Get-Acl -LiteralPath $fullPath -ErrorAction Stop)
        return $fullPath
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($created -and (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
            [void](Assert-RevAgentBridgeNoReparsePoint -Path $temporaryPath -GuardRoot $GuardRoot)
            [System.IO.File]::Delete($temporaryPath)
        }
    }
}

# ---------------------------------------------------------------------------
# Distribution ACL for the install root and the add-in payload/manifest:
# admin-owned (P-INST-1: "binaries in ... (admin-owned)"), protected, with
# SYSTEM+Administrators FullControl plus read-and-execute for interactive
# users -- unlike the credential ACL above, ordinary users must be able to
# read this, because Revit itself (running as the logged-in designer, never
# as SYSTEM) is the process that loads the add-in DLL and parses the
# manifest.
# ---------------------------------------------------------------------------

function Set-RevAgentBridgeDistributionAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$IcaclsInvoker
    )

    [void](Assert-RevAgentBridgeNoReparsePoint -Path $Path -GuardRoot (Split-Path -Parent $Path))
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    Assert-RevAgentBridgeDistributionSecurity -Security (Get-Acl -LiteralPath $Path) -Directory $item.PSIsContainer -Preflight
    if ($null -eq $IcaclsInvoker) {
        $IcaclsInvoker = {
            param([string[]]$Arguments)
            $saved = $ErrorActionPreference
            try { $ErrorActionPreference = 'Continue'; $output = & "$env:SystemRoot\System32\icacls.exe" @Arguments 2>&1; $exit = $LASTEXITCODE }
            finally { $ErrorActionPreference = $saved }
            if ($exit -ne 0) { throw "bridge_distribution_icacls_failed: exit=$exit operation=$($Arguments[1])" }
            return $output
        }
    }
    $inherit = if ($item.PSIsContainer) { '(OI)(CI)' } else { '' }
    [void](& $IcaclsInvoker @($Path, '/grant:r', "*S-1-5-18:${inherit}F", "*S-1-5-32-544:${inherit}F", "*S-1-5-32-545:${inherit}RX", '/Q'))
    [void](& $IcaclsInvoker @($Path, '/inheritance:r', '/Q'))
    Assert-RevAgentBridgeDistributionSecurity -Security (Get-Acl -LiteralPath $Path) -Directory $item.PSIsContainer
}

function Assert-RevAgentBridgeDistributionSecurity {
    param([Parameter(Mandatory=$true)][Security.AccessControl.FileSystemSecurity]$Security,
        [bool]$Directory, [switch]$Preflight)
    $sidType = [Security.Principal.SecurityIdentifier]
    if ($Security.GetOwner($sidType).Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'bridge_distribution_untrusted_owner' }
    $rules = @($Security.GetAccessRules($true,$true,$sidType))
    $rx = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($rule.AccessControlType -ne 'Allow' -or (-not $rule.IsInherited -and
            ($sid -notin @('S-1-5-18','S-1-5-32-544','S-1-5-32-545') -or
            ($sid -eq 'S-1-5-32-545' -and ($rule.FileSystemRights -band (-bnot $rx)) -ne 0)))) {
            throw 'bridge_distribution_unexpected_ace'
        }
    }
    if ($Preflight) { return }
    $flags = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    if (-not $Security.AreAccessRulesProtected -or $rules.Count -ne 3) { throw 'bridge_distribution_acl_verification_failed' }
    foreach ($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')) {
        $r = @($rules | Where-Object { $_.IdentityReference.Value -ceq $sid })
        $rights = if ($sid -eq 'S-1-5-32-545') { $rx } else { [Security.AccessControl.FileSystemRights]::FullControl }
        if ($r.Count -ne 1 -or $r[0].IsInherited -or $r[0].FileSystemRights -ne $rights -or $r[0].InheritanceFlags -ne $flags -or $r[0].PropagationFlags -ne 'None') { throw 'bridge_distribution_acl_verification_failed' }
    }
}

function Get-RevAgentBridgeManagedManifestAssembly {
    param([Parameter(Mandatory=$true)][string]$Path)
    if ((Get-Item -LiteralPath $Path).Length -gt 65536) { throw 'bridge_manifest_not_owned' }
    $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null; $settings.MaxCharactersInDocument = 65536
    $reader = [Xml.XmlReader]::Create($Path,$settings)
    try { $document = [Xml.XmlDocument]::new(); $document.XmlResolver = $null; $document.Load($reader) }
    catch { throw 'bridge_manifest_not_owned' }
    finally { $reader.Dispose() }
    $nodes = $document.SelectNodes('/RevitAddIns/AddIn')
    if ($nodes.Count -ne 1 -or $nodes[0].GetAttribute('Type') -cne 'Application') { throw 'bridge_manifest_not_owned' }
    $required = @{ Name='revAgent'; FullClassName='RevAgentPlugin.Core.Application'; ClientId='090A4C8C-61DC-426D-87DF-E4BAE0F80EC1'; VendorId='DPE' }
    foreach ($key in $required.Keys) { $n=$nodes[0].SelectNodes($key); if ($n.Count -ne 1 -or $n[0].InnerText -cne $required[$key]) { throw 'bridge_manifest_not_owned' } }
    $assembly = $nodes[0].SelectNodes('Assembly')
    if ($assembly.Count -ne 1 -or -not [IO.Path]::IsPathRooted($assembly[0].InnerText)) { throw 'bridge_manifest_not_owned' }
    return [IO.Path]::GetFullPath($assembly[0].InnerText)
}

function Write-RevAgentBridgeOwnedManifest {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$AssemblyPath,
        [Parameter(Mandatory=$true)][string]$GuardRoot, [scriptblock]$IcaclsInvoker)
    $Bytes = (New-RevAgentBridgeAddinManifestContract -AssemblyPath $AssemblyPath).bytes
    $full = Assert-RevAgentBridgeNoReparsePoint -Path $Path -GuardRoot $GuardRoot
    if ([IO.Path]::GetFileName($full) -cne 'revAgent.addin') { throw 'bridge_manifest_name_invalid' }
    $parent = Split-Path -Parent $full
    $parentAcl = (Get-Acl -LiteralPath $parent).Sddl
    if (Test-Path -LiteralPath $full) {
        Assert-RevAgentBridgeDistributionSecurity -Security (Get-Acl -LiteralPath $full) -Directory $false -Preflight
        [void](Get-RevAgentBridgeManagedManifestAssembly -Path $full)
    }
    $security = [Security.AccessControl.FileSecurity]::new()
    # Use the creator token's normal owner; the elevated installer creates
    # an Administrators-owned file. Final policy verification still requires
    # SYSTEM/Administrators ownership, without an ownership-transfer step.
    $security.SetAccessRuleProtection($true,$false)
    foreach ($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-32-545')) {
        $rights = if ($sid -eq 'S-1-5-32-545') { [Security.AccessControl.FileSystemRights]::ReadAndExecute } else { [Security.AccessControl.FileSystemRights]::FullControl }
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$rights,'Allow'))
    }
    $temporary = Join-Path $parent ('.revAgent.addin.'+[guid]::NewGuid().ToString('N')+'.tmp')
    $stream=$null;$created=$false
    try {
        $rights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::ReadPermissions
        if ($PSVersionTable.PSEdition -eq 'Desktop') { $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,$rights,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$security) }
        else { $stream=[IO.FileSystemAclExtensions]::Create([IO.FileInfo]::new($temporary),[IO.FileMode]::CreateNew,$rights,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$security) }
        $created=$true;$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true);$stream.Dispose();$stream=$null
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $full -GuardRoot $GuardRoot)
        if (Test-Path -LiteralPath $full) {
            Assert-RevAgentBridgeDistributionSecurity -Security (Get-Acl -LiteralPath $full) -Directory $false -Preflight
            [void](Get-RevAgentBridgeManagedManifestAssembly -Path $full)
            [IO.File]::Replace($temporary,$full,[NullString]::Value)
        } else { [IO.File]::Move($temporary,$full) }
        $created=$false
        Set-RevAgentBridgeDistributionAcl -Path $full -IcaclsInvoker $IcaclsInvoker
        if ((Get-Acl -LiteralPath $parent).Sddl -cne $parentAcl) { throw 'bridge_shared_manifest_directory_acl_changed' }
        return $full
    } finally { if ($stream) { $stream.Dispose() }; if ($created -and (Test-Path -LiteralPath $temporary)) { [IO.File]::Delete($temporary) } }
}

# ---------------------------------------------------------------------------
# P-INST-3 rollback anchors (never removed/replaced/rewritten by the
# uninstaller) and the exact uninstall wipe/keep list from the card.
# ---------------------------------------------------------------------------

function Get-RevAgentBridgeRollbackAnchors {
    [CmdletBinding()]
    param([string]$ProgramDataRoot = $env:ProgramData)

    $dpeRevAgentRoot = Join-Path $ProgramDataRoot 'DPE\revAgent'
    return @(
        (Join-Path $dpeRevAgentRoot 'bootstrap'),
        (Join-Path $dpeRevAgentRoot 'prestage\install-revagent-local-bootstrap.ps1'),
        (Join-Path $dpeRevAgentRoot 'updater\config\release-trusted-keys.json')
    )
}

function Get-RevAgentBridgeKeepList {
    [CmdletBinding()]
    param([string]$ProgramDataRoot = $env:ProgramData)

    $anchors = Get-RevAgentBridgeRollbackAnchors -ProgramDataRoot $ProgramDataRoot
    return @($anchors) + @(
        (Join-Path $ProgramDataRoot 'DPE\revAgentOps'),
        (Join-Path $ProgramDataRoot 'DPE\revAgentReleaseSigning'),
        (Join-Path $env:ProgramFiles 'nodejs')
    )
}

function Get-RevAgentBridgeManagedScheduledTaskNames {
    [CmdletBinding()]
    param()

    return @(
        'revAgent Auto Update',
        'Revit MCP Auto Update',
        'revAgent Dashboard Server',
        'revAgent Dashboard Tunnel',
        'revAgent Usage Summary Publish',
        'revAgent Codex Session Context Export'
    )
}

function Get-RevAgentBridgeManagedCodexSectionNames {
    [CmdletBinding()]
    param()

    return @('revAgent', 'revAgent-api-docs')
}

# ---------------------------------------------------------------------------
# Copies every top-level entry of SourceDirectory into DestinationDirectory
# by exact LiteralPath, never via a wildcard. `Copy-Item -LiteralPath (Join-Path
# $dir '*')` does not expand '*' -- LiteralPath is taken verbatim -- so it
# looks for a literal file named '*' and throws on every real run; this is
# the fix. The source directory itself is asserted not to be a reparse
# point before enumeration, so a planted link at the payload source cannot
# smuggle an arbitrary out-of-tree subtree into the copy.
# ---------------------------------------------------------------------------

function Copy-RevAgentBridgeDirectoryContents {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$DestinationDirectory
    )

    $sourceItem = Get-Item -LiteralPath $SourceDirectory -Force -ErrorAction Stop
    if (-not $sourceItem.PSIsContainer) {
        throw "copy_source_not_a_directory: $SourceDirectory"
    }
    if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "copy_source_is_reparse_point: $SourceDirectory"
    }

    foreach ($child in @(Get-ChildItem -LiteralPath $SourceDirectory -Force -ErrorAction Stop)) {
        Copy-Item -LiteralPath $child.FullName -Destination $DestinationDirectory -Recurse -Force
    }
}

function Get-RevAgentBridgeDirectoryTreeSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $null
    }

    $rootFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($file in @(Get-ChildItem -LiteralPath $rootFull -File -Recurse -Force | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($rootFull.Length).TrimStart('\').Replace('\', '/')
        $fileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
        [void]$lines.Add("$relative`t$fileHash")
    }
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    $bytes = $encoding.GetBytes(($lines -join "`n"))
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-RevAgentBridgeAnchorHashes {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string[]]$Anchors)

    $result = [ordered]@{}
    foreach ($anchor in $Anchors) {
        if (Test-Path -LiteralPath $anchor -PathType Leaf) {
            $result[$anchor] = (Get-FileHash -Algorithm SHA256 -LiteralPath $anchor).Hash
        }
        elseif (Test-Path -LiteralPath $anchor -PathType Container) {
            $result[$anchor] = Get-RevAgentBridgeDirectoryTreeSha256 -Path $anchor
        }
        else {
            $result[$anchor] = $null
        }
    }
    return [pscustomobject]$result
}

# ---------------------------------------------------------------------------
# Recursive wipe planning that structurally cannot select a rollback anchor
# (or anything on the path from Root down to one) for removal: the anchors
# are collected as "keep" first, every ancestor directory of a kept path is
# also implicitly kept, and only paths outside both sets are ever planned
# for deletion. This is the exact mechanism (not merely a filter run after
# the fact) that makes "the uninstaller cannot take ownership of, delete,
# replace, or rewrite these protected rollback anchors" true by
# construction rather than by care.
# ---------------------------------------------------------------------------

function Get-RevAgentBridgeTreeWipePlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string[]]$Anchors = @()
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $plan = [System.Collections.Generic.List[object]]::new()
    if (-not (Test-Path -LiteralPath $rootFull)) {
        return @($plan.ToArray())
    }

    $anchorsFull = @($Anchors | ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\') })
    $isKept = {
        param([string]$Path)
        foreach ($anchor in $anchorsFull) {
            if ([string]::Equals($Path, $anchor, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
            if ($anchor.StartsWith($Path + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
            if ($Path.StartsWith($anchor + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
    }

    $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        # The wipe root itself is a reparse point: refuse to walk through it
        # at all rather than trust Get-ChildItem -Recurse's own link handling.
        $plan.Add([pscustomobject][ordered]@{ path = $rootFull; kind = 'directory'; disposition = 'kept_reparse_point' })
        return @($plan.ToArray())
    }

    # Manual iterative walk (never -Recurse): a directory reparse point
    # (junction/symlink) is recorded as kept_reparse_point and its subtree is
    # never enumerated, so a planted link inside the legacy tree cannot pull
    # an out-of-tree path (or an infinite loop) into the removal plan.
    $collected = [System.Collections.Generic.List[object]]::new()
    $stack = [System.Collections.Generic.Stack[string]]::new()
    $stack.Push($rootFull)
    while ($stack.Count -gt 0) {
        $currentDirectory = $stack.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $currentDirectory -Force -ErrorAction SilentlyContinue)) {
            $isReparsePoint = (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
            $kind = if ($child.PSIsContainer) { 'directory' } else { 'file' }
            $disposition =
                if ($isReparsePoint) { 'kept_reparse_point' }
                elseif (& $isKept $child.FullName) { 'kept_anchor' }
                else { 'remove' }
            [void]$collected.Add([pscustomobject][ordered]@{ path = $child.FullName; kind = $kind; disposition = $disposition })
            if ($kind -eq 'directory' -and -not $isReparsePoint) {
                [void]$stack.Push($child.FullName)
            }
        }
    }

    foreach ($item in ($collected | Sort-Object { $_.path.Length } -Descending)) {
        [void]$plan.Add($item)
    }

    if (& $isKept $rootFull) {
        $plan.Add([pscustomobject][ordered]@{ path = $rootFull; kind = 'directory'; disposition = 'kept_anchor_ancestor' })
    }
    else {
        $plan.Add([pscustomobject][ordered]@{ path = $rootFull; kind = 'directory'; disposition = 'remove' })
    }

    return @($plan.ToArray())
}

# ---------------------------------------------------------------------------
# Every per-item removal routes through the single guarded mutation choke
# point (Invoke-RevAgentBridgeGuardedMutation): DryRun gating lives there and
# only there -- this function no longer has its own separate dry-run branch.
# The default RemoveItemAction is the real deletion primitive; tests inject
# a mock to prove it is never invoked under DryRun.
# ---------------------------------------------------------------------------

function Invoke-RevAgentBridgeTreeWipePlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Plan,
        [Parameter(Mandatory = $true)][bool]$DryRun,
        [System.Collections.Generic.List[object]]$Steps,
        [scriptblock]$RemoveItemAction
    )

    if ($null -eq $RemoveItemAction) {
        $RemoveItemAction = {
            param([string]$ItemPath, [string]$ItemKind)
            if (-not (Test-Path -LiteralPath $ItemPath)) {
                return 'removed'
            }
            if ($ItemKind -eq 'directory') {
                # Only ever reached once every kept descendant has already
                # been excluded from the plan above -- remaining children, if
                # any, are themselves 'remove' items processed first because
                # the plan is sorted deepest-path-first.
                $remainingChildren = @(Get-ChildItem -LiteralPath $ItemPath -Force -ErrorAction SilentlyContinue)
                if ($remainingChildren.Count -gt 0) {
                    return 'kept_non_empty'
                }
                Remove-Item -LiteralPath $ItemPath -Force -Recurse:$false -ErrorAction Stop
                return 'removed'
            }
            Remove-Item -LiteralPath $ItemPath -Force -ErrorAction Stop
            return 'removed'
        }
    }

    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $Plan) {
        if ($item.disposition -ne 'remove') {
            [void]$results.Add([pscustomobject][ordered]@{ path = $item.path; kind = $item.kind; disposition = $item.disposition })
            continue
        }

        $itemPath = $item.path
        $itemKind = $item.kind
        $capturedAction = $RemoveItemAction
        try {
            $record = Invoke-RevAgentBridgeGuardedMutation -Target $itemPath -MutationAction 'remove_legacy_item' -DryRun $DryRun -Steps $Steps -Apply {
                & $capturedAction $itemPath $itemKind
            }.GetNewClosure()

            $disposition = switch ($record.status) {
                'skipped_dry_run' { 'would_remove' }
                'applied' { if ($record.detail -eq 'kept_non_empty') { 'kept_non_empty' } else { 'removed' } }
                default { 'failed' }
            }
            [void]$results.Add([pscustomobject][ordered]@{ path = $itemPath; kind = $itemKind; disposition = $disposition })
        }
        catch {
            [void]$results.Add([pscustomobject][ordered]@{ path = $itemPath; kind = $itemKind; disposition = 'failed'; error = $_.Exception.Message })
        }
    }
    return @($results.ToArray())
}

function Get-RevAgentBridgeLegacyRemovalTargets {
    [CmdletBinding()]
    param(
        [string]$ProgramDataRoot = $env:ProgramData,
        [string]$LocalAppDataRoot = $env:LOCALAPPDATA
    )

    return @(
        (Join-Path $ProgramDataRoot 'DPE\revAgent'),
        (Join-Path $ProgramDataRoot 'DPE\RevitMCP'),
        (Join-Path $LocalAppDataRoot 'revit-mcp-plugin')
    )
}

# BridgeOwned is separate from the frozen legacy-cutover wipe list. Its
# complete inventory is checked before removal; unknown files are never
# converted into a recursive directory delete.
function Get-RevAgentBridgeOwnedEntries {
    param([Parameter(Mandatory=$true)][string]$Root)
    $full=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    [void](Assert-RevAgentBridgeNoReparsePoint -Path $full -GuardRoot ([IO.Path]::GetPathRoot($full)))
    if(-not(Test-Path -LiteralPath $full)){return @()}
    $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($full);$rows=[Collections.Generic.List[object]]::new()
    while($stack.Count){
        $path=$stack.Pop();$item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'bridge_owned_reparse_refused'}
        if($rows.Count -ge 10000){throw 'bridge_owned_inventory_limit'}
        $relative=$item.FullName.Substring($full.Length).TrimStart('\')
        $rows.Add([pscustomobject]@{Path=$item.FullName;Relative=$relative;Directory=[bool]$item.PSIsContainer})
        if($item.PSIsContainer){foreach($child in @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)){$stack.Push($child.FullName)}}
    }
    return $rows.ToArray()
}

function Test-RevAgentBridgeOwnedStatePath {
    param([string]$Relative,[bool]$Directory)
    $path=$Relative.Replace('\','/')
    # Exact paths from BridgeInstallLayout; atomic residue suffixes from
    # AtomicCredentialFileWriter. Contents of credentials are never read.
    if($Directory){return $path -eq '' -or $path -in @('credentials','reports','logs','logs/host','logs/worker','bundle-extract') -or $path -match '^bundle-extract/(revagent-bridge|revagent-bridge-host)(/[A-Za-z0-9_+.-]{1,128})?$'}
    if($path -in @('bridge-config.json','journal.db','journal.db-wal','journal.db-shm','journal.db-journal')){return $true}
    if($path -match '^\.bridge-config\.json\.[a-f0-9]{32}\.tmp$' -or $path -match '^credentials/\.enrollment\.[a-f0-9]{32}\.tmp$'){return $true}
    if($path -match '^credentials/(machine-identity\.dpapi|machine-fingerprint\.json|device-credential\.dpapi|auth-diagnostic\.json|enrollment\.lock|enrollment\.json)(\.revagent-write\.(tmp|bak|intent)|\.revagent-restore\.tmp)?$'){return $true}
    if($path -match '^reports/(install|uninstall)-(latest|[0-9]{8}T[0-9]{6}Z)\.json$'){return $true}
    if($path -match '^reports/\.(install|uninstall)-(latest|[0-9]{8}T[0-9]{6}Z)\.json\.[a-f0-9]{32}\.tmp$'){return $true}
    # RollingJsonBridgeLog.BuildPath: prefix, yyyyMMdd, nonnegative sequence.
    if($path -match '^logs/(host/revagent-bridge-host|worker/worker)-([0-9]{8})-([0-9]{4,10})\.jsonl$'){
        $date=[datetime]::MinValue;$sequence=0
        return [datetime]::TryParseExact($Matches[2],'yyyyMMdd',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$date) -and [int]::TryParse($Matches[3],[ref]$sequence) -and $sequence -ge 0
    }
    # The host assigns this dedicated .NET bundle extraction root for the
    # two published executables (HostCommandDispatcher/WorkerSupervisor).
    # Only native library leaves in that runtime-owned shape are admitted.
    return $path -match '^bundle-extract/(revagent-bridge|revagent-bridge-host)/[A-Za-z0-9_+.-]{1,128}/[A-Za-z0-9_.-]+\.dll$'
}

function Get-RevAgentBridgeOwnedCleanupPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][object]$Layout,[Parameter(Mandatory=$true)][string]$RevitVersion,
        [Parameter(Mandatory=$true)][string]$PackageRoot,[Parameter(Mandatory=$true)][string]$TrustedKeysPath,
        [string[]]$Anchors=@())
    Import-Module (Join-Path $PSScriptRoot '..\..\lib\RevAgent.DistributionIntegrity.psm1') -Force
    $addin=Get-RevAgentBridgeAddinLayout -Layout $Layout -RevitVersion $RevitVersion
    $roots=@($Layout.InstallRoot,$Layout.StateRoot,$addin.AddinBinRoot)
    if(@($roots|Sort-Object -Unique).Count -ne 3){throw 'bridge_owned_roots_overlap_protected_surface'}
    foreach($root in $roots){
        if($root.TrimEnd('\') -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')){throw 'bridge_owned_root_is_drive'}
        foreach($other in @($roots|Where-Object{$_ -ine $root})+@($Layout.RevitAddinsRoot)+$Anchors){
            if($root -ieq $other -or $root.StartsWith($other.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $other.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'bridge_owned_roots_overlap_protected_surface'}
        }
    }
    $package=[IO.Path]::GetFullPath($PackageRoot).TrimEnd('\')
    [void](Get-RevAgentBridgeOwnedEntries -Root $package)
    $raw=Get-Content -LiteralPath $TrustedKeysPath -Raw|ConvertFrom-Json;$keys=@{}
    foreach($property in $raw.PSObject.Properties){$key=$property.Value;$keys[$property.Name]=@{publicKeyXml=$key.publicKeyXml;publicKeyFingerprint=$key.publicKeyFingerprint;algorithm=$key.algorithm}}
    $content=$null;$verified=Test-RevitMcpDetachedJsonSignatureFile -ContentPath (Join-Path $package 'bridge-release.json') -SignaturePath (Join-Path $package 'bridge-release.json.sig') -TrustedKeys $keys -AllowedSignedObjects @('release-manifest') -VerifiedContent ([ref]$content)
    if(-not $verified.success){throw 'bridge_owned_package_signature_failed'}
    $componentPaths=@($content.host.relativePath,$content.worker.relativeDirectory,$content.addin.relativeDirectory)
    foreach($relative in $componentPaths){
        if([IO.Path]::IsPathRooted($relative)){throw 'bridge_owned_package_path_invalid'}
        $path=[IO.Path]::GetFullPath((Join-Path $package $relative));if(-not $path.StartsWith($package+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'bridge_owned_package_path_invalid'}
    }
    $hostSource=Join-Path $package $content.host.relativePath;$workerSource=Join-Path $package $content.worker.relativeDirectory;$addinSource=Join-Path $package $content.addin.relativeDirectory
    if((Get-FileHash -LiteralPath $hostSource).Hash -ine $content.host.sha256 -or (Get-RevAgentBridgeDirectoryTreeSha256 -Path $workerSource) -ine $content.worker.sha256 -or (Get-RevAgentBridgeDirectoryTreeSha256 -Path $addinSource) -ine $content.addin.sha256){throw 'bridge_owned_package_tree_failed'}
    $expected=@{};$expected[$Layout.HostExecutablePath]=(Get-FileHash -LiteralPath $hostSource).Hash
    foreach($component in @(@{Source=$workerSource;Destination=$Layout.CurrentWorkerDirectory},@{Source=$addinSource;Destination=$addin.AddinBinRoot})){
        foreach($entry in @(Get-RevAgentBridgeOwnedEntries -Root $component.Source|Where-Object{-not $_.Directory})){$expected[(Join-Path $component.Destination $entry.Relative)]=(Get-FileHash -LiteralPath $entry.Path).Hash}
    }
    $rows=[Collections.Generic.List[object]]::new()
    foreach($root in $roots){foreach($entry in @(Get-RevAgentBridgeOwnedEntries -Root $root)){
        $acl=Get-Acl -LiteralPath $entry.Path -ErrorAction Stop
        Assert-RevAgentBridgeDistributionSecurity -Security $acl -Directory $entry.Directory -Preflight
        $state=$root -ieq $Layout.StateRoot
        if($state -and -not(Test-RevAgentBridgeOwnedStatePath -Relative $entry.Relative -Directory $entry.Directory)){throw 'bridge_owned_unknown_state_path'}
        $hash=$null
        if(-not $entry.Directory -and -not $state){if(-not $expected.ContainsKey($entry.Path)){throw 'bridge_owned_unknown_payload_file'};$hash=(Get-FileHash -LiteralPath $entry.Path).Hash;if($hash -cne $expected[$entry.Path]){throw 'bridge_owned_modified_payload_file'}}
        if($entry.Directory -and -not $state -and $entry.Path -ine $root -and -not @($expected.Keys|Where-Object{$_.StartsWith($entry.Path+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'bridge_owned_unknown_payload_directory'}
        $item=Get-Item -LiteralPath $entry.Path -Force
        $rows.Add([pscustomobject]@{path=$entry.Path;kind=$(if($entry.Directory){'directory'}else{'file'});sha256=$hash;bytes=$(if($entry.Directory){$null}else{$item.Length});lastWriteUtc=$item.LastWriteTimeUtc.ToString('o');sddl=$acl.Sddl;stateContentNotRead=$state;disposition='remove'})
    }}
    $manifestDisposition='absent'
    [void](Assert-RevAgentBridgeNoReparsePoint -Path $addin.ManifestPath -GuardRoot ([IO.Path]::GetPathRoot($addin.ManifestPath)))
    if(Test-Path -LiteralPath $addin.ManifestPath){
        $assembly=Get-RevAgentBridgeManagedManifestAssembly -Path $addin.ManifestPath
        if($assembly -ine $addin.AssemblyPath){$manifestDisposition='preserved_legacy_revagent_manifest'}else{
            Assert-RevAgentBridgeDistributionSecurity -Security (Get-Acl -LiteralPath $addin.ManifestPath) -Directory $false -Preflight
            $contract=New-RevAgentBridgeAddinManifestContract -AssemblyPath $addin.AssemblyPath;$hash=(Get-FileHash -LiteralPath $addin.ManifestPath).Hash
            if($hash -cne $contract.sha256){throw 'bridge_owned_modified_manifest'}
            $item=Get-Item -LiteralPath $addin.ManifestPath
            $rows.Add([pscustomobject]@{path=$addin.ManifestPath;kind='file';sha256=$hash;bytes=$item.Length;lastWriteUtc=$item.LastWriteTimeUtc.ToString('o');sddl=(Get-Acl -LiteralPath $addin.ManifestPath).Sddl;stateContentNotRead=$false;disposition='remove'})
            $manifestDisposition='remove_owned_manifest'
        }
    }
    # Only canonical, app-named empty ancestors may be pruned; never a
    # redirected caller's arbitrary parent or the shared Autodesk directory.
    $prune=@()
    foreach($root in @($Layout.InstallRoot,$Layout.StateRoot)){$parent=Split-Path $root -Parent;if([IO.Path]::GetFileName($parent) -ceq 'revAgent'){$prune+=$parent}}
    if([IO.Path]::GetFileName($Layout.AddinProgramFilesRoot) -ceq 'Addin' -and [IO.Path]::GetFileName((Split-Path $Layout.AddinProgramFilesRoot -Parent)) -ceq 'revAgent'){$prune+=@($Layout.AddinProgramFilesRoot,(Split-Path $Layout.AddinProgramFilesRoot -Parent))}
    $prunePlan=@()
    foreach($path in @($prune|Sort-Object -Unique)){
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $path -GuardRoot ([IO.Path]::GetPathRoot($path)))
        if(Test-Path -LiteralPath $path){$item=Get-Item -LiteralPath $path -Force;$acl=Get-Acl -LiteralPath $path;Assert-RevAgentBridgeDistributionSecurity -Security $acl -Directory $true -Preflight;$prunePlan+=[pscustomobject]@{path=$path;sddl=$acl.Sddl;creationUtc=$item.CreationTimeUtc.ToString('o')}}
    }
    return [pscustomobject]@{roots=$roots;items=$rows.ToArray();manifestDisposition=$manifestDisposition;pruneEmpty=$prunePlan;sharedDirectory=$addin.ManifestDirectory;sharedDirectorySddl=$(if(Test-Path -LiteralPath $addin.ManifestDirectory){(Get-Acl -LiteralPath $addin.ManifestDirectory).Sddl}else{$null})}
}

function Invoke-RevAgentBridgeOwnedCleanupPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][object]$Plan,[Parameter(Mandatory=$true)][bool]$DryRun,
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][Collections.Generic.List[object]]$Steps)
    foreach($item in $Plan.items){
        [void](Assert-RevAgentBridgeNoReparsePoint -Path $item.path -GuardRoot ([IO.Path]::GetPathRoot($item.path)))
        $current=Get-Item -LiteralPath $item.path -Force -ErrorAction Stop
        if((Get-Acl -LiteralPath $item.path).Sddl -cne $item.sddl -or ($item.kind -eq 'file' -and ($current.Length -ne $item.bytes -or $current.LastWriteTimeUtc.ToString('o') -cne $item.lastWriteUtc -or ($item.sha256 -and (Get-FileHash -LiteralPath $item.path).Hash -cne $item.sha256)))){throw 'bridge_owned_plan_changed'}
    }
    $ordered=@($Plan.items|Sort-Object @{Expression={if($_.kind -eq 'file'){0}else{1}}},@{Expression={$_.path.Length};Descending=$true})
    foreach($item in $ordered){
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $item.path -MutationAction 'remove_bridge_owned_item' -DryRun $DryRun -Steps $Steps -Apply {
            [void](Assert-RevAgentBridgeNoReparsePoint -Path $item.path -GuardRoot ([IO.Path]::GetPathRoot($item.path)))
            if((Get-Acl -LiteralPath $item.path).Sddl -cne $item.sddl){throw 'bridge_owned_acl_changed'}
            if($item.kind -eq 'file'){
                $current=Get-Item -LiteralPath $item.path -Force
                if($current.Length -ne $item.bytes -or $current.LastWriteTimeUtc.ToString('o') -cne $item.lastWriteUtc -or ($item.sha256 -and (Get-FileHash -LiteralPath $item.path).Hash -cne $item.sha256)){throw 'bridge_owned_file_changed'}
                [IO.File]::Delete($item.path)
            }else{if(@(Get-ChildItem -LiteralPath $item.path -Force -ErrorAction Stop).Count){throw 'bridge_owned_directory_not_empty'};[IO.Directory]::Delete($item.path,$false)}
            if(Test-Path -LiteralPath $item.path){throw 'bridge_owned_removal_unverified'}
            return 'removed'
        }.GetNewClosure())
    }
    foreach($ancestor in @($Plan.pruneEmpty|Sort-Object @{Expression={$_.path.Length};Descending=$true})){
        $path=$ancestor.path
        if(Test-Path -LiteralPath $path){
            [void](Assert-RevAgentBridgeNoReparsePoint -Path $path -GuardRoot ([IO.Path]::GetPathRoot($path)))
            if((Get-Acl -LiteralPath $path).Sddl -cne $ancestor.sddl -or (Get-Item -LiteralPath $path).CreationTimeUtc.ToString('o') -cne $ancestor.creationUtc){throw 'bridge_owned_ancestor_changed'}
            if(@(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop).Count -eq 0){[void](Invoke-RevAgentBridgeGuardedMutation -Target $path -MutationAction 'remove_empty_bridge_ancestor' -DryRun $DryRun -Steps $Steps -Apply {[IO.Directory]::Delete($path,$false);return 'removed'}.GetNewClosure())}
        }
    }
    if($null -ne $Plan.sharedDirectorySddl -and (Get-Acl -LiteralPath $Plan.sharedDirectory).Sddl -cne $Plan.sharedDirectorySddl){throw 'bridge_owned_shared_directory_changed'}
    if(-not $DryRun){foreach($root in $Plan.roots){if(Test-Path -LiteralPath $root){throw 'bridge_owned_cleanup_incomplete'}}}
}

# ---------------------------------------------------------------------------
# Bounded Codex-config edit: structural removal of the exact two managed
# legacy local MCP sections, nothing else. Delegates the actual TOML-section
# surgery to the already-hardened
# installer/lib/RevAgent.CodexRegistration.psm1::Remove-RevitMcpCodexMcpServerConfig
# (reused, not duplicated) and proves byte-identical preservation of every
# other section by diffing before/after with those two sections stripped
# from BOTH sides using the same helper (so any drift anywhere else in the
# file surfaces as a thrown mismatch instead of a silent partial edit).
# ---------------------------------------------------------------------------

function Remove-RevAgentBridgeManagedCodexSections {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][bool]$DryRun
    )

    $sectionNames = Get-RevAgentBridgeManagedCodexSectionNames
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return [pscustomobject][ordered]@{
            configPath      = $ConfigPath
            existed          = $false
            sectionsRemoved  = @()
            unchangedElsewhere = $true
        }
    }

    $before = Get-Content -Raw -LiteralPath $ConfigPath
    $afterSimulated = $before
    foreach ($name in $sectionNames) {
        $pattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($name))\]\s*.*?(?=^\[|\z)"
        $afterSimulated = [regex]::Replace($afterSimulated, $pattern, '')
    }
    $afterSimulated = [regex]::Replace($afterSimulated, '(\r?\n){3,}', "`r`n`r`n").TrimEnd() + "`r`n"

    $removed = @()
    foreach ($name in $sectionNames) {
        if ($before -match "(?ms)^\[mcp_servers\.$([regex]::Escape($name))\]") {
            $removed += $name
        }
    }

    if ($DryRun) {
        return [pscustomobject][ordered]@{
            configPath          = $ConfigPath
            existed              = $true
            sectionsRemoved      = $removed
            wouldChange          = ($afterSimulated -ne $before)
            unchangedElsewhere   = $true
        }
    }

    foreach ($name in $sectionNames) {
        # Remove-RevitMcpCodexMcpServerConfig -- reused from
        # installer/lib/RevAgent.CodexRegistration.psm1 -- is idempotent and
        # a no-op when the section is already absent.
        [void](Remove-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name $name)
    }
    $after = Get-Content -Raw -LiteralPath $ConfigPath

    # Prove the only structural change is the two managed sections: strip
    # them from a copy of $before using the exact same helper and require
    # byte-for-byte equality with $after.
    $beforeWithSectionsStripped = $before
    $tempConfigPath = [System.IO.Path]::GetTempFileName()
    try {
        Set-Content -LiteralPath $tempConfigPath -Value $beforeWithSectionsStripped -Encoding UTF8 -NoNewline
        foreach ($name in $sectionNames) {
            [void](Remove-RevitMcpCodexMcpServerConfig -ConfigPath $tempConfigPath -Name $name)
        }
        $beforeWithSectionsStripped = Get-Content -Raw -LiteralPath $tempConfigPath
    }
    finally {
        Remove-Item -LiteralPath $tempConfigPath -Force -ErrorAction SilentlyContinue
    }

    $unchangedElsewhere = ($after -eq $beforeWithSectionsStripped)
    if (-not $unchangedElsewhere) {
        throw "codex_config_edit_out_of_bounds: the Codex config changed outside the two managed legacy sections; refusing to report success. path=$ConfigPath"
    }

    return [pscustomobject][ordered]@{
        configPath          = $ConfigPath
        existed              = $true
        sectionsRemoved      = $removed
        unchangedElsewhere   = $unchangedElsewhere
    }
}

# ---------------------------------------------------------------------------
# Machine-report emitter (config/bridge-machine-report.schema.json).
# ---------------------------------------------------------------------------

function New-RevAgentBridgeMachineReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall')][string]$Action,
        [Parameter(Mandatory = $true)][bool]$DryRun,
        [Parameter(Mandatory = $true)][datetime]$StartedAtUtc,
        [Parameter(Mandatory = $true)][datetime]$CompletedAtUtc,
        [Parameter(Mandatory = $true)][ValidateSet('success', 'failed')][string]$Status,
        [string]$Message = '',
        [object[]]$Steps = @(),
        [object]$Install = $null,
        [object]$Uninstall = $null,
        [string[]]$Errors = @()
    )

    return [ordered]@{
        schemaVersion   = 1
        app              = 'revAgent'
        component        = 'bridge'
        action           = $Action
        computerName     = $env:COMPUTERNAME
        userName         = $env:USERNAME
        dryRun           = $DryRun
        status           = $Status
        message          = $Message
        startedAtUtc     = $StartedAtUtc.ToUniversalTime().ToString('o')
        completedAtUtc   = $CompletedAtUtc.ToUniversalTime().ToString('o')
        steps            = @($Steps | ForEach-Object {
                [ordered]@{
                    target = [string]$_.target
                    action = [string]$_.action
                    status = [string]$_.status
                    detail = if ($null -eq $_.detail) { $null } else { [string]$_.detail }
                }
            })
        install          = $Install
        uninstall        = $Uninstall
        errors           = @($Errors)
    }
}

function Write-RevAgentBridgeMachineReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Report,
        [Parameter(Mandatory = $true)][string]$ReportsDirectory,
        [Parameter(Mandatory = $true)][bool]$DryRun
    )

    if ($DryRun) {
        return $null
    }

    # ReportsDirectory (<StateRoot>\reports) does not exist yet on a fresh
    # install, so it cannot guard its own creation -- guard from its parent
    # (StateRoot), which by this point in either script has already been
    # created and link-verified. New-RevAgentBridgeGuardedDirectory
    # re-asserts that parent exists and is not a reparse point before
    # creating anything under it.
    $reportsParent = Split-Path -Parent $ReportsDirectory
    [void](New-RevAgentBridgeGuardedDirectory -Path $ReportsDirectory -GuardRoot $reportsParent)
    $timestamp = ([datetime]::UtcNow).ToString('yyyyMMddTHHmmssZ')
    $fileName = "$($Report.action)-$timestamp.json"
    $path = Join-Path $ReportsDirectory $fileName
    $json = ($Report | ConvertTo-Json -Depth 10)
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    [void](Write-RevAgentBridgeGuardedAtomicBytes -Path $path -Bytes ($encoding.GetBytes($json)) -GuardRoot $ReportsDirectory)

    $latestPath = Join-Path $ReportsDirectory "$($Report.action)-latest.json"
    [void](Write-RevAgentBridgeGuardedAtomicBytes -Path $latestPath -Bytes ($encoding.GetBytes($json)) -GuardRoot $ReportsDirectory)
    return $path
}

Export-ModuleMember -Function `
    Get-RevAgentBridgeLayout, `
    Get-RevAgentBridgeAddinLayout, `
    Get-RevAgentBridgeNormalizedFullPath, `
    Get-RevAgentBridgePathState, `
    Assert-RevAgentBridgeNoReparsePoint, `
    New-RevAgentBridgeGuardedDirectory, `
    Write-RevAgentBridgeGuardedAtomicBytes, `
    Write-RevAgentBridgeCredentialArtifact, `
    Write-RevAgentBridgeOwnedManifest, `
    Get-RevAgentBridgeConfigurationPlan, `
    Write-RevAgentBridgeConfigurationPlan, `
    New-RevAgentBridgeAddinManifestContract, `
    Invoke-RevAgentBridgeGuardedMutation, `
    Assert-RevAgentBridgeEnrollmentTokenShape, `
    New-RevAgentBridgeEnrollmentArtifactBytes, `
    Set-RevAgentBridgeSystemOnlyAcl, `
    Set-RevAgentBridgeDistributionAcl, `
    Get-RevAgentBridgeOwnedEntries, `
    Get-RevAgentBridgeOwnedCleanupPlan, `
    Invoke-RevAgentBridgeOwnedCleanupPlan, `
    Get-RevAgentBridgeRollbackAnchors, `
    Get-RevAgentBridgeKeepList, `
    Get-RevAgentBridgeManagedScheduledTaskNames, `
    Get-RevAgentBridgeManagedCodexSectionNames, `
    Get-RevAgentBridgeLegacyRemovalTargets, `
    Copy-RevAgentBridgeDirectoryContents, `
    Get-RevAgentBridgeDirectoryTreeSha256, `
    Get-RevAgentBridgeAnchorHashes, `
    Get-RevAgentBridgeTreeWipePlan, `
    Invoke-RevAgentBridgeTreeWipePlan, `
    Remove-RevAgentBridgeManagedCodexSections, `
    New-RevAgentBridgeMachineReport, `
    Write-RevAgentBridgeMachineReport
