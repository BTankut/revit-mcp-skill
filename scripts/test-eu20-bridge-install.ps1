<#
.SYNOPSIS
    EU-20/M6 (P3-T9/P3-T10) focused tests for the Bridge installer,
    uninstaller, and shared module.

.DESCRIPTION
    Local, non-admin tests. They never register a real Windows service,
    never run icacls.exe against a real path, and never touch
    C:\Program Files or the real C:\ProgramData -- every filesystem
    exercise happens under a per-run temp scratch directory, and every
    entrypoint-script invocation of Install-RevAgentBridge.ps1 /
    Uninstall-RevAgentBridge.ps1 uses -DryRun (the guarded mutation choke
    point makes that structurally zero-mutation). Get-Service /
    Get-ScheduledTask reads for the fixed 'revAgentBridge' service name and
    the managed task names are safe read-only probes that return "not
    found" on an ordinary dev/CI machine.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$bridgeRoot = Join-Path $RepoRoot "installer\bridge"

Import-Module (Join-Path $bridgeRoot "lib\RevAgent.BridgeInstall.psm1") -Force
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1") -Force
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.Reporting.psm1") -Force
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.RevitVersions.psm1") -Force
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1") -Force

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ("$Actual" -ne "$Expected") { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Get-RevAgentBridgeReportMissingSchemaFields {
    # Lightweight required-field validation (top-level plus the nested
    # install/uninstall objects the top-level loop does not reach) --
    # not a full JSON Schema validator, but enough to prove a report with a
    # missing required field (in particular the evidence-forgeability
    # fields icaclsInvokerInjected/elevated) fails validation rather than
    # silently passing.
    param([Parameter(Mandatory = $true)][object]$Report, [Parameter(Mandatory = $true)][object]$Schema)
    $missing = [System.Collections.Generic.List[string]]::new()
    foreach ($field in $Schema.required) {
        if ($null -eq $Report.PSObject.Properties[$field]) { [void]$missing.Add($field) }
    }
    if ($null -ne $Report.PSObject.Properties["install"] -and $null -ne $Report.install) {
        foreach ($field in $Schema.properties.install.oneOf[1].required) {
            if ($null -eq $Report.install.PSObject.Properties[$field]) { [void]$missing.Add("install.$field") }
        }
    }
    if ($null -ne $Report.PSObject.Properties["uninstall"] -and $null -ne $Report.uninstall) {
        foreach ($field in $Schema.properties.uninstall.oneOf[1].required) {
            if ($null -eq $Report.uninstall.PSObject.Properties[$field]) { [void]$missing.Add("uninstall.$field") }
        }
    }
    return @($missing.ToArray())
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $threw = $false
    try { & $Action }
    catch {
        $threw = $true
        if ($_.Exception.Message -notmatch $Pattern) {
            throw "$Message Unexpected error: $($_.Exception.Message)"
        }
    }
    if (-not $threw) { throw "$Message Expected an exception matching '$Pattern'." }
}

function New-TestScratchDirectory {
    param([string]$Label)
    $path = Join-Path $env:TEMP ("eu20-bridge-{0}-{1}" -f $Label, [guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $path -Force)
    return $path
}

function New-TestRsaProvider {
    $cspParameters = [System.Security.Cryptography.CspParameters]::new(24)
    $cspParameters.Flags = [System.Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
    return [System.Security.Cryptography.RSACryptoServiceProvider]::new($cspParameters)
}

function New-BridgeReleaseFixture {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [switch]$TamperSignature
    )

    $hostDirectory = Join-Path $PackageRoot "host"
    $workerDirectory = Join-Path $PackageRoot "worker"
    # The signed package's addin component is the PARENT of the
    # "revAgentPlugin" folder (not that folder itself): Copy-RevAgentBridgeDirectoryContents
    # copies only the top-level entries of relativeDirectory into AddinBinRoot,
    # and the deterministic manifest's AssemblyPath expects
    # AddinBinRoot\revAgentPlugin\revAgentPlugin.dll -- so the "revAgentPlugin"
    # subfolder itself must be one of those copied top-level entries.
    $addinPackageDirectory = Join-Path $PackageRoot "addin"
    $addinDirectory = Join-Path $addinPackageDirectory "revAgentPlugin"
    [void](New-Item -ItemType Directory -Path $hostDirectory -Force)
    [void](New-Item -ItemType Directory -Path $workerDirectory -Force)
    [void](New-Item -ItemType Directory -Path $addinDirectory -Force)

    $hostExePath = Join-Path $hostDirectory "revagent-bridge-host.exe"
    [System.IO.File]::WriteAllBytes($hostExePath, [byte[]](1, 2, 3, 4, 5))
    [System.IO.File]::WriteAllBytes((Join-Path $workerDirectory "revagent-bridge.exe"), [byte[]](6, 7, 8, 9))
    [System.IO.File]::WriteAllBytes((Join-Path $addinDirectory "revAgentPlugin.dll"), [byte[]](10, 11, 12))

    $content = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        version = "1.0.0-test"
        host = [ordered]@{
            relativePath = "host\revagent-bridge-host.exe"
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $hostExePath).Hash
        }
        worker = [ordered]@{
            relativeDirectory = "worker"
            sha256 = (Get-RevAgentBridgeDirectoryTreeSha256 -Path $workerDirectory)
        }
        addin = [ordered]@{
            relativeDirectory = "addin"
            sha256 = (Get-RevAgentBridgeDirectoryTreeSha256 -Path $addinPackageDirectory)
        }
    }

    $rsa = New-TestRsaProvider
    $publicKeyXml = $rsa.ToXmlString($false)
    $privateKeyXml = $rsa.ToXmlString($true)
    $publicKeyFingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    $envelope = New-RevitMcpDetachedJsonSignature -Content $content -SignedObject "release-manifest" -KeyId "eu20-test-key" -PrivateKeyXml $privateKeyXml -App "revAgent"
    $rsa.Dispose()

    if ($TamperSignature) {
        $signatureBytes = [Convert]::FromBase64String([string]$envelope["signature"])
        $signatureBytes[0] = $signatureBytes[0] -bxor 0xFF
        $envelope["signature"] = [Convert]::ToBase64String($signatureBytes)
    }

    $contentPath = Join-Path $PackageRoot "bridge-release.json"
    $signaturePath = Join-Path $PackageRoot "bridge-release.json.sig"
    Set-Content -LiteralPath $contentPath -Value ($content | ConvertTo-Json -Depth 10) -Encoding UTF8
    Set-Content -LiteralPath $signaturePath -Value ($envelope | ConvertTo-Json -Depth 10) -Encoding UTF8

    $trustedKeysPath = Join-Path $PackageRoot "trusted-keys.json"
    $trustedKeys = [ordered]@{
        "eu20-test-key" = [ordered]@{
            publicKeyXml = $publicKeyXml
            publicKeyFingerprint = $publicKeyFingerprint
            algorithm = "RS256"
        }
    }
    Set-Content -LiteralPath $trustedKeysPath -Value ($trustedKeys | ConvertTo-Json -Depth 10) -Encoding UTF8

    return [pscustomobject][ordered]@{
        PackageRoot = $PackageRoot
        TrustedKeysPath = $trustedKeysPath
    }
}

function Get-BridgeTempLayoutArgs {
    param([string]$Root)
    return @{
        InstallRoot = Join-Path $Root "ProgramFiles\revAgent\Bridge"
        StateRoot = Join-Path $Root "ProgramData\revAgent\bridge"
        AddinProgramFilesRoot = Join-Path $Root "ProgramFiles\revAgent\Addin"
        RevitAddinsRoot = Join-Path $Root "ProgramData\Autodesk\Revit\Addins"
    }
}

# A trivial injected ACL invoker for tests that need a real (non-dry-run)
# install to reach past the elevation gate but do not care about ACL calls
# themselves (e.g. the link-guard tests below, which always throw before
# Set-RevAgentBridgeDistributionAcl/SystemOnlyAcl is ever reached). Passing
# any non-null -IcaclsInvoker is what bypasses the gate; this one is never
# actually expected to be invoked by those tests.
$noOpIcaclsInvoker = {
    param([string[]]$Arguments)
    return "unused"
}

