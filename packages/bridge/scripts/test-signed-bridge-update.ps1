[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$ArtifactsRoot = '',
    [string]$DotnetPath = 'dotnet'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')) }
if (-not $ArtifactsRoot) { $ArtifactsRoot = Join-Path $RepoRoot 'artifacts\eu21-p3t12-delivery\package-test' }
$ArtifactsRoot = [IO.Path]::GetFullPath($ArtifactsRoot)
$allowedArtifactsParent = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'artifacts\eu21-p3t12-delivery'))
if (-not $ArtifactsRoot.StartsWith($allowedArtifactsParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Focused test artifacts must stay below artifacts/eu21-p3t12-delivery.'
}
if (Test-Path -LiteralPath $ArtifactsRoot) { Remove-Item -LiteralPath $ArtifactsRoot -Recurse -Force }
[void](New-Item -ItemType Directory -Path $ArtifactsRoot)

function Assert-Equal { param($Actual, $Expected, [string]$Message) if (-not [object]::Equals($Actual, $Expected)) { throw "$Message Actual='$Actual' Expected='$Expected'." } }
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    try { & $Action; throw "$Message Expected an exception." }
    catch { if ($_.Exception.Message -notmatch $Pattern) { throw "$Message Actual='$($_.Exception.Message)'." } }
}
function XmlElement { param([string]$Name, [byte[]]$Value) return "<$Name>$([Convert]::ToBase64String($Value))</$Name>" }
function Read-ZipEntryText {
    param([IO.Compression.ZipArchive]$Archive, [string]$EntryName)
    $entry = $Archive.GetEntry($EntryName)
    if ($null -eq $entry) { throw "ZIP entry was not found: $EntryName" }
    $stream = $entry.Open()
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose(); $stream.Dispose() }
}

