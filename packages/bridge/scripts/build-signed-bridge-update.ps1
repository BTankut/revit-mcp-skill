[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][long]$ReleaseSequence,
    [ValidateSet('stable', 'pilot')][string]$Channel = 'pilot',
    [ValidateRange(0, 100)][int]$RolloutPercent = 0,
    [Parameter(Mandatory = $true)][string]$MinSupportedVersion,
    [string]$Notes = '',
    [Parameter(Mandatory = $true)][string]$GatewayBaseUrl,
    [Parameter(Mandatory = $true)][string]$KeyId,
    [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
    [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
    [Parameter(Mandatory = $true)][string]$CreatedAtUtc,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$HeadSha,
    [Parameter(Mandatory = $true)][string]$HeadTree,
    [string]$RepoRoot = '',
    [string]$DotnetPath = 'dotnet',
    [string[]]$RevitVersions = @('2022'),
    [string]$PreparedBridgeDirectory = '',
    [string]$PreparedAddinDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if ((Test-Path -LiteralPath $OutputRoot) -or $ReleaseId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
    $Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$' -or
    $MinSupportedVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$' -or
    $ReleaseSequence -lt 1 -or $HeadSha -notmatch '^[0-9a-f]{40}$' -or $HeadTree -notmatch '^[0-9a-f]{40}$') {
    throw 'Bridge update identity, version, Git provenance, or absent output root is invalid.'
}
$gateway = [Uri]$GatewayBaseUrl
if ($gateway.Scheme -ne 'https' -or -not [string]::IsNullOrEmpty($gateway.UserInfo) -or -not [string]::IsNullOrEmpty($gateway.Fragment)) {
    throw 'GatewayBaseUrl must be an HTTPS origin without user-info or fragment.'
}
$outputParent = Split-Path -Parent $OutputRoot
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $outputParent)
}
$stage = Join-Path $outputParent ('.bridge-update-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $stage)

function Copy-SourceFreeTree {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Prepared source directory is absent: $Source" }
    [void](New-Item -ItemType Directory -Force -Path $Destination)
    foreach ($file in Get-ChildItem -LiteralPath $Source -File -Recurse | Sort-Object FullName) {
        $relative = [IO.Path]::GetRelativePath($Source, $file.FullName)
        if ($relative -match '(?i)(^|[\\/])(src|source|tests?)([\\/]|$)' -or $file.Extension -in @('.pdb', '.cs', '.ps1', '.psm1', '.sln', '.csproj')) {
            continue
        }
        $target = Join-Path $Destination $relative
        [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
        Copy-Item -LiteralPath $file.FullName -Destination $target
    }
}

function New-DeterministicZip {
    param([string]$Source, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $Source -File -Recurse | Sort-Object { [IO.Path]::GetRelativePath($Source, $_.FullName).Replace('\', '/') }) {
                $relative = [IO.Path]::GetRelativePath($Source, $file.FullName).Replace('\', '/')
                if ($relative -match '(?i)(^|/)(src|source|tests?)(/|$)' -or $file.Extension -in @('.pdb', '.cs', '.ps1', '.psm1', '.sln', '.csproj')) {
                    throw "Source/debug material reached package staging: $relative"
                }
                $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
                $input = [IO.File]::OpenRead($file.FullName)
                $output = $entry.Open()
                try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
            }
        }
        finally { $archive.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Get-Sha256Lower { param([string]$Path) return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

try {
    $bridgeStage = Join-Path $stage 'bridge-content'
    $addinStage = Join-Path $stage 'addin-content'
    if ($PreparedBridgeDirectory -and $PreparedAddinDirectory) {
        Copy-SourceFreeTree -Source ([IO.Path]::GetFullPath($PreparedBridgeDirectory)) -Destination $bridgeStage
        Copy-SourceFreeTree -Source ([IO.Path]::GetFullPath($PreparedAddinDirectory)) -Destination $addinStage
    }
    elseif ($PreparedBridgeDirectory -or $PreparedAddinDirectory) {
        throw 'Prepared bridge and add-in directories must be supplied together.'
    }
    else {
        $bridgeProject = Join-Path $RepoRoot 'packages\bridge\src\RevAgent.Bridge\RevAgent.Bridge.csproj'
        & $DotnetPath restore $bridgeProject --locked-mode
        if ($LASTEXITCODE -ne 0) { throw 'Bridge worker locked restore failed.' }
        & $DotnetPath publish $bridgeProject -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:DebugType=embedded -p:DebugSymbols=false -o $bridgeStage --no-restore
        if ($LASTEXITCODE -ne 0) { throw 'Bridge worker publish failed.' }
        foreach ($revitVersion in $RevitVersions) {
            & (Join-Path $RepoRoot 'scripts\build-revit-plugin.ps1') -RevitVersion $revitVersion -RepoRoot $RepoRoot -DotnetPath $DotnetPath -SkipPayloadCopy
            if ($LASTEXITCODE -ne 0) { throw "Revit $revitVersion add-in build failed." }
            $source = Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\bin\Release\$revitVersion"
            Copy-SourceFreeTree -Source $source -Destination (Join-Path $addinStage "$revitVersion\revAgentPlugin")
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $bridgeStage 'revagent-bridge.exe') -PathType Leaf)) { throw 'Bridge package lacks revagent-bridge.exe at its root.' }
    if (@(Get-ChildItem -LiteralPath $addinStage -File -Recurse).Count -eq 0) { throw 'Add-in package is empty.' }

    $bridgeZip = Join-Path $stage 'bridge.zip'
    $addinZip = Join-Path $stage 'addin.zip'
    New-DeterministicZip -Source $bridgeStage -Destination $bridgeZip
    New-DeterministicZip -Source $addinStage -Destination $addinZip
    Remove-Item -LiteralPath $bridgeStage, $addinStage -Recurse
    $bridgeHash = Get-Sha256Lower $bridgeZip
    $addinHash = Get-Sha256Lower $addinZip
    $base = $gateway.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
    $manifest = [ordered]@{
        schemaVersion = 1
        channel = $Channel
        version = $Version
        releaseSequence = $ReleaseSequence
        components = @(
            [ordered]@{ name = 'bridge'; version = $Version; sha256 = $bridgeHash; sizeBytes = (Get-Item -LiteralPath $bridgeZip).Length; url = "$base/bridge/update/artifact/$ReleaseId/bridge" },
            [ordered]@{ name = 'addin'; version = $Version; sha256 = $addinHash; sizeBytes = (Get-Item -LiteralPath $addinZip).Length; url = "$base/bridge/update/artifact/$ReleaseId/addin" }
        )
        rolloutPercent = $RolloutPercent
        minSupportedVersion = $MinSupportedVersion
        notes = $Notes
    }
    $manifestPath = Join-Path $stage 'bridge-manifest.json'
    [IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 20 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
    $provenance = [ordered]@{
        schemaVersion = 1
        releaseId = $ReleaseId
        repository = $Repository
        headSha = $HeadSha
        headTree = $HeadTree
        createdAtUtc = $CreatedAtUtc
        tools = [ordered]@{ dotnet = (& $DotnetPath --version); pwsh = $PSVersionTable.PSVersion.ToString() }
        components = [ordered]@{ bridge = [ordered]@{ sha256 = $bridgeHash; sizeBytes = (Get-Item $bridgeZip).Length }; addin = [ordered]@{ sha256 = $addinHash; sizeBytes = (Get-Item $addinZip).Length } }
    }
    [IO.File]::WriteAllText((Join-Path $stage 'provenance.json'), (($provenance | ConvertTo-Json -Depth 20 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
    & $DotnetPath run --project (Join-Path $RepoRoot 'packages\bridge\src\RevAgent.Bridge.ReleaseSigner\RevAgent.Bridge.ReleaseSigner.csproj') --configuration Release --no-restore -- `
        --content $manifestPath --key-id $KeyId --private-key ([IO.Path]::GetFullPath($PrivateKeyPath)) `
        --trusted-keys ([IO.Path]::GetFullPath($TrustedKeysPath)) --created-at-utc $CreatedAtUtc `
        --envelope-out (Join-Path $stage 'bridge-manifest.signature.json')
    if ($LASTEXITCODE -ne 0) { throw 'Bridge manifest signing failed.' }
    Move-Item -LiteralPath $stage -Destination $OutputRoot
    $stage = ''
    [pscustomobject][ordered]@{ success = $true; outputRoot = $OutputRoot; releaseId = $ReleaseId; bridgeSha256 = $bridgeHash; addinSha256 = $addinHash } | ConvertTo-Json -Compress
}
finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
