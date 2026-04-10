# Revit MCP Skill Paketi - Self-Contained ve Upstream Uyumlu

Bu repo, Revit MCP kurulumunu repo içindeki dosyalarla yapar.
`npx`, release ZIP indirme veya ayrı bir GitHub clone akışı zorunlu değildir.
Revit plugin payload'u ve yerel MCP server build'i repo içinde vendor edilir.

## Bu repo ne sağlar?

- `SKILL.md`: Codex için Revit MEP skill'i
- `kurulum/revit-plugin/`: çalışan upstream tabanlı Revit add-in payload'u (Revit 2022)
- `kurulum/Custom_DLL/`: command set DLL + manifest yedeği
- `kurulum/mcp-server/`: prebuilt yerel Node.js MCP server
- `kurulum/install-self-contained.ps1`: bundled kurulum script'i
- `evals/evals.json`: güncel `send_code_to_revit` sözleşmesine göre eval seti

## Teknik yönelim

Repo self-contained dağıtım modelini korur, ama teknik sözleşmeyi güncel upstream çizgisine taşır:

- `send_code_to_revit` artık `Execute(Document document, object[] parameters)` beklentisine göre dokümante edilir
- bundled Revit payload, çalışan `mcp-servers-for-revit` kurulumundan vendor edilmiştir
- bundled Node wrapper, `transactionMode` alanını da geçirir
- `analyze_model_statistics` gibi yeni komutlar bundled command registry içinde yer alır

## Gereksinimler

- Windows 10/11
- Autodesk Revit 2022
- Node.js 18+
- Codex CLI

## Hızlı başlangıç

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\install-self-contained.ps1 -RevitVersion 2022 -ServerTarget C:\Projects\revit-mcp
cd C:\Projects\revit-mcp
npm install --omit=dev
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

Sonra:

1. Revit'i aç
2. `mcp-servers-for-revit` sekmesindeki `Settings` düğmesine tıkla
3. Kullanmak istediğin komutları işaretle ve `Save` de
4. Bu repo kökünü `%USERPROFILE%\.codex\skills\revit-mcp` altına kopyala
5. Codex içinde `/skills reload` çalıştır

## Repo yapısı

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

## Not

Bu repo dağıtım tarafında self-contained kalır. Yani Revit plugin payload'u ve MCP server build'i repoda bulunur.
Node bağımlılıkları yine de hedef makinede `npm install --omit=dev` ile kurulmalıdır.