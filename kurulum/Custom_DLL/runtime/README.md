# Roslyn Runtime Bundle

This folder contains the exact Roslyn runtime assemblies that the bundled `RevitMCPCommandSet.dll` needs at install time.

For Revit 2022, the runtime files live under:

- `2022/`

The installer copies these files next to `RevitMCPCommandSet.dll` in both deployed command locations.

These binaries are vendored from official NuGet packages so target machines do not need to run NuGet during normal installation.

Package sources used for the 2022 bundle:

- `Microsoft.CodeAnalysis.Common` `4.8.0`
- `Microsoft.CodeAnalysis.CSharp` `4.8.0`
- `System.Collections.Immutable` `7.0.0`
- `System.Memory` `4.5.5`
- `System.Reflection.Metadata` `7.0.0`
- `System.Runtime.CompilerServices.Unsafe` `6.0.0`
- `System.Text.Encoding.CodePages` `7.0.0`
- `System.Threading.Tasks.Extensions` `4.5.4`
- `System.Buffers` `4.5.1`
- `System.Numerics.Vectors` `4.5.0`

To refresh the bundle, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\scripts\vendor-roslyn-runtime.ps1 -RevitVersion 2022
```
