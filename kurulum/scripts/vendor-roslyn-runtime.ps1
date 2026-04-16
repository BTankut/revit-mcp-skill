param(
    [string]$RevitVersion = "2022"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$kurulumRoot = Split-Path -Parent $scriptRoot
$runtimeRoot = Join-Path $kurulumRoot "Custom_DLL\runtime\$RevitVersion"
$tempRoot = Join-Path $env:TEMP "revit-mcp-roslyn-runtime"

$packages = @(
    @{ Id = "Microsoft.CodeAnalysis.Common"; Version = "4.8.0"; Dll = "Microsoft.CodeAnalysis.dll"; Asset = "lib/netstandard2.0/Microsoft.CodeAnalysis.dll" },
    @{ Id = "Microsoft.CodeAnalysis.CSharp"; Version = "4.8.0"; Dll = "Microsoft.CodeAnalysis.CSharp.dll"; Asset = "lib/netstandard2.0/Microsoft.CodeAnalysis.CSharp.dll" },
    @{ Id = "System.Collections.Immutable"; Version = "7.0.0"; Dll = "System.Collections.Immutable.dll"; Asset = "lib/net462/System.Collections.Immutable.dll" },
    @{ Id = "System.Memory"; Version = "4.5.5"; Dll = "System.Memory.dll"; Asset = "lib/net461/System.Memory.dll" },
    @{ Id = "System.Reflection.Metadata"; Version = "7.0.0"; Dll = "System.Reflection.Metadata.dll"; Asset = "lib/net462/System.Reflection.Metadata.dll" },
    @{ Id = "System.Runtime.CompilerServices.Unsafe"; Version = "6.0.0"; Dll = "System.Runtime.CompilerServices.Unsafe.dll"; Asset = "lib/net461/System.Runtime.CompilerServices.Unsafe.dll" },
    @{ Id = "System.Text.Encoding.CodePages"; Version = "7.0.0"; Dll = "System.Text.Encoding.CodePages.dll"; Asset = "lib/net462/System.Text.Encoding.CodePages.dll" },
    @{ Id = "System.Threading.Tasks.Extensions"; Version = "4.5.4"; Dll = "System.Threading.Tasks.Extensions.dll"; Asset = "lib/net461/System.Threading.Tasks.Extensions.dll" },
    @{ Id = "System.Buffers"; Version = "4.5.1"; Dll = "System.Buffers.dll"; Asset = "lib/net461/System.Buffers.dll" },
    @{ Id = "System.Numerics.Vectors"; Version = "4.5.0"; Dll = "System.Numerics.Vectors.dll"; Asset = "lib/net46/System.Numerics.Vectors.dll" }
)

if (Test-Path $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

foreach ($pkg in $packages) {
    $archivePath = Join-Path $tempRoot ($pkg.Id + "." + $pkg.Version + ".zip")
    $extractPath = Join-Path $tempRoot ($pkg.Id + "." + $pkg.Version)
    $packageUrl = "https://www.nuget.org/api/v2/package/{0}/{1}" -f $pkg.Id, $pkg.Version

    Invoke-WebRequest -Uri $packageUrl -OutFile $archivePath
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractPath)

    $assetPath = Join-Path $extractPath $pkg.Asset
    if (-not (Test-Path $assetPath)) {
        throw "Missing expected asset: $assetPath"
    }

    Copy-Item -LiteralPath $assetPath -Destination (Join-Path $runtimeRoot $pkg.Dll) -Force
}

Write-Host "Vendored Roslyn runtime to $runtimeRoot" -ForegroundColor Green
