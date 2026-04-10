# Revit MCP Skill Paketi - `mcp-servers-for-revit` Uyumlu

Bu repo, eski `revit-mcp` / `SampleCommandSet` kurulum hattı yerine güncel upstream
[`mcp-servers-for-revit`](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit)
projesini baz alan bir skill ve kurulum paketi sağlar.

Repo artık eski binary paketleri dağıtmaz. Kurulum, upstream release ZIP'i ve npm üstünden
yayınlanan `mcp-server-for-revit` paketi ile yapılır.

## Bu repo ne sağlar?

- `SKILL.md`: Codex ve benzeri MCP istemcileri için Revit MEP skill'i
- `kurulum/KURULUM.md`: upstream uyumlu adım adım kurulum talimatı
- `kurulum/install-upstream-release.ps1`: uygun Revit sürümü için upstream release kurulum script'i
- `evals/evals.json`: güncel `send_code_to_revit` sözleşmesine uyarlanmış değerlendirme senaryoları

## Resmi upstream kaynakları

- Repo: `mcp-servers-for-revit/mcp-servers-for-revit`
- Releases: sürüme özel Revit ZIP paketleri
- npm: `mcp-server-for-revit`

## Gereksinimler

- Windows 10/11
- Autodesk Revit 2022 veya üzeri
- Node.js 18+
- Codex CLI veya MCP destekleyen başka bir istemci

## Hızlı başlangıç (Codex CLI)

```powershell
git clone https://github.com/BTankut/revit-mcp-skill.git
cd revit-mcp-skill
powershell -ExecutionPolicy Bypass -File .\kurulum\install-upstream-release.ps1 -RevitVersion 2022
codex mcp add revit-mcp -- cmd /c npx -y mcp-server-for-revit
```

Sonra:

1. Revit'i aç
2. `mcp-servers-for-revit` sekmesindeki `Settings` düğmesine tıkla
3. Kullanmak istediğin komutları işaretle ve `Save` de
4. Bu repo kökünü Codex skill dizinine kopyala veya `SKILL.md` içeriğini skill olarak yükle
5. Codex içinde `/skills reload` çalıştır

## Neden repo yapısı değişti?

Eski repo yapısı şu varsayımlara dayanıyordu:

- `kurulum/revit-plugin/` altındaki installer kullanılacak
- `kurulum/Custom_DLL/` altındaki `SampleCommandSet.dll` elle kopyalanacak
- `kurulum/mcp-server/` altındaki derlenmiş Node sunucusu yerel çalıştırılacak

Güncel upstream modelinde bunların hiçbiri gerekli değil:

- Revit plugin ve command set resmi release ZIP ile geliyor
- MCP server `npx -y mcp-server-for-revit` ile çalışıyor
- `send_code_to_revit` artık `document` / `parameters` sözleşmesini kullanıyor

## Repo yapısı

```text
revit-mcp-skill/
|-- README.md
|-- SKILL.md
|-- evals/
|   `-- evals.json
`-- kurulum/
    |-- KURULUM.md
    `-- install-upstream-release.ps1
```

## Not

`kurulum/install-upstream-release.ps1`, upstream release paketlerinde bugün karşılaşılabilen iki pratik sorunu da düzeltir:

- duplikat `revit-mcp.addin` dosyası
- boş gelen `commandRegistry.json`