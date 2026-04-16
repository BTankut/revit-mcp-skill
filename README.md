# Revit MCP Skill Package - Self-Contained And Upstream Aligned

This repo packages a Revit MCP skill, bundled plugin payload, and bundled local MCP server build in one place.

It is designed so the skill can be installed and used without forcing a separate upstream clone flow.

## What this repo provides

- `SKILL.md`: Codex skill instructions for Revit MEP work
- `kurulum/revit-plugin/`: bundled Revit add-in payload
- `kurulum/Custom_DLL/`: command set DLL and manifest backup
- `kurulum/mcp-server/`: bundled local MCP server build
- `kurulum/revit-api-docs-mcp/`: optional local MCP server for Revit API DLL + XML documentation search
- `kurulum/install-self-contained.ps1`: self-contained installer script
- `evals/evals.json`: eval set aligned to the current `send_code_to_revit` contract

## Technical direction

This repo stays self-contained, but keeps its execution contract aligned with current upstream Revit MCP behavior:

- `send_code_to_revit` expects code for `Execute(Document document, object[] parameters)`
- the bundled Revit payload is vendor-copied from a working upstream-compatible installation
- the bundled Node wrapper forwards `transactionMode`

## Requirements

- Windows 10 or 11
- Autodesk Revit 2022
- Node.js 18+
- Codex CLI

## Quick start

Close Revit before running the installer.

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\install-self-contained.ps1 -RevitVersion 2022 -ServerTarget C:\Projects\revit-mcp
cd C:\Projects\revit-mcp
npm install --omit=dev
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

Then:

1. Open Revit.
2. Click `Settings` in the `mcp-servers-for-revit` ribbon tab.
3. Enable the commands you want and save.
4. Copy this repo root into `%USERPROFILE%\.codex\skills\revit-mcp`.
5. Run `/skills reload` inside Codex.

## What the installer deploys

The files under `kurulum/` are source payloads kept in the repo for redistribution.
After install, the same payload is copied into the real system locations below:

- Revit add-in manifest:
  - `%APPDATA%\Autodesk\Revit\Addins\2022\mcp-servers-for-revit.addin`
- Revit add-in payload:
  - `%APPDATA%\Autodesk\Revit\Addins\2022\revit_mcp_plugin\...`
- Dynamic command payload mirror:
  - `%LOCALAPPDATA%\revit-mcp-plugin\commands\CommandSet\...`
- Local MCP server bundle:
  - the `-ServerTarget` path you chose, for example `C:\Projects\revit-mcp`

The installer removes any previous `%APPDATA%\Autodesk\Revit\Addins\2022\revit_mcp_plugin` tree before copying, so the add-in payload is not left nested under `revit_mcp_plugin\revit_mcp_plugin`.

## Roslyn dependency model

`send_code_to_revit` works through the bundled `RevitMCPCommandSet.dll`, and that DLL is already prebuilt.

End-user installation from this repo does **not** require installing a separate NuGet package.

What the command set depends on:

- `Microsoft.CodeAnalysis.dll`
- `Microsoft.CodeAnalysis.CSharp.dll`
- `System.Collections.Immutable.dll`
- `System.Memory.dll`
- `System.Reflection.Metadata.dll`
- `System.Runtime.CompilerServices.Unsafe.dll`

On a healthy Revit 2022 machine, these assemblies are already present under `C:\Program Files\Autodesk\Revit 2022\...`.

The installer now verifies that Revit 2022 provides these files and mirrors them next to `RevitMCPCommandSet.dll` in the deployed command folders.

If a target machine throws a missing `Microsoft.CodeAnalysis` or similar runtime error, treat that as a machine/install problem, not as a step where the end user should run NuGet.

NuGet is only relevant if you are rebuilding `RevitMCPCommandSet.dll` from source in a separate development project.

## Clean machine checklist

Use this order on a fresh machine:

