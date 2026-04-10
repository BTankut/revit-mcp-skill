# Revit MCP - Self-Contained Codex Kurulumu

Bu repo, kurulum için gereken ana payload'ları repo içinde taşır.
Harici release ZIP indirme veya `npx -y mcp-server-for-revit` akışı kullanılmaz.

## Kapsam

Bu paket şu iki şeyi bundled olarak sağlar:

1. Revit 2022 için upstream tabanlı add-in payload'u
2. Yerel çalışacak prebuilt Node.js MCP server build'i

## Hızlı yol

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\install-self-contained.ps1 -RevitVersion 2022 -ServerTarget C:\Projects\revit-mcp
cd C:\Projects\revit-mcp
npm install --omit=dev
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

## Manuel kurulum

### 1. Revit plugin payload'unu kopyala

Aşağıdaki bundled içeriği `%APPDATA%\Autodesk\Revit\Addins\2022\` altına kopyala:

```text
kurulum\revit-plugin\mcp-servers-for-revit.addin
kurulum\revit-plugin\revit_mcp_plugin\...
```

Eğer aynı klasörde eski `revit-mcp.addin` varsa, çakışmayı önlemek için adını değiştir:

```text
revit-mcp.addin -> revit-mcp.addin.disabled
```

### 2. Gerekirse command set'i elle onar

Repo içindeki `kurulum\Custom_DLL\` klasörü command set yedeğidir.
Normal kurulumda buna gerek yoktur. Ama command registry veya command DLL bozulursa şu dosyaları referans al:

```text
kurulum\Custom_DLL\RevitMCPCommandSet.dll
kurulum\Custom_DLL\command.json
```

Bu dosyalar, bundled plugin içindeki `RevitMCPCommandSet` payload'unun aynısıdır.

### 3. Yerel MCP server'ı kopyala

```powershell
xcopy /E /I /Y kurulum\mcp-server C:\Projects\revit-mcp
cd C:\Projects\revit-mcp
npm install --omit=dev
```

### 4. Codex CLI'a MCP server ekle

```powershell
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

Doğrulama:

```powershell
codex mcp list
```

Listede `revit-mcp` satırını görmelisin.

### 5. Skill'i Codex'e yükle

```powershell
xcopy /E /I /Y . "%USERPROFILE%\.codex\skills\revit-mcp"
```

Ardından Codex içinde:

```text
/skills reload
```

### 6. Revit'te komutları aç

1. Revit'i aç
2. `mcp-servers-for-revit` sekmesine git
3. `Settings` düğmesine tıkla
4. En az şu komutları aç:
   - `say_hello`
   - `get_current_view_info`
   - `get_current_view_elements`
   - `analyze_model_statistics`
   - `send_code_to_revit`
5. `Save` de

## Test sırası

1. `hello` testi
2. aktif görünüm bilgisi testi
3. `analyze_model_statistics`
4. `send_code_to_revit` ile küçük okuma snippet'i
5. kanal metraj tablosu

## Bu pakette ne güncellendi?

- repo tekrar self-contained dağıtım modeline döndü
- plugin payload'u çalışan upstream kurulumdan vendor edildi
- local MCP wrapper `transactionMode` parametresini geçirir hale getirildi
- `SKILL.md` upstream `document / parameters` sözleşmesiyle senkron tutuldu

## Sınır

Bu bundled plugin payload şu an Revit 2022 içindir.
2023+ sürümler için aynı modelle ayrı payload vendor etmek gerekir.