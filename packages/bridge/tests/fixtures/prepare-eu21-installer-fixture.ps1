[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$Root = [IO.Path]::GetFullPath($Root)
$bridgeModule = Join-Path $RepoRoot 'installer\bridge\lib\RevAgent.BridgeInstall.psm1'
$integrityModule = Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1'
Import-Module $bridgeModule -Force
Import-Module $integrityModule -Force

$package = Join-Path $Root 'package-v1'
$hostDirectory = Join-Path $package 'host'
$workerDirectory = Join-Path $package 'worker'
$addinDirectory = Join-Path $package 'addin\revAgentPlugin'
[void](New-Item -ItemType Directory -Force -Path $hostDirectory,$workerDirectory,$addinDirectory)
[IO.File]::WriteAllText((Join-Path $hostDirectory 'revagent-bridge-host.exe'),'v1-host')
[IO.File]::WriteAllText((Join-Path $workerDirectory 'revagent-bridge.exe'),'v1-worker')
[IO.File]::WriteAllText((Join-Path $addinDirectory 'revAgentPlugin.dll'),'v1-addin')

$content = [ordered]@{
    schemaVersion = 1
    app = 'revAgent'
    version = '1.0.0'
    host = [ordered]@{
        relativePath = 'host\revagent-bridge-host.exe'
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $hostDirectory 'revagent-bridge-host.exe')).Hash
    }
    worker = [ordered]@{
        relativeDirectory = 'worker'
        sha256 = Get-RevAgentBridgeDirectoryTreeSha256 -Path $workerDirectory
    }
    addin = [ordered]@{
        relativeDirectory = 'addin'
        sha256 = Get-RevAgentBridgeDirectoryTreeSha256 -Path (Join-Path $package 'addin')
    }
}
$csp = [Security.Cryptography.CspParameters]::new(24)
$csp.Flags = [Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
$rsa = [Security.Cryptography.RSACryptoServiceProvider]::new($csp)
try {
    $publicKeyXml = $rsa.ToXmlString($false)
    $privateKeyXml = $rsa.ToXmlString($true)
    $fingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    $envelope = New-RevitMcpDetachedJsonSignature `
        -Content $content `
        -SignedObject 'release-manifest' `
        -KeyId 'eu21-composed-test-key' `
        -PrivateKeyXml $privateKeyXml `
        -App 'revAgent'
}
finally {
    $rsa.Dispose()
}

$content | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $package 'bridge-release.json') -Encoding UTF8
$envelope | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $package 'bridge-release.json.sig') -Encoding UTF8
$trustedKeysPath = Join-Path $package 'trusted-keys.json'
[ordered]@{
    'eu21-composed-test-key' = [ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = $fingerprint
        algorithm = 'RS256'
    }
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $trustedKeysPath -Encoding UTF8
$privateKeyPath = Join-Path $Root 'eu21-test-private-key.xml'
[IO.File]::WriteAllText($privateKeyPath,$privateKeyXml,[Text.UTF8Encoding]::new($false))

$installRoot = Join-Path $Root 'ProgramFiles\revAgent\Bridge'
$stateRoot = Join-Path $Root 'ProgramData\revAgent\bridge'
$addinRoot = Join-Path $Root 'ProgramFiles\revAgent\Addin'
$revitAddinsRoot = Join-Path $Root 'ProgramData\Autodesk\Revit\Addins'
$credentialDirectory = Join-Path $stateRoot 'credentials'
[void](New-Item -ItemType Directory -Force -Path $credentialDirectory)
[IO.File]::WriteAllText((Join-Path $credentialDirectory 'device-credential.dpapi'),'fixture-existing-credential')

function global:Get-Service {
    param([string]$Name,[object]$ErrorAction)
    [pscustomobject]@{Name=$Name;Status='Running'}
}
$fixtureLayout = Get-RevAgentBridgeLayout `
    -InstallRoot $installRoot `
    -StateRoot $stateRoot `
    -AddinProgramFilesRoot $addinRoot `
    -RevitAddinsRoot $revitAddinsRoot
$fixtureAddin = Get-RevAgentBridgeAddinLayout -Layout $fixtureLayout -RevitVersion '2022'
$distributionPaths = @(
    $fixtureLayout.InstallRoot,
    $fixtureLayout.StateRoot,
    $fixtureAddin.AddinBinRoot,
    $fixtureAddin.ManifestPath,
    $fixtureLayout.UpdateTrustedKeysPath
)
$distributionRoots = @($fixtureLayout.InstallRoot,$fixtureAddin.AddinBinRoot)
$fixtureAclReader = {
    param([string]$LiteralPath,[object]$ErrorAction)
    if ($LiteralPath -ieq $fixtureLayout.CredentialDirectory) {
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetSecurityDescriptorSddlForm('O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
        return $security
    }
    $underDistributionRoot = @($distributionRoots | Where-Object {
        $LiteralPath.StartsWith($_.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    if ($LiteralPath -in $distributionPaths -or $underDistributionRoot) {
        $directory = (Get-Item -LiteralPath $LiteralPath -Force).PSIsContainer
        $security = if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
        $flags = if($directory){'OICI'}else{''}
        $inheritance = if($LiteralPath -in $distributionPaths){'P'}else{'AI'}
        $aceInheritance = if($LiteralPath -in $distributionPaths){$flags}else{$flags+'ID'}
        $security.SetSecurityDescriptorSddlForm("O:BAG:BAD:$inheritance(A;$aceInheritance;FA;;;SY)(A;$aceInheritance;FA;;;BA)(A;$aceInheritance;0x1200a9;;;BU)")
        return $security
    }
    return Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
}.GetNewClosure()
Set-Item Function:global:Get-Acl -Value $fixtureAclReader
$mockIcacls = { param([string[]]$Arguments) 'mocked icacls' }
try {
    $reportPath = Join-Path $Root 'installer-report.json'
    & (Join-Path $RepoRoot 'installer\bridge\Install-RevAgentBridge.ps1') `
        -PackageRoot $package `
        -TrustedKeysPath $trustedKeysPath `
        -RevitVersion '2022' `
        -GatewayHostName 'eu21-gateway.fixture:8443' `
        -InstallRoot $installRoot `
        -StateRoot $stateRoot `
        -AddinProgramFilesRoot $addinRoot `
        -RevitAddinsRoot $revitAddinsRoot `
        -MachineReportPath $reportPath `
        -SkipRevitDetection `
        -SkipServiceStart `
        -IcaclsInvoker $mockIcacls | Out-Null
}
finally {
    Remove-Item Function:global:Get-Service -ErrorAction SilentlyContinue
    Remove-Item Function:global:Get-Acl -ErrorAction SilentlyContinue
}

[ordered]@{
    installRoot = $installRoot
    stateRoot = $stateRoot
    addinRoot = $addinRoot
    revitAddinsRoot = $revitAddinsRoot
    reportPath = $reportPath
    privateKeyPath = $privateKeyPath
    trustedKeysPath = (Join-Path $installRoot 'update-trusted-keys.json')
} | ConvertTo-Json -Compress