1. Install the prerequisites:
   - Autodesk Revit 2022
   - Node.js 18+
   - Codex CLI
2. Clone or download this repo.
3. Close Revit.
4. Run the installer:

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\install-self-contained.ps1 -RevitVersion 2022 -ServerTarget C:\Projects\revit-mcp
```

5. Install Node dependencies in the deployed server target:

```powershell
cd C:\Projects\revit-mcp
npm install --omit=dev
```

6. Register the MCP server in Codex:

```powershell
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

7. Install the skill last:
   - copy this repo root to `%USERPROFILE%\.codex\skills\revit-mcp`
   - run `/skills reload`
8. Open Revit and enable the bundled commands from the `mcp-servers-for-revit` ribbon `Settings` button.
9. If the installer stops with a Roslyn runtime error, repair the Revit 2022 installation first. Do not try to fix a normal end-user install by adding NuGet packages into the deployed bundle.

Expected bundled commands:

- `send_code_to_revit`
- `get_selected_elements`
- `get_current_view_info`
- `get_current_view_elements`

## Optional Revit API docs server

This repo also includes a separate MCP server that reads the installed Revit API assemblies and XML doc files directly from the local Revit installation.

It is intentionally kept separate from the four-tool runtime server so the live Revit tool surface stays minimal.

Install it separately when you want local API lookup:

```powershell
cd .\kurulum\revit-api-docs-mcp
npm install --omit=dev
codex mcp add revit-api-docs -- node "C:\Projects\Revit MCP\kurulum\revit-api-docs-mcp\build\index.js"
```

On first query, the docs server builds a local cache from the installed `RevitAPI*.dll` and matching `RevitAPI*.xml` files under the Revit install folder.

Default cache path:

- `%LOCALAPPDATA%\revit-api-docs-mcp\cache`

Bundled docs tools:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`

## Repo layout

```text
revit-mcp-skill/
|-- README.md
|-- SKILL.md
|-- evals/
|   `-- evals.json
`-- kurulum/
    |-- KURULUM.md
    |-- install-self-contained.ps1
    |-- revit-api-docs-mcp/
    |-- revit-plugin/
    |   |-- mcp-servers-for-revit.addin
    |   `-- revit_mcp_plugin/
    |-- Custom_DLL/
    `-- mcp-server/
```

## Bundled tool surface

This package intentionally exposes exactly four tools across every layer:

- `send_code_to_revit`
- `get_selected_elements`
- `get_current_view_info`
- `get_current_view_elements`

This same four-tool set is reflected in:

- the Node MCP wrapper
- the bundled Revit command payload
- the installer-copied command registry

There are no additional tool profiles in the bundled distribution.

## Why `send_code_to_revit` stays primary

Real Revit tasks usually need:

- linked model lookup
- room matching
- nearest room fallback
- custom filtering
- type/instance parameter fallback
- bulk export
- CSV/XLSX output safety

In practice, one strong custom-code tool performs better than a large set of narrow tools.

That is why `send_code_to_revit` should remain the first-class tool in both the MCP setup and the skill.

## Skill update direction

`SKILL.md` should strongly document:

- use `send_code_to_revit` first for non-trivial tasks
- linked model and room matching workflow
- parameter lookup order
- bulk-query performance patterns
- export and Excel safety rules
- `Mark` + `ElementId` + `Unique_Mark` identity strategy
- single-element -> small sample -> full export debug flow

## Installer note

The self-contained installer also copies the `Custom_DLL` payload so dynamic code execution works after a clean install without manual DLL repair steps.

It now also mirrors the required Roslyn runtime assemblies from the local Revit 2022 installation into the deployed command folders, and it fails early if those files are missing.

The copied command manifests are kept in sync with the same four bundled tools.

## Note

This repo remains self-contained for distribution. The Revit plugin payload and MCP server build are vendored here.

Node dependencies still need to be installed on the target machine with:

```powershell
npm install --omit=dev
```
