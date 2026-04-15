param(
    [ValidateSet("2022")]
    [string]$RevitVersion = "2022",
    [string]$ServerTarget = "C:\Projects\revit-mcp"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginSource = Join-Path $PSScriptRoot "revit-plugin"
$serverSource = Join-Path $PSScriptRoot "mcp-server"
$addinRoot = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$RevitVersion"

New-Item -ItemType Directory -Path $addinRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ServerTarget -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $pluginSource "mcp-servers-for-revit.addin") -Destination (Join-Path $addinRoot "mcp-servers-for-revit.addin") -Force
Copy-Item -LiteralPath (Join-Path $pluginSource "revit_mcp_plugin") -Destination (Join-Path $addinRoot "revit_mcp_plugin") -Recurse -Force
# Expand the bundled server contents into the target directory.
Copy-Item -Path (Join-Path $serverSource "*") -Destination $ServerTarget -Recurse -Force

# Copy Custom_DLL payload so dynamic command compilation works after install.
$customDllDir = Join-Path $PSScriptRoot "Custom_DLL"
if (Test-Path $customDllDir) {
    # 1. LocalAppData command locations
    $localAppCmdSet2022 = Join-Path $env:LOCALAPPDATA "revit-mcp-plugin\commands\CommandSet\$RevitVersion"
    $localAppCmdSet = Join-Path $env:LOCALAPPDATA "revit-mcp-plugin\commands\CommandSet"

    New-Item -ItemType Directory -Path $localAppCmdSet2022 -Force | Out-Null

    # Copy files into LocalAppData
    Copy-Item -Path (Join-Path $customDllDir "RevitMCPCommandSet.dll") -Destination $localAppCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $localAppCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $localAppCmdSet -Force

    # 2. Mirror the same files into the Revit add-in command folders
    $roamingCmdSet2022 = Join-Path $addinRoot "revit_mcp_plugin\Commands\RevitMCPCommandSet\$RevitVersion"
    $roamingCmdSet = Join-Path $addinRoot "revit_mcp_plugin\Commands\RevitMCPCommandSet"

    New-Item -ItemType Directory -Path $roamingCmdSet2022 -Force | Out-Null
    Copy-Item -Path (Join-Path $customDllDir "RevitMCPCommandSet.dll") -Destination $roamingCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $roamingCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $roamingCmdSet -Force
}

$duplicateAddin = Join-Path $addinRoot "revit-mcp.addin"
if (Test-Path $duplicateAddin) {
    $disabled = Join-Path $addinRoot "revit-mcp.addin.disabled-self-contained"
    if (Test-Path $disabled) {
        Remove-Item -LiteralPath $disabled -Force
    }
    Move-Item -LiteralPath $duplicateAddin -Destination $disabled
}

Write-Host "Self-contained Revit MCP bundle installed for Revit $RevitVersion" -ForegroundColor Green
Write-Host "Plugin path: $addinRoot"
Write-Host "Server path: $ServerTarget"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. cd $ServerTarget"
Write-Host "2. npm install --omit=dev"
Write-Host "3. codex mcp add revit-mcp -- node `"$ServerTarget\build\index.js`""
Write-Host "4. Copy this repo to %USERPROFILE%\.codex\skills\revit-mcp and run /skills reload"
Write-Host "5. Open Revit and enable commands from the mcp-servers-for-revit ribbon Settings button"