$rsa = [Security.Cryptography.RSA]::Create(2048)
$privatePath = ''
try {
    $key = $rsa.ExportParameters($true)
    $publicXml = '<RSAKeyValue>' + (XmlElement Modulus $key.Modulus) + (XmlElement Exponent $key.Exponent) + '</RSAKeyValue>'
    $privateXml = '<RSAKeyValue>' + (XmlElement Modulus $key.Modulus) + (XmlElement Exponent $key.Exponent) +
        (XmlElement P $key.P) + (XmlElement Q $key.Q) + (XmlElement DP $key.DP) + (XmlElement DQ $key.DQ) +
        (XmlElement InverseQ $key.InverseQ) + (XmlElement D $key.D) + '</RSAKeyValue>'
    $privatePath = Join-Path $ArtifactsRoot 'generated-private.xml'
    $trustedPath = Join-Path $ArtifactsRoot 'generated-trusted.json'
    [IO.File]::WriteAllText($privatePath, $privateXml, [Text.UTF8Encoding]::new($false))
    Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -Force
    $fingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicXml
    [ordered]@{ trustedKeys = [ordered]@{ 'generated-p3t12' = [ordered]@{
        publicKeyXml = $publicXml; publicKeyFingerprint = $fingerprint; algorithm = 'RS256'
    } } } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $trustedPath -Encoding utf8NoBOM

    $preparedBridge = Join-Path $ArtifactsRoot 'prepared-bridge'
    $preparedAddin = Join-Path $ArtifactsRoot 'prepared-addin\2022\revAgentPlugin'
    [void](New-Item -ItemType Directory -Path $preparedBridge)
    [void](New-Item -ItemType Directory -Path $preparedAddin)
    [IO.File]::WriteAllBytes((Join-Path $preparedBridge 'revagent-bridge.exe'), [Text.Encoding]::UTF8.GetBytes('generated worker fixture'))
    [IO.File]::WriteAllBytes((Join-Path $preparedAddin 'revAgentPlugin.dll'), [Text.Encoding]::UTF8.GetBytes('generated addin fixture'))
    [IO.File]::WriteAllText((Join-Path $preparedAddin 'ignored.pdb'), 'must be excluded')
    $fixtureCommandsRoot = Join-Path $preparedAddin 'Commands'
    $fixtureCommandSetRoot = Join-Path $fixtureCommandsRoot 'revAgentCommandSet'
    $fixtureCommandSetVersionRoot = Join-Path $fixtureCommandSetRoot '2022'
    [void](New-Item -ItemType Directory -Path $fixtureCommandSetVersionRoot)
    $fixtureDescriptor = [ordered]@{
        name = 'revAgentCommandSet'
        developer = [ordered]@{ name = 'DPE'; email = ''; website = 'https://www.revagent.app'; organization = 'DPE' }
        commands = @([ordered]@{ commandName = 'fixture_command'; description = 'Generated packaging fixture'; assemblyPath = 'revAgentCommandSet.dll' })
    }
    $fixtureRegistry = [ordered]@{ Commands = @([ordered]@{
        commandName = 'fixture_command'; assemblyPath = 'revAgentCommandSet\\2022\\revAgentCommandSet.dll'
        enabled = $true; supportedRevitVersions = @('2022'); developer = $fixtureDescriptor.developer
        description = 'Generated packaging fixture'
    }) }
    [IO.File]::WriteAllText((Join-Path $fixtureCommandSetRoot 'command.json'), (($fixtureDescriptor | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixtureCommandsRoot 'commandRegistry.json'), (($fixtureRegistry | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllBytes((Join-Path $fixtureCommandSetVersionRoot 'revAgentCommandSet.dll'), [Text.Encoding]::UTF8.GetBytes('generated command-set fixture'))

    & $DotnetPath restore (Join-Path $RepoRoot 'packages\bridge\src\RevAgent.Bridge.ReleaseSigner\RevAgent.Bridge.ReleaseSigner.csproj') --locked-mode
    if ($LASTEXITCODE -ne 0) { throw 'Signer locked restore failed.' }
    $common = @{
        ReleaseId = '30000000-0000-4000-8000-000000000001'; Version = '3.0.0'; ReleaseSequence = 42
        Channel = 'pilot'; RolloutPercent = 100; MinSupportedVersion = '2.0.0'; Notes = 'generated-key parity fixture'
        GatewayBaseUrl = 'https://gateway.example.test'; KeyId = 'generated-p3t12'; PrivateKeyPath = $privatePath
        TrustedKeysPath = $trustedPath; CreatedAtUtc = '2026-09-07T12:34:56.0000000Z'
        Repository = 'BTankut/revAgent'; HeadSha = ('a' * 40); HeadTree = ('b' * 40); RepoRoot = $RepoRoot
        DotnetPath = $DotnetPath; PreparedBridgeDirectory = $preparedBridge; PreparedAddinDirectory = (Split-Path (Split-Path $preparedAddin))
        FixturePreparedPayload = $true
    }
    foreach ($missingCase in @(
            [ordered]@{ Name = 'registry'; Relative = '2022\revAgentPlugin\Commands\commandRegistry.json' },
            [ordered]@{ Name = 'descriptor'; Relative = '2022\revAgentPlugin\Commands\revAgentCommandSet\command.json' },
            [ordered]@{ Name = 'dll'; Relative = '2022\revAgentPlugin\Commands\revAgentCommandSet\2022\revAgentCommandSet.dll' }
        )) {
        $negativeRoot = Join-Path $ArtifactsRoot ("missing-" + $missingCase.Name)
        $negativeAddin = Join-Path $negativeRoot 'prepared-addin'
        [void](New-Item -ItemType Directory -Path $negativeRoot)
        Copy-Item -LiteralPath (Split-Path (Split-Path $preparedAddin)) -Destination $negativeAddin -Recurse
        Remove-Item -LiteralPath (Join-Path $negativeAddin $missingCase.Relative)
        $negativeArgs = @{}
        foreach ($entry in $common.GetEnumerator()) { $negativeArgs[$entry.Key] = $entry.Value }
        $negativeArgs.PreparedAddinDirectory = $negativeAddin
        $negativeOutput = Join-Path $ArtifactsRoot ("missing-" + $missingCase.Name + '-output')
        Assert-ThrowsLike -Pattern 'Add-in command payload lacks required file' -Message "Missing $($missingCase.Name) must fail before ZIP creation or signing." -Action {
            & (Join-Path $PSScriptRoot 'build-signed-bridge-update.ps1') @negativeArgs -OutputRoot $negativeOutput | Out-Null
        }
        Assert-True (-not (Test-Path -LiteralPath $negativeOutput)) "Missing $($missingCase.Name) refusal must not publish an output root."
    }
    $first = Join-Path $ArtifactsRoot 'release-a'
    $second = Join-Path $ArtifactsRoot 'release-b'
    & (Join-Path $PSScriptRoot 'build-signed-bridge-update.ps1') @common -OutputRoot $first | Out-Null
    & (Join-Path $PSScriptRoot 'build-signed-bridge-update.ps1') @common -OutputRoot $second | Out-Null
    Assert-Equal (Get-FileHash (Join-Path $first 'bridge.zip')).Hash (Get-FileHash (Join-Path $second 'bridge.zip')).Hash 'Bridge ZIP must be deterministic.'
    Assert-Equal (Get-FileHash (Join-Path $first 'addin.zip')).Hash (Get-FileHash (Join-Path $second 'addin.zip')).Hash 'Add-in ZIP must be deterministic.'
    Add-Type -AssemblyName System.IO.Compression
    $addinArchive = [IO.Compression.ZipFile]::OpenRead((Join-Path $first 'addin.zip'))
    try {
        $entryNames = @($addinArchive.Entries.FullName)
        Assert-True ($entryNames -contains '2022/revAgentPlugin/revAgentPlugin.dll') 'Add-in replacement layout is absent.'
        Assert-True ($entryNames -contains '2022/revAgentPlugin/Commands/commandRegistry.json') 'Add-in command registry is absent.'
        Assert-True ($entryNames -contains '2022/revAgentPlugin/Commands/revAgentCommandSet/command.json') 'Add-in command descriptor is absent.'
        Assert-True ($entryNames -contains '2022/revAgentPlugin/Commands/revAgentCommandSet/2022/revAgentCommandSet.dll') 'Add-in command-set DLL is absent.'
        Assert-True (-not ($entryNames | Where-Object { $_ -match '(?i)\.(pdb|cs|ps1|psm1)$' })) 'Source/debug material entered the add-in ZIP.'
        $zippedRegistry = Read-ZipEntryText -Archive $addinArchive -EntryName '2022/revAgentPlugin/Commands/commandRegistry.json' | ConvertFrom-Json
        $zippedDescriptor = Read-ZipEntryText -Archive $addinArchive -EntryName '2022/revAgentPlugin/Commands/revAgentCommandSet/command.json' | ConvertFrom-Json
        Assert-Equal @($zippedRegistry.Commands).Count @($zippedDescriptor.commands).Count 'Registry and descriptor command counts differ.'
        foreach ($command in @($zippedDescriptor.commands)) {
            $matches = @($zippedRegistry.Commands | Where-Object { [string]$_.commandName -ceq [string]$command.commandName })
            Assert-Equal $matches.Count 1 "Registry command correspondence is invalid for '$($command.commandName)'."
            Assert-Equal ([string]$matches[0].assemblyPath) 'revAgentCommandSet\\2022\\revAgentCommandSet.dll' "Registry DLL correspondence is invalid for '$($command.commandName)'."
        }
    }
    finally { $addinArchive.Dispose() }

    $manifest = Get-Content -LiteralPath (Join-Path $first 'bridge-manifest.json') -Raw | ConvertFrom-Json -AsHashtable -DateKind String
    $signed = Get-Content -LiteralPath (Join-Path $first 'bridge-manifest.signature.json') -Raw | ConvertFrom-Json -AsHashtable -DateKind String
    $oracle = [ordered]@{
        schemaVersion = 1; app = 'revAgent'; signedObject = 'bridge-manifest'; algorithm = 'RS256'; keyId = 'generated-p3t12'
        publicKeyFingerprint = $fingerprint; canonicalization = 'RFC8785-JCS-SHA256-v1'
        contentSha256 = Get-RevAgentCanonicalJsonSha256 -Value $manifest
        createdAtUtc = '2026-09-07T12:34:56.0000000Z'; signature = ''
    }
    $oraclePayload = Get-RevAgentSignaturePayloadCanonicalJson -SignatureEnvelope $oracle
    $provider = [Security.Cryptography.RSACryptoServiceProvider]::new()
    try {
        $provider.FromXmlString($privateXml)
        $oracle.signature = [Convert]::ToBase64String($provider.SignData([Text.Encoding]::UTF8.GetBytes($oraclePayload), 'SHA256'))
    }
    finally { $provider.Dispose() }
    Assert-Equal $signed.contentSha256 $oracle.contentSha256 'Signer content digest differs from frozen oracle.'
    Assert-Equal $signed.publicKeyFingerprint $oracle.publicKeyFingerprint 'Signer fingerprint differs from frozen oracle.'
    Assert-Equal (Get-RevAgentSignaturePayloadCanonicalJson -SignatureEnvelope $signed) $oraclePayload 'Signer nine-field canonical bytes differ from frozen oracle.'
    Assert-Equal $signed.signature $oracle.signature 'Signer RS256 signature differs from frozen oracle.'

    $frozenWorkflowHash = (Get-FileHash -Algorithm SHA256 (Join-Path $RepoRoot '.github\workflows\signed-source-free-cd.yml')).Hash
    $frozenModuleHash = (Get-FileHash -Algorithm SHA256 (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1')).Hash
    Assert-Equal $frozenWorkflowHash 'E1BD3A40D103606613114CB029B865023F323F4B12232C07AE6700AEA96FCB3E' 'Frozen workflow changed.'
    Assert-Equal $frozenModuleHash 'DF8F31B60432CC26FD73345CEE143E90B4235BA2DE08779813DAEDBC8563282E' 'Frozen integrity module changed.'
    $changed = @(& git -C $RepoRoot diff --name-only 4eeccd530639a8a8f5a3ebd408964009335ea108 --)
    Assert-True (-not ($changed -contains '.github/workflows/signed-source-free-cd.yml')) 'Frozen workflow appears in changed paths.'
    Assert-True (-not ($changed -contains 'installer/lib/RevAgent.DistributionIntegrity.psm1')) 'Frozen integrity module appears in changed paths.'

    $actualHead = (& git -C $RepoRoot rev-parse HEAD | Out-String).Trim()
    $actualTree = (& git -C $RepoRoot show -s --format=%T HEAD | Out-String).Trim()
    $sourceArgs = @{}
    foreach ($entry in $common.GetEnumerator()) { $sourceArgs[$entry.Key] = $entry.Value }
    [void]$sourceArgs.Remove('PreparedBridgeDirectory')
    [void]$sourceArgs.Remove('PreparedAddinDirectory')
    [void]$sourceArgs.Remove('FixturePreparedPayload')
    $sourceArgs.HeadSha = '0' * 40
    $sourceArgs.HeadTree = $actualTree
    Assert-ThrowsLike -Pattern 'does not match the actual Git HEAD and tree' -Message 'Wrong HEAD SHA must fail before build/sign.' -Action {
        & (Join-Path $PSScriptRoot 'build-signed-bridge-update.ps1') @sourceArgs -OutputRoot (Join-Path $ArtifactsRoot 'wrong-head') | Out-Null
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $ArtifactsRoot 'wrong-head'))) 'Wrong HEAD refusal must precede staging output.'
    $sourceArgs.HeadSha = $actualHead
    $sourceArgs.HeadTree = '0' * 40
    Assert-ThrowsLike -Pattern 'does not match the actual Git HEAD and tree' -Message 'Wrong tree must fail before build/sign.' -Action {
        & (Join-Path $PSScriptRoot 'build-signed-bridge-update.ps1') @sourceArgs -OutputRoot (Join-Path $ArtifactsRoot 'wrong-tree') | Out-Null
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $ArtifactsRoot 'wrong-tree'))) 'Wrong tree refusal must precede staging output.'
    $sourceArgs.HeadTree = $actualTree
    $trackedFixture = Join-Path $RepoRoot 'packages\bridge\test-fixtures\signing\p3t12\README.md'
    $trackedFixtureBytes = [IO.File]::ReadAllBytes($trackedFixture)
    try {
        [IO.File]::AppendAllText($trackedFixture, "`ntracked-dirty-provenance-negative", [Text.UTF8Encoding]::new($false))
        Assert-ThrowsLike -Pattern 'tracked-clean Git worktree' -Message 'Tracked-dirty source must fail before build/sign.' -Action {
            & (Join-Path $PSScriptRoot 'build-signed-bridge-update.ps1') @sourceArgs -OutputRoot (Join-Path $ArtifactsRoot 'tracked-dirty') | Out-Null
        }
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $ArtifactsRoot 'tracked-dirty'))) 'Tracked-dirty refusal must precede staging output.'
    }
    finally { [IO.File]::WriteAllBytes($trackedFixture, $trackedFixtureBytes) }

    $workflowText = Get-Content -LiteralPath (Join-Path $RepoRoot '.github\workflows\bridge-cd.yml') -Raw
    Assert-True ($workflowText -match "(?s)production-import:\s+name: Gateway-host immutable import\s+if: >-\s+github\.event_name == 'workflow_dispatch' &&\s+github\.ref == 'refs/heads/main' &&\s+inputs\.publish_release == true &&\s+inputs\.publish_confirmation == 'PUBLISH_BRIDGE_UPDATE'") 'Production import must require protected main at the job boundary.'
    function Test-ImportAdmission([string]$EventName, [string]$Ref, [bool]$Publish, [string]$Confirmation) {
        return $EventName -eq 'workflow_dispatch' -and $Ref -eq 'refs/heads/main' -and $Publish -and $Confirmation -eq 'PUBLISH_BRIDGE_UPDATE'
    }
    Assert-True (-not (Test-ImportAdmission 'workflow_dispatch' 'refs/heads/topic' $true 'PUBLISH_BRIDGE_UPDATE')) 'Branch dispatch must skip production import.'
    Assert-True (Test-ImportAdmission 'workflow_dispatch' 'refs/heads/main' $true 'PUBLISH_BRIDGE_UPDATE') 'Main dispatch with existing controls must admit production import.'
    $privateText = Get-Content -LiteralPath $privatePath -Raw
    foreach ($releaseRoot in @($first, $second)) {
        foreach ($file in Get-ChildItem -LiteralPath $releaseRoot -File -Recurse) {
            $text = if ($file.Extension -in @('.json', '.txt', '.md')) { Get-Content -LiteralPath $file.FullName -Raw } else { '' }
            Assert-True (-not $text.Contains($privateText)) "Private key material entered release payload $($file.Name)."
        }
    }
    [ordered]@{
        success = $true; tests = 33; signerOracleParity = $true; deterministicPackages = $true
        commandPayloadShape = $true; missingCommandPayloadFailsClosed = $true
        bridgeSha256 = (Get-FileHash (Join-Path $first 'bridge.zip')).Hash.ToLowerInvariant()
        addinSha256 = (Get-FileHash (Join-Path $first 'addin.zip')).Hash.ToLowerInvariant()
        frozenWorkflowSha256 = $frozenWorkflowHash; frozenIntegrityModuleSha256 = $frozenModuleHash
    } | ConvertTo-Json -Compress
}
finally {
    if ($privatePath -and (Test-Path -LiteralPath $privatePath -PathType Leaf)) {
        $ownedPrivatePath = [IO.Path]::GetFullPath($privatePath)
        if (-not $ownedPrivatePath.StartsWith($ArtifactsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove generated private key outside focused artifacts: $ownedPrivatePath"
        }
        Remove-Item -LiteralPath $ownedPrivatePath -Force
    }
    $rsa.Dispose()
}
