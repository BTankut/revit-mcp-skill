# Revit MCP Skill Package - Self-Contained And Upstream Aligned

This repo packages a Revit MCP skill, bundled plugin payload, and bundled local MCP server build in one place.

It is designed so the skill can be installed and used without forcing a separate upstream clone flow.

## What this repo provides

- `SKILL.md`: Codex skill instructions for Revit MEP work
- `kurulum/revit-plugin/`: bundled Revit add-in payload
- `kurulum/Custom_DLL/`: command set DLL and manifest backup
- `kurulum/mcp-server/`: bundled local MCP server build
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

The copied command manifests are kept in sync with the same four bundled tools.

## Note

This repo remains self-contained for distribution. The Revit plugin payload and MCP server build are vendored here.

Node dependencies still need to be installed on the target machine with:

```powershell
npm install --omit=dev
```