$scratchRoots = [System.Collections.Generic.List[string]]::new()
try {

    # =====================================================================
    Write-Host "Test P-INST-1 layout matches BridgeInstallLayout.cs field-for-field"
    # =====================================================================
    $layoutRoot = New-TestScratchDirectory -Label "layout"
    $scratchRoots.Add($layoutRoot)
    $layoutArgs = Get-BridgeTempLayoutArgs -Root $layoutRoot
    $layout = Get-RevAgentBridgeLayout @layoutArgs
    Assert-Equal $layout.ServiceName "revAgentBridge" "Service name must match the frozen BridgeInstallLayout constant."
    Assert-Equal $layout.ServiceAccount "LocalSystem" "Service account must match the frozen BridgeInstallLayout constant."
    Assert-Equal $layout.HostExecutablePath (Join-Path $layout.InstallRoot "revagent-bridge-host.exe") "Host executable path derivation must match BridgeInstallLayout.cs."
    Assert-Equal $layout.CurrentWorkerDirectory (Join-Path $layout.InstallRoot "versions\current") "Current worker directory derivation must match BridgeInstallLayout.cs."
    Assert-Equal $layout.CredentialDirectory (Join-Path $layout.StateRoot "credentials") "Credential directory derivation must match BridgeInstallLayout.cs."
    Assert-Equal $layout.EnrollmentArtifactPath (Join-Path $layout.CredentialDirectory "enrollment.json") "Enrollment artifact must be named exactly 'enrollment.json' (WindowsBridgeEnrollmentArtifactSource.ExpectedFileName)."
    $addinLayout = Get-RevAgentBridgeAddinLayout -Layout $layout -RevitVersion "2022"
    Assert-Equal $addinLayout.ManifestPath (Join-Path $layout.RevitAddinsRoot "2022\revAgent.addin") "Add-in manifest path must land under the P-INST-1 ProgramData Revit Addins root."
    Assert-ThrowsLike { Get-RevAgentBridgeAddinLayout -Layout $layout -RevitVersion "abcd" } "RevitVersion must be a bounded 4-digit year" "Non-numeric Revit version must be refused."

    # =====================================================================
    Write-Host "Test deterministic revAgent.addin manifest identity and hash stability"
    # =====================================================================
    $manifestA = New-RevAgentBridgeAddinManifestContract -AssemblyPath "C:\Program Files\revAgent\Addin\2022\revAgentPlugin\revAgentPlugin.dll"
    $manifestB = New-RevAgentBridgeAddinManifestContract -AssemblyPath "C:\Program Files\revAgent\Addin\2022\revAgentPlugin\revAgentPlugin.dll"
    Assert-Equal $manifestA.sha256 $manifestB.sha256 "Manifest generation must be byte-deterministic for the same assembly path."
    Assert-Equal $manifestA.clientId "090A4C8C-61DC-426D-87DF-E4BAE0F80EC1" "Manifest ClientId must match the frozen add-in identity (installer/install-self-contained.ps1)."
    Assert-Equal $manifestA.vendorId "DPE" "Manifest VendorId must match the frozen add-in identity."
    Assert-True ($manifestA.content -match '<Name>revAgent</Name>') "Manifest must declare the exact add-in Name identity."
    $manifestDifferentPath = New-RevAgentBridgeAddinManifestContract -AssemblyPath "C:\Program Files\revAgent\Addin\2023\revAgentPlugin\revAgentPlugin.dll"
    Assert-True ($manifestA.sha256 -ne $manifestDifferentPath.sha256) "A different assembly path must change the manifest hash."

    # =====================================================================
    Write-Host "Test the single guarded mutation choke point: dry-run never invokes Apply"
    # =====================================================================
    $script:guardedCallCount = 0
    $steps = [System.Collections.Generic.List[object]]::new()
    [void](Invoke-RevAgentBridgeGuardedMutation -Target "t" -MutationAction "a" -DryRun $true -Steps $steps -Apply { $script:guardedCallCount++; return "ran" })
    Assert-Equal $script:guardedCallCount 0 "DryRun must never invoke the guarded Apply scriptblock."
    Assert-Equal $steps[0].status "skipped_dry_run" "DryRun guarded mutation must record 'skipped_dry_run'."

    [void](Invoke-RevAgentBridgeGuardedMutation -Target "t" -MutationAction "a" -DryRun $false -Steps $steps -Apply { $script:guardedCallCount++; return "ran" })
    Assert-Equal $script:guardedCallCount 1 "Non-DryRun guarded mutation must invoke Apply exactly once."
    Assert-Equal $steps[1].status "applied" "Non-DryRun guarded mutation must record 'applied' on success."

    $failureThrew = $false
    try {
        [void](Invoke-RevAgentBridgeGuardedMutation -Target "t" -MutationAction "a" -DryRun $false -Steps $steps -Apply { throw "boom" })
    }
    catch { $failureThrew = $true }
    Assert-True $failureThrew "A failing Apply must propagate (fail closed), not be swallowed."
    Assert-Equal $steps[2].status "failed" "A failing guarded mutation must record 'failed' before rethrowing."

    # =====================================================================
    Write-Host "Test P-ENROLL-1 enrollment-token shape validation fails closed"
    # =====================================================================
    Assert-ThrowsLike { Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken ("a" * 10) } "enrollment_token_invalid_length" "A too-short token must be refused."
    Assert-ThrowsLike { Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken ("a" * 5000) } "enrollment_token_invalid_length" "A too-long token must be refused."
    Assert-ThrowsLike { Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken (("a" * 31) + "`t") } "enrollment_token_invalid_characters" "A control character in the token must be refused."
    [void](Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken ("a" * 40))

    # =====================================================================
    Write-Host "Test the M4 enrollment-artifact TTL bound fails closed on bad/expired expiry"
    # =====================================================================
    $validToken = "T" + ("k" * 39)
    $nowUtc = [datetime]::UtcNow
    Assert-ThrowsLike {
        New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $validToken -ExpiresAtUtc $nowUtc.AddSeconds(10) -NowUtc $nowUtc
    } "enrollment_token_expired_or_too_close" "A token expiring in 10 seconds must be refused (below the 50s floor)."
    Assert-ThrowsLike {
        New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $validToken -ExpiresAtUtc $nowUtc.AddHours(-1) -NowUtc $nowUtc
    } "enrollment_token_expired_or_too_close" "An already-expired token must be refused."
    Assert-ThrowsLike {
        New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $validToken -ExpiresAtUtc $nowUtc.AddHours(25) -NowUtc $nowUtc
    } "enrollment_token_ttl_exceeds_24h" "A TTL over 24h must be refused (P-ENROLL-1 cap)."
    $goodBytes = New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $validToken -ExpiresAtUtc $nowUtc.AddHours(12) -NowUtc $nowUtc
    Assert-True ($goodBytes.Length -le 4096) "The enrollment artifact must stay within the bridge's 4096-byte bound."
    $goodJson = [System.Text.Encoding]::UTF8.GetString($goodBytes) | ConvertFrom-Json
    Assert-Equal $goodJson.contractVersion "revagent.m4-enrollment-artifact/v1" "Artifact contractVersion must match BridgeEnrollmentArtifactConsumer.ArtifactContractVersion exactly."
    Assert-Equal $goodJson.enrollmentToken $validToken "Artifact must carry the exact supplied token."
    Assert-True ($goodJson.expiresAtMs -gt 0) "Artifact expiresAtMs must be a positive integer."

    # =====================================================================
    Write-Host "Test exact credential directory and file policies remain distinct"
    & (Get-Module RevAgent.BridgeInstall) {
        $make = {
            param([bool]$Directory, [Security.AccessControl.InheritanceFlags]$Inheritance)
            $security = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
            $security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
            $security.SetAccessRuleProtection($true, $false)
            foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
                $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', $Inheritance, 'None', 'Allow'))
            }
            return $security
        }
        $directory = & $make $true ([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit')
        $file = & $make $false ([Security.AccessControl.InheritanceFlags]::None)
        Assert-RevAgentBridgeExactCredentialAcl -Security $directory -Kind Directory
        Assert-RevAgentBridgeExactCredentialAcl -Security $file -Kind File
        $cases = @(
            @{ security = (& $make $true ([Security.AccessControl.InheritanceFlags]::None)); kind = 'Directory' },
            @{ security = (& $make $true ([Security.AccessControl.InheritanceFlags]::ContainerInherit)); kind = 'Directory' },
            @{ security = (& $make $true ([Security.AccessControl.InheritanceFlags]::ObjectInherit)); kind = 'Directory' },
            @{ security = $directory; kind = 'File' },
            @{ security = $file; kind = 'Directory' }
        )
        foreach ($case in $cases) {
            $refused = $false
            try { Assert-RevAgentBridgeExactCredentialAcl -Security $case.security -Kind $case.kind }
            catch { $refused = $_.Exception.Message -ceq 'bridge_credential_acl_verification_failed' }
            if (-not $refused) { throw 'credential_file_directory_policy_interchanged' }
        }
    }

    # =====================================================================
    Write-Host "Test ACL helpers invoke icacls only through the injectable invoker (no real icacls.exe call)"
    # =====================================================================
    $icaclsCalls = [System.Collections.Generic.List[string]]::new()
    $mockInvoker = {
        param([string[]]$Arguments)
        $icaclsCalls.Add(($Arguments -join " "))
        return "mocked"
    }.GetNewClosure()
    $aclRoot = New-TestScratchDirectory -Label 'acl-order'
    $scratchRoots.Add($aclRoot)
    $aclChild = Join-Path $aclRoot 'inherited'
    [void][IO.Directory]::CreateDirectory($aclChild)
    $aclBefore = (Get-Acl -LiteralPath $aclChild).Sddl
    $verificationRefused = $false
    try { Set-RevAgentBridgeSystemOnlyAcl -Path $aclChild -IcaclsInvoker $mockInvoker }
    catch { $verificationRefused = $_.Exception.Message -ceq 'bridge_credential_acl_verification_failed' }
    Assert-True $verificationRefused 'A no-op native invoker must not satisfy the real ACL postcondition.'
    Assert-Equal $icaclsCalls.Count 3 'Narrow ACL order must be grant, inheritance removal, owner transfer.'
    Assert-True ($icaclsCalls[0] -match '/grant:r') 'Establish explicit access before removing inherited access.'
    Assert-True ($icaclsCalls[1] -match '/inheritance:r') 'Remove inheritance only after granting access.'
    Assert-True ($icaclsCalls[2] -match '/setowner \*S-1-5-18') 'Transfer ownership last using a numeric SID.'
    Assert-True (($icaclsCalls -join '|') -match '\*S-1-5-18:\(OI\)\(CI\)\(F\)') 'Grant SYSTEM inheritable directory FullControl by SID.'
    Assert-True (($icaclsCalls -join '|') -match '\*S-1-5-32-544:\(OI\)\(CI\)\(F\)') 'Grant Administrators inheritable directory FullControl by SID.'
    Assert-True (($icaclsCalls -join '|') -notmatch '\*S-1-5-32-545:') 'Narrow credential ACL must not grant interactive Users any access.'
    Assert-Equal (Get-Acl -LiteralPath $aclChild).Sddl $aclBefore 'No-op invoker must leave real ACL unchanged.'
    $failurePropagated = $false
    try { Set-RevAgentBridgeSystemOnlyAcl -Path $aclChild -IcaclsInvoker { throw 'injected_native_failure' } }
    catch { $failurePropagated = $_.Exception.Message -ceq 'injected_native_failure' }
    Assert-True $failurePropagated 'Native invocation failure must propagate without a later success.'
    $foreignAcl = Get-Acl -LiteralPath $aclChild
    $foreignAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
    Set-Acl -LiteralPath $aclChild -AclObject $foreignAcl
    $foreignBefore = (Get-Acl -LiteralPath $aclChild).Sddl
    $icaclsCalls.Clear();$foreignRefused=$false
    try { Set-RevAgentBridgeSystemOnlyAcl -Path $aclChild -IcaclsInvoker $mockInvoker }
    catch { $foreignRefused = $_.Exception.Message -ceq 'bridge_credential_acl_unexpected_ace' }
    Assert-True $foreignRefused 'An explicit foreign ACE must refuse before any native mutation.'
    Assert-Equal $icaclsCalls.Count 0 'Foreign ACE refusal must issue no icacls calls.'
    Assert-Equal (Get-Acl -LiteralPath $aclChild).Sddl $foreignBefore 'Foreign permissions must remain unchanged on refusal.'
    $artifactTarget = Join-Path $aclChild 'public-artifact.json'
    $unsafeParentRefused = $false
    try { Write-RevAgentBridgeCredentialArtifact -Path $artifactTarget -Bytes ([byte[]]@(1,2,3)) -GuardRoot $aclChild }
    catch { $unsafeParentRefused = $_.Exception.Message -ceq 'bridge_credential_acl_verification_failed' }
    Assert-True $unsafeParentRefused 'Credential writer must reject an unsafe parent before creating any file.'
    Assert-Equal @(Get-ChildItem -LiteralPath $aclChild -Force).Count 0 'Parent refusal must create no artifact or temporary file.'

    $icaclsCalls.Clear()
    $priorReader = & (Get-Module RevAgent.BridgeInstall) { Get-Item Function:Get-Acl -ErrorAction SilentlyContinue }
    $priorReaderBody = if ($priorReader) { $priorReader.ScriptBlock } else { $null }
    $distributionReader = {
        param([string]$LiteralPath,$ErrorAction)
        if($LiteralPath -ceq $aclChild){$s=[Security.AccessControl.DirectorySecurity]::new();$s.SetSecurityDescriptorSddlForm('O:BAG:BAD:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)');return $s}
        if($priorReaderBody){return & $priorReaderBody @PSBoundParameters}
        Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
    }.GetNewClosure()
    Set-Item Function:global:Get-Acl -Value $distributionReader
    try { Assert-ThrowsLike { Set-RevAgentBridgeDistributionAcl -Path $aclChild -IcaclsInvoker $mockInvoker } 'bridge_distribution_acl_verification_failed' 'No-op distribution invoker must fail final verification.' }
    finally { if($priorReaderBody){Set-Item Function:global:Get-Acl -Value $priorReaderBody}else{& (Get-Module RevAgent.BridgeInstall) { Remove-Item Function:Get-Acl }} }
    Assert-Equal $icaclsCalls.Count 2 'Distribution ACL must grant before removing inheritance.'
    Assert-True ($icaclsCalls[0] -match '/grant:r' -and $icaclsCalls[1] -match '/inheritance:r') 'Distribution calls must never transiently remove the only admin access.'
    Assert-True (($icaclsCalls -join '|') -match '\*S-1-5-32-545:\(OI\)\(CI\)RX') 'Distribution users RX must use a locale-independent SID.'

    # =====================================================================
    Write-Host "Test end-to-end install -DryRun: signature failure fails closed with zero mutation steps"
    # =====================================================================
    $tamperedRoot = New-TestScratchDirectory -Label "tampered-package"
    $scratchRoots.Add($tamperedRoot)
    $tamperedFixture = New-BridgeReleaseFixture -PackageRoot $tamperedRoot -TamperSignature
    $tamperedTemp = New-TestScratchDirectory -Label "tampered-target"
    $scratchRoots.Add($tamperedTemp)
    $tamperedLayoutArgs = Get-BridgeTempLayoutArgs -Root $tamperedTemp
    $tamperedReportPath = Join-Path $tamperedTemp "report.json"
    $tamperedThrew = $false
    try {
        & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
            -PackageRoot $tamperedFixture.PackageRoot `
            -TrustedKeysPath $tamperedFixture.TrustedKeysPath `
            -EnrollmentToken ("a" * 40) `
            -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
            -InstallRoot $tamperedLayoutArgs.InstallRoot `
            -StateRoot $tamperedLayoutArgs.StateRoot `
            -AddinProgramFilesRoot $tamperedLayoutArgs.AddinProgramFilesRoot `
            -RevitAddinsRoot $tamperedLayoutArgs.RevitAddinsRoot `
            -MachineReportPath $tamperedReportPath `
            -SkipRevitDetection `
            -DryRun | Out-Null
    }
    catch { $tamperedThrew = $true }
    Assert-True $tamperedThrew "A tampered signature must fail the install closed."
    Assert-True (Test-Path -LiteralPath $tamperedReportPath -PathType Leaf) "A failed install must still emit a machine report."
    $tamperedReport = Get-Content -Raw -LiteralPath $tamperedReportPath | ConvertFrom-Json
    Assert-Equal $tamperedReport.status "failed" "Report status must be 'failed' for a tampered signature."
    $tamperedStepActions = @($tamperedReport.steps | ForEach-Object { $_.action })
    Assert-True ($tamperedStepActions -notcontains "create_install_root") "No mutation step may be attempted after signature verification fails."
    Assert-True (-not (Test-Path -LiteralPath $tamperedLayoutArgs.InstallRoot)) "A failed signature check must leave the install root entirely uncreated."

    # =====================================================================
    Write-Host "Test end-to-end install -DryRun: bad enrollment token fails closed independent of dry-run"
    # =====================================================================
    $goodRoot = New-TestScratchDirectory -Label "good-package"
    $scratchRoots.Add($goodRoot)
    $goodFixture = New-BridgeReleaseFixture -PackageRoot $goodRoot
    $badTokenTemp = New-TestScratchDirectory -Label "badtoken-target"
    $scratchRoots.Add($badTokenTemp)
    $badTokenLayoutArgs = Get-BridgeTempLayoutArgs -Root $badTokenTemp
    $badTokenReportPath = Join-Path $badTokenTemp "report.json"
    $badTokenThrew = $false
    try {
        & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
            -PackageRoot $goodFixture.PackageRoot `
            -TrustedKeysPath $goodFixture.TrustedKeysPath `
            -EnrollmentToken "too-short" `
            -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
            -InstallRoot $badTokenLayoutArgs.InstallRoot `
            -StateRoot $badTokenLayoutArgs.StateRoot `
            -AddinProgramFilesRoot $badTokenLayoutArgs.AddinProgramFilesRoot `
            -RevitAddinsRoot $badTokenLayoutArgs.RevitAddinsRoot `
            -MachineReportPath $badTokenReportPath `
            -SkipRevitDetection `
            -DryRun | Out-Null
    }
    catch { $badTokenThrew = $true }
    Assert-True $badTokenThrew "A malformed enrollment token must fail the install closed."
    $badTokenReport = Get-Content -Raw -LiteralPath $badTokenReportPath | ConvertFrom-Json
    Assert-Equal $badTokenReport.status "failed" "Report status must be 'failed' for a malformed enrollment token."
    Assert-True ($badTokenReport.message -match "enrollment_token_invalid_length") "Failure message must surface the exact fail-closed reason."

    # =====================================================================
    Write-Host "Test installer refuses to write through a pre-planted junction at InstallRoot (fails closed before any write) -- both a live and a dangling target"
    # =====================================================================
    # Verify junction creation actually works on this runner FIRST. If it
    # doesn't, the two scenarios below would silently no-op past their
    # New-Item calls and every assertion after them would pass for the
    # wrong reason (no junction ever existed). Fail loudly and explicitly
    # instead of silently passing.
    $junctionCapabilityRoot = New-TestScratchDirectory -Label "junction-capability"
    $scratchRoots.Add($junctionCapabilityRoot)
    $junctionCapabilityTarget = Join-Path $junctionCapabilityRoot "target"
    [void](New-Item -ItemType Directory -Path $junctionCapabilityTarget -Force)
    $junctionCapabilityLink = Join-Path $junctionCapabilityRoot "link"
    [void](New-Item -ItemType Junction -Path $junctionCapabilityLink -Target $junctionCapabilityTarget)
    $junctionCapabilityItem = Get-Item -LiteralPath $junctionCapabilityLink -Force -ErrorAction SilentlyContinue
    $junctionsSupported = ($null -ne $junctionCapabilityItem) -and (($junctionCapabilityItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    Assert-True $junctionsSupported "This runner must support directory junction creation (New-Item -ItemType Junction) for the link-guard tests below to mean anything; refusing to silently skip them."

    foreach ($junctionScenario in @(
            @{ Label = "live-target"; CreateTarget = $true },
            @{ Label = "dangling-target"; CreateTarget = $false }
        )) {
        $junctionInstallTemp = New-TestScratchDirectory -Label "junction-install-$($junctionScenario.Label)"
        $scratchRoots.Add($junctionInstallTemp)
        $junctionInstallLayoutArgs = Get-BridgeTempLayoutArgs -Root $junctionInstallTemp
        $installRootParent = Split-Path -Parent $junctionInstallLayoutArgs.InstallRoot
        [void](New-Item -ItemType Directory -Path $installRootParent -Force)
        $outsideLayoutTarget = Join-Path $junctionInstallTemp "outside-layout-root"
        # New-Item -ItemType Junction requires the target to exist at
        # creation time -- to get a genuinely DANGLING junction, create the
        # target, link to it, then remove the target afterward, leaving the
        # junction node behind pointing at nothing.
        [void](New-Item -ItemType Directory -Path $outsideLayoutTarget -Force)
        [void](New-Item -ItemType Junction -Path $junctionInstallLayoutArgs.InstallRoot -Target $outsideLayoutTarget)
        if (-not $junctionScenario.CreateTarget) {
            Remove-Item -LiteralPath $outsideLayoutTarget -Force -Recurse
            Assert-True (-not (Test-Path -LiteralPath $outsideLayoutTarget)) "Fixture precondition ($($junctionScenario.Label)): the junction target must be gone (dangling) before the install is attempted."
        }
        # Use the same target-independent attribute probe the production
        # code now uses (Get-Item/Test-Path follow a reparse point to its
        # target and can misreport a dangling link as absent).
        $plantedJunctionState = Get-RevAgentBridgePathState -Path $junctionInstallLayoutArgs.InstallRoot
        Assert-True $plantedJunctionState.IsReparsePoint "Fixture precondition ($($junctionScenario.Label)): InstallRoot must actually be a reparse point before the install is attempted."

        $junctionInstallReportPath = Join-Path $junctionInstallTemp "report.json"
        $junctionInstallThrew = $false
        try {
            & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
                -PackageRoot $goodFixture.PackageRoot `
                -TrustedKeysPath $goodFixture.TrustedKeysPath `
                -EnrollmentToken ("a" * 40) `
                -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
                -InstallRoot $junctionInstallLayoutArgs.InstallRoot `
                -StateRoot $junctionInstallLayoutArgs.StateRoot `
                -AddinProgramFilesRoot $junctionInstallLayoutArgs.AddinProgramFilesRoot `
                -RevitAddinsRoot $junctionInstallLayoutArgs.RevitAddinsRoot `
                -GatewayHostName 'gateway.dpe.internal' `
                -MachineReportPath $junctionInstallReportPath `
                -SkipRevitDetection `
                -SkipServiceStart `
                -IcaclsInvoker $noOpIcaclsInvoker | Out-Null
        }
        catch { $junctionInstallThrew = $true }
        Assert-True $junctionInstallThrew "($($junctionScenario.Label)) A pre-planted junction at InstallRoot must make a real (non-dry-run) install fail closed."
        $junctionInstallReport = Get-Content -Raw -LiteralPath $junctionInstallReportPath | ConvertFrom-Json
        Assert-Equal $junctionInstallReport.status "failed" "($($junctionScenario.Label)) Report status must be 'failed' when InstallRoot is a pre-planted junction."
        Assert-True ($junctionInstallReport.message -match "bridge_path_contains_reparse_point") "($($junctionScenario.Label)) Failure must be the guard's own reparse-point refusal, not some other error (got: $($junctionInstallReport.message))."
        if ($junctionScenario.CreateTarget) {
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $outsideLayoutTarget "revagent-bridge-host.exe"))) "($($junctionScenario.Label)) Nothing may be written through the junction into the out-of-layout target."
        }
        else {
            Assert-True (-not (Test-Path -LiteralPath $outsideLayoutTarget)) "($($junctionScenario.Label)) The dangling junction's target must still not exist -- nothing may be created through it."
        }
        $junctionInstallStepActions = @($junctionInstallReport.steps | ForEach-Object { $_.action })
        Assert-True ($junctionInstallStepActions -notcontains "deploy_host_executable") "($($junctionScenario.Label)) No later step may run once the link guard throws on create_install_root."
    }

    # =====================================================================
    Write-Host "Test GatewayHostName guard rejects IPv6 literals (bracketed and bare), not just IPv4"
    # =====================================================================
    foreach ($ipv6Case in @("::1", "[fe80::1]", "2001:db8::8a2e:370:7334", "fe80::1%eth0")) {
        $ipv6Temp = New-TestScratchDirectory -Label "ipv6"
        $scratchRoots.Add($ipv6Temp)
        $ipv6LayoutArgs = Get-BridgeTempLayoutArgs -Root $ipv6Temp
        $ipv6ReportPath = Join-Path $ipv6Temp "report.json"
        $ipv6Threw = $false
        try {
            & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
                -PackageRoot $goodFixture.PackageRoot `
                -TrustedKeysPath $goodFixture.TrustedKeysPath `
                -EnrollmentToken ("a" * 40) `
                -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
                -InstallRoot $ipv6LayoutArgs.InstallRoot `
                -StateRoot $ipv6LayoutArgs.StateRoot `
                -AddinProgramFilesRoot $ipv6LayoutArgs.AddinProgramFilesRoot `
                -RevitAddinsRoot $ipv6LayoutArgs.RevitAddinsRoot `
                -GatewayHostName $ipv6Case `
                -MachineReportPath $ipv6ReportPath `
                -SkipRevitDetection `
                -DryRun | Out-Null
        }
        catch { $ipv6Threw = $true }
        Assert-True $ipv6Threw "GatewayHostName '$ipv6Case' (an IPv6 literal) must be refused."
        $ipv6Report = Get-Content -Raw -LiteralPath $ipv6ReportPath | ConvertFrom-Json
        Assert-True ($ipv6Report.message -match "gateway_host_must_not_be_ip") "Failure reason for '$ipv6Case' must be gateway_host_must_not_be_ip."
    }
    $dnsTemp = New-TestScratchDirectory -Label "dns-ok"
    $scratchRoots.Add($dnsTemp)
    $dnsLayoutArgs = Get-BridgeTempLayoutArgs -Root $dnsTemp
    $dnsReportPath = Join-Path $dnsTemp "report.json"
    & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
        -PackageRoot $goodFixture.PackageRoot `
        -TrustedKeysPath $goodFixture.TrustedKeysPath `
        -EnrollmentToken ("a" * 40) `
        -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
        -InstallRoot $dnsLayoutArgs.InstallRoot `
        -StateRoot $dnsLayoutArgs.StateRoot `
        -AddinProgramFilesRoot $dnsLayoutArgs.AddinProgramFilesRoot `
        -RevitAddinsRoot $dnsLayoutArgs.RevitAddinsRoot `
        -GatewayHostName "gateway.dpe.internal" `
        -MachineReportPath $dnsReportPath `
        -SkipRevitDetection `
        -DryRun | Out-Null
    $dnsReport = Get-Content -Raw -LiteralPath $dnsReportPath | ConvertFrom-Json
    Assert-Equal $dnsReport.status "success" "A genuine DNS hostname must still be accepted."

    # =====================================================================
    Write-Host "Test end-to-end install -DryRun happy path performs zero mutations and validates against the machine-report schema"
    # =====================================================================
    $happyTemp = New-TestScratchDirectory -Label "happy-target"
    $scratchRoots.Add($happyTemp)
    $happyLayoutArgs = Get-BridgeTempLayoutArgs -Root $happyTemp
    $happyReportPath = Join-Path $happyTemp "report.json"
    & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
        -PackageRoot $goodFixture.PackageRoot `
        -TrustedKeysPath $goodFixture.TrustedKeysPath `
        -EnrollmentToken ("a" * 40) `
        -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
        -InstallRoot $happyLayoutArgs.InstallRoot `
        -StateRoot $happyLayoutArgs.StateRoot `
        -AddinProgramFilesRoot $happyLayoutArgs.AddinProgramFilesRoot `
        -RevitAddinsRoot $happyLayoutArgs.RevitAddinsRoot `
        -MachineReportPath $happyReportPath `
        -SkipRevitDetection `
        -DryRun | Out-Null
    $happyReport = Get-Content -Raw -LiteralPath $happyReportPath | ConvertFrom-Json
    Assert-Equal $happyReport.status "success" "A valid signature + valid token + DryRun must succeed."
    Assert-Equal $happyReport.dryRun $true "Report must record dryRun=true."
    $nonSkippedSteps = @($happyReport.steps | Where-Object { $_.status -notin @("skipped_dry_run", "verified") })
    Assert-Equal $nonSkippedSteps.Count 0 "Every mutating step under -DryRun must be 'skipped_dry_run' (or a read-only 'verified' step)."
    Assert-True (-not (Test-Path -LiteralPath $happyLayoutArgs.InstallRoot)) "DryRun must not create the install root."
    Assert-True (-not (Test-Path -LiteralPath $happyLayoutArgs.StateRoot)) "DryRun must not create the state root."
    $happyActions = @($happyReport.steps | ForEach-Object { $_.action })
    Assert-True ([array]::IndexOf($happyActions, 'prepare_enrollment_identity') -lt [array]::IndexOf($happyActions, 'write_enrollment_artifact')) 'The genuine identity must precede the token artifact.'
    Assert-True ([array]::IndexOf($happyActions, 'write_enrollment_artifact') -lt [array]::IndexOf($happyActions, 'register_service')) 'Host install starts SCM, so the token artifact must precede service registration.'

    Write-Host "Test same-invocation enrollment handoffs plan identity before token input without prompting or writing in dry-run"
    foreach ($handoffMode in @('PromptForEnrollment', 'WaitForEnrollmentArtifact')) {
        $handoffRoot = New-TestScratchDirectory -Label 'handoff-dry-run'
        $scratchRoots.Add($handoffRoot)
        $handoffLayoutArgs = Get-BridgeTempLayoutArgs -Root $handoffRoot
        $handoffReportPath = Join-Path $handoffRoot 'report.json'
        $handoffOptions = @{}
        $handoffOptions[$handoffMode] = $true
        & (Join-Path $bridgeRoot 'Install-RevAgentBridge.ps1') -PackageRoot $goodFixture.PackageRoot -TrustedKeysPath $goodFixture.TrustedKeysPath @handoffLayoutArgs @handoffOptions -MachineReportPath $handoffReportPath -SkipRevitDetection -DryRun | Out-Null
        $handoffReport = Get-Content -Raw -LiteralPath $handoffReportPath | ConvertFrom-Json
        Assert-Equal $handoffReport.status 'success' 'A dry-run handoff needs no invented fingerprint or token.'
        Assert-Equal @($handoffReport.steps | Where-Object { $_.action -eq 'prepare_enrollment_identity' -and $_.status -eq 'skipped_dry_run' }).Count 1 'Identity preparation must be explicit and skipped.'
        Assert-True (-not (Test-Path -LiteralPath $handoffLayoutArgs.StateRoot)) 'Handoff dry run must not create credential state.'
        Assert-True ($null -eq $handoffReport.install.machineFingerprint) 'Dry run must never invent a machine fingerprint.'
    }

    $schemaPath = Join-Path $RepoRoot "config\bridge-machine-report.schema.json"
    Assert-True (Test-Path -LiteralPath $schemaPath -PathType Leaf) "The machine-report schema must exist under config/."
    $schema = Get-Content -Raw -LiteralPath $schemaPath | ConvertFrom-Json
    $happyMissingFields = Get-RevAgentBridgeReportMissingSchemaFields -Report $happyReport -Schema $schema
    Assert-Equal $happyMissingFields.Count 0 "A schema-valid report (including nested install.*) must have zero missing required fields. Missing: $($happyMissingFields -join ',')"
    Assert-Equal $happyReport.schemaVersion 1 "Report schemaVersion must be 1."
    Assert-Equal $happyReport.app "revAgent" "Report app identity must be 'revAgent'."
    Assert-Equal $happyReport.component "bridge" "Report component must be 'bridge'."
    Assert-True ($happyReport.install.PSObject.Properties["icaclsInvokerInjected"].Value -is [bool]) "install.icaclsInvokerInjected must be present and boolean."
    Assert-Equal $happyReport.install.icaclsInvokerInjected $false "A dry-run happy-path install (no -IcaclsInvoker supplied) must record icaclsInvokerInjected=false."
    Assert-True ($happyReport.install.PSObject.Properties["elevated"].Value -is [bool]) "install.elevated must be present and boolean."

    # Negative: a report missing either evidence-forgeability field must
    # fail this same validation, proving it is not silently accepted.
    $happyReportMissingInjected = $happyReport | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $happyReportMissingInjected.install.PSObject.Properties.Remove("icaclsInvokerInjected")
    $missingInjectedFields = Get-RevAgentBridgeReportMissingSchemaFields -Report $happyReportMissingInjected -Schema $schema
    Assert-True ($missingInjectedFields -contains "install.icaclsInvokerInjected") "A report missing install.icaclsInvokerInjected must fail schema validation."
    $happyReportMissingElevated = $happyReport | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $happyReportMissingElevated.install.PSObject.Properties.Remove("elevated")
    $missingElevatedFields = Get-RevAgentBridgeReportMissingSchemaFields -Report $happyReportMissingElevated -Schema $schema
    Assert-True ($missingElevatedFields -contains "install.elevated") "A report missing install.elevated must fail schema validation."

    # =====================================================================
    Write-Host "Test the elevation gate: without -IcaclsInvoker, a non-elevated real (non-dry-run) install fails closed before any mutation"
    # =====================================================================
    $currentPrincipal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
    $isRunningElevated = $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isRunningElevated) {
        Write-Host "  (skipped: this test process is elevated, so the 'not elevated' branch cannot be exercised for real here -- CI's own non-admin runner is the environment that proves this branch, and does so by running every other non-dry-run test in this file, all of which explicitly inject -IcaclsInvoker to bypass this exact gate)"
    }
    else {
        $notElevatedTemp = New-TestScratchDirectory -Label "not-elevated"
        $scratchRoots.Add($notElevatedTemp)
        $notElevatedLayoutArgs = Get-BridgeTempLayoutArgs -Root $notElevatedTemp
        $notElevatedReportPath = Join-Path $notElevatedTemp "report.json"
        $notElevatedThrew = $false
        try {
            & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
                -PackageRoot $goodFixture.PackageRoot `
                -TrustedKeysPath $goodFixture.TrustedKeysPath `
                -EnrollmentToken ("a" * 40) `
                -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
                -InstallRoot $notElevatedLayoutArgs.InstallRoot `
                -StateRoot $notElevatedLayoutArgs.StateRoot `
                -AddinProgramFilesRoot $notElevatedLayoutArgs.AddinProgramFilesRoot `
                -RevitAddinsRoot $notElevatedLayoutArgs.RevitAddinsRoot `
                -GatewayHostName 'gateway.dpe.internal' `
                -MachineReportPath $notElevatedReportPath `
                -SkipRevitDetection `
                -SkipServiceStart | Out-Null
        }
        catch { $notElevatedThrew = $true }
        Assert-True $notElevatedThrew "A non-elevated real install with no -IcaclsInvoker must fail closed."
        $notElevatedReport = Get-Content -Raw -LiteralPath $notElevatedReportPath | ConvertFrom-Json
        Assert-Equal $notElevatedReport.status "failed" "Report status must be 'failed' when not elevated."
        Assert-True ($notElevatedReport.message -match "not_elevated") "Failure must be the elevation gate's own message."
        $notElevatedStepActions = @($notElevatedReport.steps | ForEach-Object { $_.action })
        Assert-True ($notElevatedStepActions -notcontains "create_install_root") "The elevation gate must refuse before the first mutating step (create_install_root); only the earlier read-only verify_* steps may be recorded."
        Assert-True (-not (Test-Path -LiteralPath $notElevatedLayoutArgs.InstallRoot)) "Nothing may be created when the elevation gate refuses."
    }

    # =====================================================================
    Write-Host "Test idempotent file-copy/report fixture with substituted ACL metadata and native invoker"
    # =====================================================================
    # This is the regression test for the '*' literal-path copy bug and the
    # ReportsDirectory-guards-itself bug: it is the only test in this suite
    # that lets the real mutation Apply blocks run. The ACL primitive is
    # injected explicitly via -IcaclsInvoker (an actual parameter, not
    # command-name shadowing of icacls.exe -- shadowing is not reliable
    # across every depth of nested script invocation, which is exactly what
    # broke this test under scripts/test-ci.ps1's extra nesting level on a
    # non-admin CI runner: the real icacls.exe ran there, and its
    # `/grant:r` replace semantics stripped the CI account's own inherited
    # write access to InstallRoot, which then failed the next directory
    # creation with an unrelated-looking "Access is denied"). Get-Service is
    # still shadowed (a plain cmdlet call, not an external command, and not
    # implicated in that failure) to report the service as already
    # registered. Every directory/file operation (creation, link guards,
    # payload copy, config/manifest/enrollment writes, the durable report)
    # executes for real against the temp roots; only the ACL primitive is a
    # no-op, and this test proves that by verifying InstallRoot's real ACL
    # is byte-identical before and after the run.
    $realRunTemp = New-TestScratchDirectory -Label "real-run"
    $scratchRoots.Add($realRunTemp)
    $realRunLayoutArgs = Get-BridgeTempLayoutArgs -Root $realRunTemp
    $realRunReportPath = Join-Path $realRunTemp "external-report.json"

    # Pre-create InstallRoot with its real, unmodified inherited ACL so its
    # "before" SDDL can be captured -- otherwise the installer's own
    # (guarded) directory creation would be the first writer and there
    # would be nothing to compare against.
    [void](New-Item -ItemType Directory -Path $realRunLayoutArgs.InstallRoot -Force)
    $installRootAclBefore = (Get-Acl -LiteralPath $realRunLayoutArgs.InstallRoot).Sddl
    # This file-copy/report fixture is explicitly already enrolled. A fresh
    # install must invoke genuine canonical C# identity preparation, which must
    # never be redirected from these temporary roots into machine state.
    $realRunFixtureLayout = Get-RevAgentBridgeLayout @realRunLayoutArgs
    [void](New-Item -ItemType Directory -Path $realRunFixtureLayout.CredentialDirectory -Force)
    [IO.File]::WriteAllText($realRunFixtureLayout.DeviceCredentialPath, 'not-a-real-credential-fixture')

    # $global: (not $script:) is required for the call counter:
    # Install-RevAgentBridge.ps1 is invoked below as a nested script file
    # via '&', which gives it its own script-scope frame, so a '$script:'
    # write inside a scriptblock that happens to run while that nested
    # script is on the call stack lands in the NESTED script's scope, not
    # this test file's.
    $global:eu20MockIcaclsCallCount = 0
    $mockIcaclsInvoker = {
        param([string[]]$Arguments)
        $global:eu20MockIcaclsCallCount++
        return "mocked"
    }.GetNewClosure()
    function Get-Service {
        param([string]$Name, $ErrorAction)
        return [pscustomobject]@{ Name = $Name; Status = "Stopped" }
    }
    # This file-copy/report fixture already mocks the native ACL primitive.
    # Mock its credential metadata boundary too; never weaken production
    # verification to accommodate a non-admin fixture. The native suite is
    # the authority for actual owner/DACL behavior, and this report continues
    # to disclose icaclsInvokerInjected=true.
    $priorGlobalAclReader = & (Get-Module RevAgent.BridgeInstall) { Get-Item Function:Get-Acl -ErrorAction SilentlyContinue }
    $priorGlobalAclReaderBody = if ($priorGlobalAclReader) { $priorGlobalAclReader.ScriptBlock } else { $null }
    try {
        $freshRefusalRoot = New-TestScratchDirectory -Label 'fresh-identity-refusal'
        $scratchRoots.Add($freshRefusalRoot)
        $freshRefusalLayout = Get-BridgeTempLayoutArgs -Root $freshRefusalRoot
        $freshCredentialPath = (Get-RevAgentBridgeLayout @freshRefusalLayout).CredentialDirectory
        $distributionPaths = @()
        foreach($argsForLayout in @($freshRefusalLayout,$realRunLayoutArgs)){
            $l=Get-RevAgentBridgeLayout @argsForLayout;$a=Get-RevAgentBridgeAddinLayout -Layout $l -RevitVersion '2022'
            $distributionPaths+=@($l.InstallRoot,$l.StateRoot,$a.AddinBinRoot,$a.ManifestPath)
        }
        $fixtureAclReader = {
            param([string]$LiteralPath, $ErrorAction)
            if ($LiteralPath -in @($realRunFixtureLayout.CredentialDirectory, $freshCredentialPath)) {
                $security = [Security.AccessControl.DirectorySecurity]::new()
                $security.SetSecurityDescriptorSddlForm('O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
                return $security
            }
            if($LiteralPath -in $distributionPaths){
                $directory=(Get-Item -LiteralPath $LiteralPath -Force).PSIsContainer
                $security=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
                $flags=if($directory){'OICI'}else{''}
                $security.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;$flags;FA;;;SY)(A;$flags;FA;;;BA)(A;$flags;0x1200a9;;;BU)")
                return $security
            }
            if ($null -ne $priorGlobalAclReaderBody) { return & $priorGlobalAclReaderBody @PSBoundParameters }
            return Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
        }.GetNewClosure()
        Set-Item Function:global:Get-Acl -Value $fixtureAclReader
        $freshRefusalPath = Join-Path $freshRefusalRoot 'fresh-refusal.json'
        $freshRefused = $false
        try {
            & (Join-Path $bridgeRoot 'Install-RevAgentBridge.ps1') -PackageRoot $goodFixture.PackageRoot -TrustedKeysPath $goodFixture.TrustedKeysPath -GatewayHostName 'gateway.dpe.internal' -EnrollmentToken ('a' * 40) -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) @freshRefusalLayout -MachineReportPath $freshRefusalPath -SkipRevitDetection -SkipServiceStart -IcaclsInvoker $mockIcaclsInvoker | Out-Null
        }
        catch { $freshRefused = $true }
        Assert-True $freshRefused 'A redirected fresh-install fixture must not invoke canonical host identity preparation.'
        $freshRefusal = Get-Content -Raw -LiteralPath $freshRefusalPath | ConvertFrom-Json
        Assert-True ($freshRefusal.message -match 'identity_preparation_requires_canonical_layout') ('The redirected identity boundary must fail closed before host execution. Observed: '+$freshRefusal.message)
        & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
            -PackageRoot $goodFixture.PackageRoot `
            -TrustedKeysPath $goodFixture.TrustedKeysPath `
            -EnrollmentToken ("a" * 40) `
            -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
            -InstallRoot $realRunLayoutArgs.InstallRoot `
            -StateRoot $realRunLayoutArgs.StateRoot `
            -AddinProgramFilesRoot $realRunLayoutArgs.AddinProgramFilesRoot `
            -RevitAddinsRoot $realRunLayoutArgs.RevitAddinsRoot `
            -GatewayHostName 'gateway.dpe.internal' `
            -MachineReportPath $realRunReportPath `
            -SkipRevitDetection `
            -SkipServiceStart `
            -IcaclsInvoker $mockIcaclsInvoker | Out-Null
    }
    catch {
        if (Test-Path -LiteralPath $realRunReportPath) {
            $failedRun = Get-Content -Raw -LiteralPath $realRunReportPath | ConvertFrom-Json
            Write-Host ($failedRun.steps[-1] | ConvertTo-Json -Compress -Depth 4)
        }
        throw
    }
    finally {
        Remove-Item -LiteralPath Function:\Get-Service -ErrorAction SilentlyContinue
        if ($null -ne $priorGlobalAclReaderBody) { Set-Item Function:global:Get-Acl -Value $priorGlobalAclReaderBody }
        else { & (Get-Module RevAgent.BridgeInstall) { Remove-Item Function:Get-Acl -ErrorAction SilentlyContinue } }
    }

    Assert-True ($global:eu20MockIcaclsCallCount -gt 0) "The real install path must reach ACL lockdown (proves it ran past directory creation, through the injected mock invoker)."
    Remove-Variable -Name eu20MockIcaclsCallCount -Scope Global -ErrorAction SilentlyContinue
    $realRunReport = Get-Content -Raw -LiteralPath $realRunReportPath | ConvertFrom-Json
    Assert-Equal $realRunReport.status "success" "A real (non-dry-run) install against valid fixtures must succeed end-to-end."
    Assert-Equal $realRunReport.dryRun $false "This run must be recorded as non-dry-run."
    # Evidence-forgeability: a mocked-invoker run must disclose that fact so
    # this report can never be mistaken for genuine machine-mutation
    # evidence (docs/plan/M6_EU20_LAB_RUNBOOK.md Step 14 rejects any report
    # with icaclsInvokerInjected=true as true-gate lab evidence).
    Assert-Equal $realRunReport.install.icaclsInvokerInjected $true "A run with an injected -IcaclsInvoker must record icaclsInvokerInjected=true."

    # Verification method for "the installer never touches the real ACL":
    # compare InstallRoot's actual on-disk ACL (SDDL) before and after the
    # run. A real (unmocked) icacls /inheritance:r + /grant:r would change
    # this deterministically (it always strips inherited ACEs); with the
    # mock invoker in place it must be byte-identical.
    $installRootAclAfter = (Get-Acl -LiteralPath $realRunLayoutArgs.InstallRoot).Sddl
    Assert-Equal $installRootAclAfter $installRootAclBefore "InstallRoot's real ACL must be byte-identical before and after a run using the injected mock invoker -- proves no real icacls.exe call ever reached the filesystem."

    $realRunLayout = Get-RevAgentBridgeLayout @realRunLayoutArgs
    Assert-True (Test-Path -LiteralPath (Join-Path $realRunLayout.CurrentWorkerDirectory "revagent-bridge.exe") -PathType Leaf) "The worker payload file must actually land in CurrentWorkerDirectory -- a literal '*' Copy-Item path would have thrown/no-op'd here."
    $realRunAddinLayout = Get-RevAgentBridgeAddinLayout -Layout $realRunLayout -RevitVersion "2022"
    Assert-True (Test-Path -LiteralPath (Join-Path $realRunAddinLayout.AddinBinRoot "revAgentPlugin\revAgentPlugin.dll") -PathType Leaf) "The add-in payload file, including its subdirectory, must actually land in AddinBinRoot."
    Assert-True (Test-Path -LiteralPath $realRunLayout.HostExecutablePath -PathType Leaf) "The host executable must be deployed."
    Assert-True (Test-Path -LiteralPath $realRunAddinLayout.ManifestPath -PathType Leaf) "The deterministic add-in manifest must be written."
    Assert-True (-not (Test-Path -LiteralPath $realRunLayout.EnrollmentArtifactPath)) "An already-enrolled file-copy fixture must not write an enrollment artifact."
    Assert-Equal $realRunReport.install.alreadyEnrolled $true "The fixture must be honestly classified as an idempotent install."

    Assert-True (Test-Path -LiteralPath $realRunLayout.ReportsDirectory -PathType Container) "The durable <StateRoot>\reports directory must exist after a real install, not just the explicit -MachineReportPath copy."
    $durableReportFiles = @(Get-ChildItem -LiteralPath $realRunLayout.ReportsDirectory -Filter "install-*.json" -File)
    Assert-True ($durableReportFiles.Count -ge 1) "At least one durable install-<timestamp>.json report must have been written under <StateRoot>\reports."
    $durableLatestPath = Join-Path $realRunLayout.ReportsDirectory "install-latest.json"
    Assert-True (Test-Path -LiteralPath $durableLatestPath -PathType Leaf) "install-latest.json must exist under <StateRoot>\reports."
    $durableReport = Get-Content -Raw -LiteralPath $durableLatestPath | ConvertFrom-Json
    foreach ($requiredField in $schema.required) {
        Assert-True ($null -ne $durableReport.PSObject.Properties[$requiredField]) "Durable machine report is missing schema-required field '$requiredField'."
    }
    Assert-Equal $durableReport.status "success" "The durable machine report must also record success."

    # =====================================================================
    Write-Host "Test Write-RevAgentBridgeMachineReport against a not-yet-existing reports directory"
    # =====================================================================
    $freshReportsRoot = New-TestScratchDirectory -Label "fresh-reports"
    $scratchRoots.Add($freshReportsRoot)
    $freshStateRoot = Join-Path $freshReportsRoot "StateRoot"
    [void](New-Item -ItemType Directory -Path $freshStateRoot -Force)
    $freshReportsDirectory = Join-Path $freshStateRoot "reports"
    Assert-True (-not (Test-Path -LiteralPath $freshReportsDirectory)) "Fixture precondition: the reports directory must not exist yet."
    $freshReport = New-RevAgentBridgeMachineReport -Action "install" -DryRun $false -StartedAtUtc ([datetime]::UtcNow) -CompletedAtUtc ([datetime]::UtcNow) -Status "success" -Message "unit test"
    $freshWrittenPath = Write-RevAgentBridgeMachineReport -Report $freshReport -ReportsDirectory $freshReportsDirectory -DryRun $false
    Assert-True (Test-Path -LiteralPath $freshReportsDirectory -PathType Container) "Write-RevAgentBridgeMachineReport must create a not-yet-existing reports directory (guarded from its parent, not from itself)."
    Assert-True (Test-Path -LiteralPath $freshWrittenPath -PathType Leaf) "Write-RevAgentBridgeMachineReport must return the path it wrote."
    Assert-True (Test-Path -LiteralPath (Join-Path $freshReportsDirectory "install-latest.json") -PathType Leaf) "install-latest.json must be written alongside the timestamped report."

    # =====================================================================
    Write-Host "Test idempotent re-run: an existing device credential skips enrollment-artifact write"
    # =====================================================================
    $idempotentTemp = New-TestScratchDirectory -Label "idempotent-target"
    $scratchRoots.Add($idempotentTemp)
    $idempotentLayoutArgs = Get-BridgeTempLayoutArgs -Root $idempotentTemp
    $idempotentLayout = Get-RevAgentBridgeLayout @idempotentLayoutArgs
    [void](New-Item -ItemType Directory -Path $idempotentLayout.CredentialDirectory -Force)
    [System.IO.File]::WriteAllBytes($idempotentLayout.DeviceCredentialPath, [byte[]](1, 2, 3))
    $idempotentReportPath = Join-Path $idempotentTemp "report.json"
    & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
        -PackageRoot $goodFixture.PackageRoot `
        -TrustedKeysPath $goodFixture.TrustedKeysPath `
        -InstallRoot $idempotentLayoutArgs.InstallRoot `
        -StateRoot $idempotentLayoutArgs.StateRoot `
        -AddinProgramFilesRoot $idempotentLayoutArgs.AddinProgramFilesRoot `
        -RevitAddinsRoot $idempotentLayoutArgs.RevitAddinsRoot `
        -MachineReportPath $idempotentReportPath `
        -SkipRevitDetection `
        -DryRun | Out-Null
    $idempotentReport = Get-Content -Raw -LiteralPath $idempotentReportPath | ConvertFrom-Json
    Assert-Equal $idempotentReport.status "success" "Re-run against an already-enrolled machine must succeed without -EnrollmentToken."
    Assert-Equal $idempotentReport.install.alreadyEnrolled $true "Re-run must detect the existing device credential."
    Assert-Equal $idempotentReport.install.enrollmentAttempted $false "Re-run must not attempt enrollment when already enrolled."
    $enrollmentStep = @($idempotentReport.steps | Where-Object { $_.action -eq "write_enrollment_artifact" })[0]
    Assert-Equal $enrollmentStep.status "skipped_already_enrolled" "Re-run's enrollment-artifact step must be skipped for the already-enrolled reason, not the dry-run reason."

    # =====================================================================
    Write-Host "Test tree-wipe dry-run performs zero deletions and never invokes the removal action (single choke point)"
    # =====================================================================
    $wipeDryRunRoot = New-TestScratchDirectory -Label "wipe-dryrun"
    $scratchRoots.Add($wipeDryRunRoot)
    $wipeDryRunFile = Join-Path $wipeDryRunRoot "loose-file.txt"
    Set-Content -LiteralPath $wipeDryRunFile -Value "content" -Encoding UTF8
    $wipeDryRunPlan = Get-RevAgentBridgeTreeWipePlan -Root $wipeDryRunRoot -Anchors @()
    $script:eu20RemoveActionCallCount = 0
    $mockRemoveAction = { param([string]$ItemPath, [string]$ItemKind) $script:eu20RemoveActionCallCount++; return "removed" }
    $wipeDryRunSteps = [System.Collections.Generic.List[object]]::new()
    $wipeDryRunResults = Invoke-RevAgentBridgeTreeWipePlan -Plan $wipeDryRunPlan -DryRun $true -Steps $wipeDryRunSteps -RemoveItemAction $mockRemoveAction
    Assert-Equal $script:eu20RemoveActionCallCount 0 "Tree-wipe dry-run must never invoke the removal action -- DryRun gating lives only in the guarded choke point."
    Assert-True (Test-Path -LiteralPath $wipeDryRunFile -PathType Leaf) "Tree-wipe dry-run must perform zero deletions."
    $wipeDryRunFileResult = @($wipeDryRunResults | Where-Object { $_.path -eq $wipeDryRunFile })[0]
    Assert-Equal $wipeDryRunFileResult.disposition "would_remove" "Dry-run disposition for a plan 'remove' item must be 'would_remove'."
    Assert-True ($wipeDryRunSteps.Count -gt 0) "Each planned removal must still be recorded as a guarded-mutation step even under dry-run."
    Assert-True (@($wipeDryRunSteps | Where-Object { $_.status -ne "skipped_dry_run" }).Count -eq 0) "Every tree-wipe step under dry-run must be 'skipped_dry_run'."

    # =====================================================================
    Write-Host "Test a directory junction inside the legacy tree is not followed"
    # =====================================================================
    $junctionWalkRoot = New-TestScratchDirectory -Label "junction-walk"
    $scratchRoots.Add($junctionWalkRoot)
    $junctionLegacyRoot = Join-Path $junctionWalkRoot "legacy"
    [void](New-Item -ItemType Directory -Path $junctionLegacyRoot -Force)
    Set-Content -LiteralPath (Join-Path $junctionLegacyRoot "ordinary-file.txt") -Value "x" -Encoding UTF8
    $junctionOutsideTarget = Join-Path $junctionWalkRoot "outside-target"
    [void](New-Item -ItemType Directory -Path $junctionOutsideTarget -Force)
    Set-Content -LiteralPath (Join-Path $junctionOutsideTarget "secret-marker.txt") -Value "do-not-touch" -Encoding UTF8
    $junctionLinkPath = Join-Path $junctionLegacyRoot "evil-link"
    [void](New-Item -ItemType Junction -Path $junctionLinkPath -Target $junctionOutsideTarget)

    $junctionPlan = Get-RevAgentBridgeTreeWipePlan -Root $junctionLegacyRoot -Anchors @()
    $junctionLinkEntry = @($junctionPlan | Where-Object { $_.path -eq $junctionLinkPath })[0]
    Assert-Equal $junctionLinkEntry.disposition "kept_reparse_point" "A directory junction inside the legacy tree must be kept, never planned for removal by recursion."
    $leakedMarkerEntries = @($junctionPlan | Where-Object { $_.path -like "*secret-marker.txt" })
    Assert-Equal $leakedMarkerEntries.Count 0 "Contents behind a planted junction must never be enumerated into the wipe plan (the walk must not follow it)."

    $junctionResults = Invoke-RevAgentBridgeTreeWipePlan -Plan $junctionPlan -DryRun $false
    $failedJunctionResults = @($junctionResults | Where-Object { $_.disposition -eq "failed" })
    Assert-Equal $failedJunctionResults.Count 0 "Wiping around a kept junction must not fail."
    Assert-True (Test-Path -LiteralPath (Join-Path $junctionOutsideTarget "secret-marker.txt") -PathType Leaf) "The out-of-tree target behind the junction must survive completely untouched."
    Assert-True (Test-Path -LiteralPath $junctionLinkPath) "The junction placeholder itself must survive (never deleted, never followed)."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $junctionLegacyRoot "ordinary-file.txt"))) "An ordinary non-anchor file alongside the junction must still be removed."

    # =====================================================================
    Write-Host "Test uninstaller tree wipe structurally cannot remove a P-SEQ-2 rollback anchor"
    # =====================================================================
    $wipeRoot = New-TestScratchDirectory -Label "wipe"
    $scratchRoots.Add($wipeRoot)
    $legacyRoot = Join-Path $wipeRoot "DPE\revAgent"
    $bootstrapDir = Join-Path $legacyRoot "bootstrap"
    $prestageDir = Join-Path $legacyRoot "prestage"
    $updaterConfigDir = Join-Path $legacyRoot "updater\config"
    [void](New-Item -ItemType Directory -Path $bootstrapDir -Force)
    [void](New-Item -ItemType Directory -Path $prestageDir -Force)
    [void](New-Item -ItemType Directory -Path $updaterConfigDir -Force)
    Set-Content -LiteralPath (Join-Path $bootstrapDir "seed.ps1") -Value "# bootstrap seed" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $prestageDir "install-revagent-local-bootstrap.ps1") -Value "# anchor script" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $prestageDir "other-prestage-file.ps1") -Value "# not an anchor" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $updaterConfigDir "release-trusted-keys.json") -Value '{"keys":[]}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $updaterConfigDir "other-updater-config.json") -Value '{}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $legacyRoot "legacy-loose-file.txt") -Value "legacy" -Encoding UTF8

    $anchors = Get-RevAgentBridgeRollbackAnchors -ProgramDataRoot $wipeRoot
    Assert-Equal $anchors.Count 3 "There must be exactly three P-SEQ-2 rollback anchors."
    $anchorHashesBefore = Get-RevAgentBridgeAnchorHashes -Anchors $anchors

    $plan = Get-RevAgentBridgeTreeWipePlan -Root $legacyRoot -Anchors $anchors
    $anchorScriptPath = Join-Path $prestageDir "install-revagent-local-bootstrap.ps1"
    $anchorPlanEntry = @($plan | Where-Object { $_.path -eq $anchorScriptPath })[0]
    Assert-Equal $anchorPlanEntry.disposition "kept_anchor" "The anchor script must never be planned for removal."
    $bootstrapDirPlanEntry = @($plan | Where-Object { $_.path -eq $bootstrapDir })[0]
    Assert-Equal $bootstrapDirPlanEntry.disposition "kept_anchor" "The bootstrap\ anchor directory must never be planned for removal."

    $results = Invoke-RevAgentBridgeTreeWipePlan -Plan $plan -DryRun $false
    $failedResults = @($results | Where-Object { $_.disposition -eq "failed" })
    Assert-Equal $failedResults.Count 0 "The legacy-tree wipe must not fail on any item in this fixture."

    Assert-True (Test-Path -LiteralPath (Join-Path $bootstrapDir "seed.ps1") -PathType Leaf) "bootstrap\ contents must survive the wipe untouched."
    Assert-True (Test-Path -LiteralPath $anchorScriptPath -PathType Leaf) "The exact anchor script must survive the wipe."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $prestageDir "other-prestage-file.ps1"))) "A non-anchor file alongside an anchor must still be removed."
    Assert-True (Test-Path -LiteralPath (Join-Path $updaterConfigDir "release-trusted-keys.json") -PathType Leaf) "The anchor trusted-keys file must survive the wipe."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $updaterConfigDir "other-updater-config.json"))) "A non-anchor file in the updater config directory must still be removed."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $legacyRoot "legacy-loose-file.txt"))) "Loose non-anchor legacy files must be removed."

    $anchorHashesAfter = Get-RevAgentBridgeAnchorHashes -Anchors $anchors
    foreach ($anchor in $anchors) {
        Assert-Equal $anchorHashesAfter.$anchor $anchorHashesBefore.$anchor "Anchor content hash must be byte-identical before and after the wipe: $anchor"
    }

    # =====================================================================
    Write-Host "Test uninstaller -DryRun end-to-end: zero mutation, anchors reported preserved"
    # =====================================================================
    $uninstallDryRunRoot = New-TestScratchDirectory -Label "uninstall-dryrun"
    $scratchRoots.Add($uninstallDryRunRoot)
    $udrLegacyRoot = Join-Path $uninstallDryRunRoot "DPE\revAgent"
    [void](New-Item -ItemType Directory -Path (Join-Path $udrLegacyRoot "bootstrap") -Force)
    Set-Content -LiteralPath (Join-Path $udrLegacyRoot "bootstrap\seed.ps1") -Value "# seed" -Encoding UTF8
    [void](New-Item -ItemType Directory -Path (Join-Path $udrLegacyRoot "prestage") -Force)
    Set-Content -LiteralPath (Join-Path $udrLegacyRoot "prestage\install-revagent-local-bootstrap.ps1") -Value "# anchor" -Encoding UTF8
    [void](New-Item -ItemType Directory -Path (Join-Path $udrLegacyRoot "updater\config") -Force)
    Set-Content -LiteralPath (Join-Path $udrLegacyRoot "updater\config\release-trusted-keys.json") -Value '{}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $udrLegacyRoot "legacy-loose-file.txt") -Value "legacy" -Encoding UTF8

    $uninstallReportPath = Join-Path $uninstallDryRunRoot "wipe-report.json"
    & (Join-Path $bridgeRoot "Uninstall-RevAgentBridge.ps1") `
        -ProgramDataRoot $uninstallDryRunRoot `
        -LocalAppDataRoot (Join-Path $uninstallDryRunRoot "LocalAppData") `
        -MachineReportPath $uninstallReportPath `
        -SkipScheduledTaskRemoval `
        -SkipServiceRemoval `
        -DryRun | Out-Null
    $uninstallReport = Get-Content -Raw -LiteralPath $uninstallReportPath | ConvertFrom-Json
    Assert-Equal $uninstallReport.status "success" "Uninstaller dry-run against this fixture must succeed."
    Assert-Equal $uninstallReport.dryRun $true "Uninstaller report must record dryRun=true."
    Assert-True (Test-Path -LiteralPath (Join-Path $udrLegacyRoot "legacy-loose-file.txt") -PathType Leaf) "Uninstaller -DryRun must not remove anything -- the loose legacy file must still exist."
    foreach ($anchorRecord in $uninstallReport.uninstall.anchors) {
        Assert-Equal $anchorRecord.preserved $true "Every anchor record in the dry-run report must show preserved=true: $($anchorRecord.path)"
    }
    Assert-Equal $uninstallReport.uninstall.icaclsInvokerInjected $false "The uninstaller never calls icacls; its report must always record icaclsInvokerInjected=false."
    Assert-True ($uninstallReport.uninstall.PSObject.Properties["elevated"].Value -is [bool]) "uninstall.elevated must be present and boolean."
    $uninstallMissingFields = Get-RevAgentBridgeReportMissingSchemaFields -Report $uninstallReport -Schema $schema
    Assert-Equal $uninstallMissingFields.Count 0 "The uninstaller report (including nested uninstall.*) must have zero missing required schema fields. Missing: $($uninstallMissingFields -join ',')"

    # =====================================================================
    Write-Host 'Test BridgeOwned report guards preserve existing reports and affected roots'
    # Exercise the real signed-package/owned-inventory/dry-run path without
    # pretending this non-admin process owns SYSTEM/Administrators ACLs.
    $actualBundleId='EvRJBzBTzkY8ChjFumZ_JPUkO+eiczg='
    $actualBundleDirectory=Join-Path $realRunLayout.BundleExtractionRoot (Join-Path 'revagent-bridge' $actualBundleId)
    $actualBundleLibrary=Join-Path $actualBundleDirectory 'e_sqlite3.dll'
    [void][IO.Directory]::CreateDirectory($actualBundleDirectory)
    [IO.File]::WriteAllBytes($actualBundleLibrary,[byte[]]@(10,20,30,40))
    $overlongPaddedBundleRelative='bundle-extract/revagent-bridge/'+('a'*128)+'='
    $triplePaddedBundleRelative='bundle-extract/revagent-bridge/abc==='
    $bundleShapeProbe={param([string]$Relative) Test-RevAgentBridgeOwnedStatePath -Relative $Relative -Directory $true}
    Assert-True (-not(& (Get-Module RevAgent.BridgeInstall) $bundleShapeProbe $overlongPaddedBundleRelative)) 'Padding must remain inside the existing 128-character total bundle-ID bound.'
    Assert-True (-not(& (Get-Module RevAgent.BridgeInstall) $bundleShapeProbe $triplePaddedBundleRelative)) 'Bundle IDs with more than two trailing padding characters must remain refused.'
    $oldReader=& (Get-Module RevAgent.BridgeInstall) {Get-Item Function:Get-Acl -ErrorAction SilentlyContinue}
    $oldReaderBody=if($oldReader){$oldReader.ScriptBlock}else{$null}
    $cleanupAncestorPaths=@((Split-Path $realRunLayout.InstallRoot -Parent),(Split-Path $realRunLayout.StateRoot -Parent),$realRunLayout.AddinProgramFilesRoot,(Split-Path $realRunLayout.AddinProgramFilesRoot -Parent))
    $ownedMetadataReader={
        param([string]$LiteralPath,$ErrorAction)
        $a=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
        $scoped=$LiteralPath -ieq $realRunAddinLayout.ManifestPath -or $LiteralPath -in $cleanupAncestorPaths
        foreach($rootPath in @($realRunLayout.InstallRoot,$realRunLayout.StateRoot,$realRunAddinLayout.AddinBinRoot)){if($LiteralPath -ieq $rootPath -or $LiteralPath.StartsWith($rootPath+'\',[StringComparison]::OrdinalIgnoreCase)){$scoped=$true}}
        if($scoped){$a.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));return $a}
        if($oldReaderBody){return & $oldReaderBody @PSBoundParameters};return $a
    }.GetNewClosure()
    Set-Item Function:global:Get-Acl -Value $ownedMetadataReader
    try {
        $embeddedPaddingDirectory=Join-Path $realRunLayout.BundleExtractionRoot 'revagent-bridge\abc=def'
        [void][IO.Directory]::CreateDirectory($embeddedPaddingDirectory)
        [IO.File]::WriteAllBytes((Join-Path $embeddedPaddingDirectory 'e_sqlite3.dll'),[byte[]]@(1))
        Assert-ThrowsLike {Get-RevAgentBridgeOwnedCleanupPlan -Layout $realRunLayout -RevitVersion 2022 -PackageRoot $goodFixture.PackageRoot -TrustedKeysPath $goodFixture.TrustedKeysPath} 'bridge_owned_unknown_state_path' 'Bundle padding is accepted only at the end of the bounded ID segment.'
        Remove-Item -LiteralPath $embeddedPaddingDirectory -Recurse -Force
        $unsupportedBundleLeaf=Join-Path $actualBundleDirectory 'payload.json'
        [IO.File]::WriteAllText($unsupportedBundleLeaf,'unsupported')
        Assert-ThrowsLike {Get-RevAgentBridgeOwnedCleanupPlan -Layout $realRunLayout -RevitVersion 2022 -PackageRoot $goodFixture.PackageRoot -TrustedKeysPath $goodFixture.TrustedKeysPath} 'bridge_owned_unknown_state_path' 'Padded bundle directories still admit native DLL leaves only.'
        Remove-Item -LiteralPath $unsupportedBundleLeaf -Force
        $plan=Get-RevAgentBridgeOwnedCleanupPlan -Layout $realRunLayout -RevitVersion 2022 -PackageRoot $goodFixture.PackageRoot -TrustedKeysPath $goodFixture.TrustedKeysPath
        Assert-True ($plan.items.Count -gt 3) 'Owned plan must include actual signed payload and state entries.'
        Assert-Equal @($plan.items|Where-Object{$_.path -ieq $actualBundleDirectory -and $_.kind -ceq 'directory'}).Count 1 'Owned plan must admit the genuine padded bundle directory shape.'
        Assert-Equal @($plan.items|Where-Object{$_.path -ieq $actualBundleLibrary -and $_.kind -ceq 'file' -and $_.stateContentNotRead -and $null -eq $_.sha256}).Count 1 'Owned plan must admit the native DLL leaf without reading state content.'
        Assert-True (@($plan.items|Where-Object{$_.stateContentNotRead -and $_.sha256}).Count -eq 0) 'State/credential contents must not be hashed into the report.'
        $preview=& (Join-Path $bridgeRoot 'Uninstall-RevAgentBridge.ps1') -Scope BridgeOwned -PackageRoot $goodFixture.PackageRoot -TrustedKeysPath $goodFixture.TrustedKeysPath @realRunLayoutArgs -ProgramDataRoot (Join-Path $realRunTemp 'absent-legacy-data') -MachineReportPath (Join-Path $realRunTemp 'owned-preview.json') -DryRun
        Assert-Equal $preview.status 'success' 'Explicit owned dry-run must succeed with verified test metadata.'
        Assert-Equal $preview.uninstall.scope 'BridgeOwned' 'Report must identify the explicit scope.'
        Assert-True (-not $preview.uninstall.ownedCleanup.completed -and $preview.uninstall.legacyTrees.Count -eq 0) 'Dry-run must not claim removal or run legacy cleanup.'
        Assert-True (Test-Path -LiteralPath $realRunLayout.HostExecutablePath) 'Owned dry-run preserves signed payload.'
        Assert-True (Test-Path -LiteralPath $actualBundleLibrary -PathType Leaf) 'Owned dry-run preserves the padded bundle native DLL.'
    } finally {if($oldReaderBody){Set-Item Function:global:Get-Acl -Value $oldReaderBody}else{& (Get-Module RevAgent.BridgeInstall) {Remove-Item Function:Get-Acl}}}
    $ownedReport = Join-Path $realRunTemp 'must-preserve-report.json'
    [IO.File]::WriteAllText($ownedReport,'preserve-existing-report')
    Assert-ThrowsLike {
        & (Join-Path $bridgeRoot 'Uninstall-RevAgentBridge.ps1') -Scope BridgeOwned -PackageRoot $goodFixture.PackageRoot -TrustedKeysPath $goodFixture.TrustedKeysPath @realRunLayoutArgs -MachineReportPath $ownedReport -DryRun | Out-Null
    } 'bridge_owned_report_must_be_fresh' 'Owned cleanup must not overwrite an existing report, even on refusal.'
    Assert-Equal ([IO.File]::ReadAllText($ownedReport)) 'preserve-existing-report' 'Existing external report must survive.'
    $insideReport=Join-Path $realRunLayout.StateRoot 'uninstall-proof.json'
    Assert-ThrowsLike {
        & (Join-Path $bridgeRoot 'Uninstall-RevAgentBridge.ps1') -Scope BridgeOwned -PackageRoot $goodFixture.PackageRoot -TrustedKeysPath $goodFixture.TrustedKeysPath @realRunLayoutArgs -MachineReportPath $insideReport -DryRun | Out-Null
    } 'bridge_owned_report_inside_affected_root' 'Owned cleanup report must be outside affected roots.'
    Assert-True (-not(Test-Path -LiteralPath $insideReport)) 'Rejected report must not create a file in a cleanup target.'

    Write-Host "Test bounded Codex config edit preserves everything outside the two managed sections byte-for-byte"
    # =====================================================================
    $codexRoot = New-TestScratchDirectory -Label "codex-config"
    $scratchRoots.Add($codexRoot)
    $codexConfigPath = Join-Path $codexRoot "config.toml"
    $codexConfigContent = @(
        "[some_other_section]",
        'value = "keep-me"',
        "",
        "[mcp_servers.revAgent]",
        'command = "node"',
        'args = ["C:\\old\\runtime\\index.js"]',
        "",
        "[mcp_servers.revAgent-api-docs]",
        'command = "node"',
        'args = ["C:\\old\\docs\\index.js"]',
        "",
        "[another_untouched_section]",
        "nested_value = 42",
        ""
    ) -join "`r`n"
    Set-Content -LiteralPath $codexConfigPath -Value $codexConfigContent -Encoding UTF8

    $codexResult = Remove-RevAgentBridgeManagedCodexSections -ConfigPath $codexConfigPath -DryRun $false
    Assert-Equal (@($codexResult.sectionsRemoved) -join ",") "revAgent,revAgent-api-docs" "Both managed legacy sections must be reported removed."
    Assert-True $codexResult.unchangedElsewhere "The edit must be proven structurally bounded to the two managed sections."
    $codexAfter = Get-Content -Raw -LiteralPath $codexConfigPath
    Assert-True ($codexAfter -match '\[some_other_section\]') "Unrelated sections must survive the bounded Codex edit."
    Assert-True ($codexAfter -match 'value = "keep-me"') "Unrelated scalar values must survive the bounded Codex edit byte-for-byte."
    Assert-True ($codexAfter -match '\[another_untouched_section\]') "A section declared after the managed sections must survive untouched."
    Assert-True ($codexAfter -notmatch '\[mcp_servers\.revAgent\]') "The managed revAgent section must be gone."
    Assert-True ($codexAfter -notmatch '\[mcp_servers\.revAgent-api-docs\]') "The managed revAgent-api-docs section must be gone."

    # Idempotent re-run (section already absent) must be a safe no-op.
    $codexResultAgain = Remove-RevAgentBridgeManagedCodexSections -ConfigPath $codexConfigPath -DryRun $false
    Assert-Equal $codexResultAgain.sectionsRemoved.Count 0 "A second run must find nothing left to remove."
    $codexAfterAgain = Get-Content -Raw -LiteralPath $codexConfigPath
    Assert-Equal $codexAfterAgain $codexAfter "A no-op re-run must leave the config byte-identical."

    Write-Host ""
    Write-Host "All EU-20 Bridge installer/uninstaller focused tests passed." -ForegroundColor Green
}
finally {
    foreach ($root in $scratchRoots) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
