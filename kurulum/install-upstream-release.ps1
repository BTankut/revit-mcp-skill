param(
    [ValidateSet("2020", "2021", "2022", "2023", "2024", "2025", "2026")]
    [string]$RevitVersion = "2022",
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Get-ReleaseMetadata {
    param([string]$RequestedTag)

    $headers = @{ "User-Agent" = "revit-mcp-skill-installer" }
    if ($RequestedTag -eq "latest") {
        return Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/mcp-servers-for-revit/mcp-servers-for-revit/releases/latest"
    }

    return Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/mcp-servers-for-revit/mcp-servers-for-revit/releases/tags/$RequestedTag"
}

function Ensure-CommandRegistry {
    param(
        [string]$CommandRoot,
        [string]$Version
    )

    $registryPath = Join-Path $CommandRoot "commandRegistry.json"
    $manifestPath = Join-Path $CommandRoot "RevitMCPCommandSet\command.json"
    if (-not (Test-Path $manifestPath)) {
        return
    }

    $needsSeed = $true
    if (Test-Path $registryPath) {
        try {
            $existing = Get-Content -Raw $registryPath | ConvertFrom-Json
            if ($existing.Commands -and $existing.Commands.Count -gt 0) {
                $needsSeed = $false
            }
        }
        catch {
            $needsSeed = $true
        }
    }

    if (-not $needsSeed) {
        return
    }

    $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
    $registry = [ordered]@{ Commands = @() }

    foreach ($cmd in $manifest.commands) {
        $registry.Commands += [ordered]@{
            commandName = $cmd.commandName
            assemblyPath = "RevitMCPCommandSet\\$Version\\RevitMCPCommandSet.dll"
            enabled = $true
            supportedRevitVersions = @($Version)
            developer = [ordered]@{
                name = $manifest.developer.name
                email = $manifest.developer.email
                website = $manifest.developer.website
                organization = $manifest.developer.organization
            }
            description = $cmd.description
        }
    }

    Write-Utf8NoBom -Path $registryPath -Content ($registry | ConvertTo-Json -Depth 6)
}

$release = Get-ReleaseMetadata -RequestedTag $Tag
$asset = $release.assets | Where-Object { $_.name -like "*Revit$RevitVersion.zip" } | Select-Object -First 1
if (-not $asset) {
    throw "Release asset not found for Revit $RevitVersion. Tag: $($release.tag_name)"
}

$addinRoot = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$RevitVersion"
New-Item -ItemType Directory -Path $addinRoot -Force | Out-Null

$tmp = Join-Path $env:TEMP ("mcp-servers-for-revit-" + [guid]::NewGuid())
$zipPath = Join-Path $tmp "release.zip"
$extractPath = Join-Path $tmp "extract"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $extractPath
    Copy-Item -Path (Join-Path $extractPath "*") -Destination $addinRoot -Recurse -Force

    $duplicateAddin = Join-Path $addinRoot "revit-mcp.addin"
    if (Test-Path $duplicateAddin) {
        $disabledPath = Join-Path $addinRoot "revit-mcp.addin.disabled-upstream-duplicate"
        if (Test-Path $disabledPath) {
            Remove-Item -LiteralPath $disabledPath -Force
        }
        Move-Item -LiteralPath $duplicateAddin -Destination $disabledPath
    }

    $commandRoot = Join-Path $addinRoot "revit_mcp_plugin\Commands"
    Ensure-CommandRegistry -CommandRoot $commandRoot -Version $RevitVersion

    Write-Host "Installed upstream release $($release.tag_name) for Revit $RevitVersion into $addinRoot"
    Write-Host "Next steps:"
    Write-Host "1. Open Revit"
    Write-Host "2. Enable commands from the Settings button in the mcp-servers-for-revit ribbon tab"
    Write-Host "3. Run: codex mcp add revit-mcp -- cmd /c npx -y mcp-server-for-revit"
}
finally {
    if (Test-Path $tmp) {
        Remove-Item -LiteralPath $tmp -Recurse -Force
    }
}