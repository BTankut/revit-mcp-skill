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
$pluginTarget = Join-Path $addinRoot "revit_mcp_plugin"
$revitInstallRoot = Join-Path ${env:ProgramFiles} "Autodesk\Revit $RevitVersion"
$customDllDir = Join-Path $PSScriptRoot "Custom_DLL"
$bundledRuntimeDir = Join-Path $customDllDir "runtime\$RevitVersion"

$runningRevit = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
if ($runningRevit) {
    throw "Close Revit before running install-self-contained.ps1. The installer replaces files under $addinRoot and cannot do that safely while Revit is running."
}

function Resolve-DependencyPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileName,
        [Parameter(Mandatory = $true)]
        [string[]]$SearchRoots
    )

    foreach ($root in $SearchRoots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root $FileName
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

New-Item -ItemType Directory -Path $addinRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ServerTarget -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $pluginSource "mcp-servers-for-revit.addin") -Destination (Join-Path $addinRoot "mcp-servers-for-revit.addin") -Force
if (Test-Path $pluginTarget) {
    Remove-Item -LiteralPath $pluginTarget -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $pluginSource "revit_mcp_plugin") -Destination $addinRoot -Recurse -Force
# Expand the bundled server contents into the target directory.
Copy-Item -Path (Join-Path $serverSource "*") -Destination $ServerTarget -Recurse -Force

# Copy Custom_DLL payload so dynamic command compilation works after install.
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

    # 3. Mirror the Roslyn runtime dependencies that the command set needs.
    $dependencySearchRoots = @(
        $bundledRuntimeDir,
        $revitInstallRoot,
        (Join-Path $revitInstallRoot "AddIns\CoordinationModel"),
        (Join-Path $revitInstallRoot "AddIns\DynamoForRevit"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319")
    )

    $requiredRuntimeFiles = @(
        "Microsoft.CodeAnalysis.dll",
        "Microsoft.CodeAnalysis.CSharp.dll",
        "System.Collections.Immutable.dll",
        "System.Memory.dll",
        "System.Reflection.Metadata.dll",
        "System.Runtime.CompilerServices.Unsafe.dll",
        "System.Text.Encoding.CodePages.dll",
        "System.Threading.Tasks.Extensions.dll",
        "System.Buffers.dll",
        "System.Numerics.Vectors.dll"
    )

    $runtimeDestinations = @($localAppCmdSet2022, $roamingCmdSet2022)
    $missingRuntimeFiles = @()

    foreach ($fileName in $requiredRuntimeFiles) {
        $sourcePath = Resolve-DependencyPath -FileName $fileName -SearchRoots $dependencySearchRoots
        if (-not $sourcePath) {
            $missingRuntimeFiles += $fileName
            continue
        }

        foreach ($destination in $runtimeDestinations) {
            Copy-Item -Path $sourcePath -Destination $destination -Force
        }
    }

    if ($missingRuntimeFiles.Count -gt 0) {
        throw ("Required Roslyn runtime files were not found for Revit {0}: {1}. " +
            "This repo expects the exact runtime set under '{2}' or a compatible Revit {0} installation. " +
            "Do not try to fix end-user installation by adding NuGet packages on the target machine. " +
            "Restore the bundled runtime set or repair/reinstall Revit {0} instead.") -f $RevitVersion, ($missingRuntimeFiles -join ", "), $bundledRuntimeDir
    }
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
