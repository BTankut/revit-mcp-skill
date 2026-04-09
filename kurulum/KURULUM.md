# Revit MCP — Kurulum Talimatı (Claude Code)

Bu repo, Revit ile Claude Code arasında MCP bağlantısı kurmak için gereken **tüm dosyaları** içerir.
Herhangi bir dış bağlantıya veya ek indirmeye gerek yoktur.

## Gereksinimler

- Windows 10/11
- Autodesk Revit 2022 (veya 2023/2024 — ilgili adımlarda sürümü güncelle)
- Node.js v18 veya üzeri → https://nodejs.org
- Claude Code CLI → https://claude.ai/code

---

## Adım 1 — Revit Eklentisini Kur

`kurulum/revit-plugin/` klasöründeki kurulum dosyasını çalıştır:

```
revit-mcp-plugin_Setup_v1.0.1.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

> Yönetici yetkisiyle çalıştırmanı öneririz.

---

## Adım 2 — Özel DLL Dosyalarını Yerleştir

`kurulum/Custom_DLL/` klasöründeki iki dosyayı Revit eklenti dizinine kopyala:

**Revit 2022 için:**

```
SampleCommandSet.dll  →  %APPDATA%\Autodesk\Revit\Addins\2022\Commands\SampleCommandset\2022\SampleCommandSet.dll
command.json          →  %APPDATA%\Autodesk\Revit\Addins\2022\Commands\SampleCommandset\command.json
```

> Revit 2023 için `2022` → `2023`, Revit 2024 için `2022` → `2024` yap.

---

## Adım 3 — commandRegistry.json Dosyasını Güncelle

```
%APPDATA%\Autodesk\Revit\Addins\2022\Commands\commandRegistry.json
```

dosyasını aç ve `"Commands"` dizisine şu bloğu **ekle** (var olanları silme):

```json
{
  "commandName": "send_code_to_revit",
  "assemblyPath": "SampleCommandSet\\2022\\SampleCommandSet.dll",
  "enabled": true,
  "supportedRevitVersions": ["2022"],
  "developer": {
    "name": "revit-mcp",
    "email": "",
    "website": "",
    "organization": "revit-mcp"
  },
  "description": "Send C# code to Revit for execution"
}
```

> Revit 2023/2024 için `"2022"` değerlerini güncelle.

---

## Adım 4 — MCP Sunucusunu Kur

`kurulum/mcp-server/` klasörünü istediğin bir konuma kopyala (örn. `C:\Projects\revit-mcp\`):

```powershell
# mcp-server klasörünü hedef konuma kopyala
xcopy /E /I kurulum\mcp-server C:\Projects\revit-mcp

# Bağımlılıkları yükle
cd C:\Projects\revit-mcp
npm install --omit=dev
```

---

## Adım 5 — Claude Code'a MCP Sunucusunu Ekle

```bash
claude mcp add --scope user revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

Doğrulama:

```bash
claude mcp list
```

Çıktıda `revit-mcp: ... ✓ Connected` görmelisin.

---

## Adım 6 — Revit'te Bağlantıyı Aktif Et

1. Revit'i aç
2. **Add-Ins** sekmesine git
3. **MCP service switch** butonuna tıkla (bağlantıyı başlatır)

---

## Adım 7 — Skill'i Claude Code'a Yükle

Bu repodaki `SKILL.md` dosyası Claude Code için hazır bir skill içerir.
Claude Code'un skill dizinine kopyala:

```powershell
xcopy /E /I . "%USERPROFILE%\.claude\skills\revit-mcp"
```

Veya Claude Code içinden `/mcp` → skill ekle adımlarını izle.

---

## Test

Revit açıkken Claude Code'da şunu dene:

```
Revit'te aktif görünümdeki kanal sayısını söyle
```

Claude, `mcp_revit-mcp_send_code_to_revit` aracını kullanarak Revit'e bağlanacak ve cevap dönecektir.

---

## Repo İçeriği

```
revit-mcp-skill/
├── SKILL.md                          ← Claude Code skill (MEP otomasyon kuralları)
├── evals/evals.json                  ← Test senaryoları
└── kurulum/
    ├── KURULUM.md                    ← Bu dosya
    ├── revit-plugin/
    │   └── revit-mcp-plugin_Setup_v1.0.1.exe   ← Revit eklenti kurulumu
    ├── Custom_DLL/
    │   ├── SampleCommandSet.dll      ← Dinamik C# derleyici eklentisi
    │   └── command.json              ← Komut konfigürasyonu
    └── mcp-server/
        ├── build/                    ← Derlenmiş Node.js sunucusu
        ├── package.json
        └── package-lock.json
```
