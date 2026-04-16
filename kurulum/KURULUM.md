# Revit MCP - Self-Contained Codex Kurulumu

Bu repo, kurulum icin gereken ana payload'lari repo icinde tasir.
Harici release ZIP indirme veya `npx -y mcp-server-for-revit` akisina ihtiyac yoktur.

## Kapsam

Bu paket sunlari bundled olarak saglar:

1. Revit 2022 icin add-in payload
2. Yerel calisacak prebuilt Node.js MCP server build'i
3. Dynamic command execution icin `RevitMCPCommandSet.dll` payload'u

## Hizli yol

Kurulumu calistirmadan once Revit'i kapat.

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\install-self-contained.ps1 -RevitVersion 2022 -ServerTarget C:\Projects\revit-mcp
cd C:\Projects\revit-mcp
npm install --omit=dev
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

## Manuel kurulum

Kuruluma baslamadan once Revit kapali olmali.

### 1. Revit plugin payload'unu kopyala

Asagidaki bundled icerigi `%APPDATA%\Autodesk\Revit\Addins\2022\` altina kopyala:

```text
kurulum\revit-plugin\mcp-servers-for-revit.addin
kurulum\revit-plugin\revit_mcp_plugin\...
```

Eger ayni klasorde eski `revit-mcp.addin` varsa, cakismayi onlemek icin adini degistir:

```text
revit-mcp.addin -> revit-mcp.addin.disabled
```

### 2. Gerekirse command set'i elle onar

Repo icindeki `kurulum\Custom_DLL\` klasoru command set yedegidir.
Normal kurulumda buna gerek yoktur. Ama command registry veya command DLL bozulursa su dosyalari referans al:

```text
kurulum\Custom_DLL\RevitMCPCommandSet.dll
kurulum\Custom_DLL\command.json
```

Bu dosyalar, bundled plugin icindeki `RevitMCPCommandSet` payload'unun aynisidir.

### Roslyn bagimliligi nasil calisir?

`send_code_to_revit`, bundled `RevitMCPCommandSet.dll` icinden dinamik C# derler.

Bu repo ile kurulum yapan son kullanicinin ayri bir NuGet paketi kurmasi gerekmez.

Gerekli runtime assembly'leri sunlardir:

- `Microsoft.CodeAnalysis.dll`
- `Microsoft.CodeAnalysis.CSharp.dll`
- `System.Collections.Immutable.dll`
- `System.Memory.dll`
- `System.Reflection.Metadata.dll`
- `System.Runtime.CompilerServices.Unsafe.dll`
- `System.Text.Encoding.CodePages.dll`
- `System.Threading.Tasks.Extensions.dll`
- `System.Buffers.dll`
- `System.Numerics.Vectors.dll`

Bu repo artik exact runtime set'i su klasorde vendor eder:

- `kurulum\Custom_DLL\runtime\2022`

`install-self-contained.ps1` once bu bundled runtime set'i kullanir ve `RevitMCPCommandSet.dll` yanina mirror eder.

Gerekirse ikinci kaynak olarak yerel Revit 2022 kurulumundaki uyumlu dosyalara bakar.

Eger hedef makinede `Microsoft.CodeAnalysis` eksik hatasi aliniyorsa:

1. repo icindeki `kurulum\Custom_DLL\runtime\2022` klasorunun eksiksiz geldigini dogrula
2. installer'i tekrar calistir
3. sorun devam ederse Revit 2022 kurulumunu onar veya yeniden kur

Normal son kullanici kurulumunda deployed bundle icine NuGet paketi ekleyerek sorun cozulmeye calisilmaz.

NuGet ancak `RevitMCPCommandSet.dll` kaynaktan yeniden derleniyorsa build-time bagimliliktir.

### 3. Yerel MCP server'i kopyala

```powershell
xcopy /E /I /Y kurulum\mcp-server C:\Projects\revit-mcp
cd C:\Projects\revit-mcp
npm install --omit=dev
```

### 4. Codex CLI'a MCP server ekle

```powershell
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

Dogrulama:

```powershell
codex mcp list
```

Listede `revit-mcp` satirini gormelisin.

### 5. Skill'i Codex'e yukle

```powershell
xcopy /E /I /Y . "%USERPROFILE%\.codex\skills\revit-mcp"
```

Ardindan Codex icinde:

```text
/skills reload
```

### 6. Revit'te komutlari ac

1. Revit'i ac
2. `mcp-servers-for-revit` sekmesine git
3. `Settings` dugmesine tikla
4. Bu paket yalnizca su dort komutu icerir:
   - `get_selected_elements`
   - `get_current_view_info`
   - `get_current_view_elements`
   - `send_code_to_revit`
5. `Save` de

## Test sirasi

1. aktif gorunum bilgisi testi
2. secili eleman testi
3. aktif gorunum elemanlari testi
4. `send_code_to_revit` ile kucuk okuma snippet'i
5. gercek model sorgusu veya rapor testi

## Bu pakette ne guncellendi?

- repo tekrar self-contained dagitim modeline dondu
- plugin payload'u calisan upstream kurulumdan vendor edildi
- local MCP wrapper `transactionMode` parametresini gecirir hale getirildi
- `SKILL.md` upstream `document / parameters` sozlesmesiyle senkron tutuldu
- tum katmanlar ayni dort tool'a indirildi
- Roslyn runtime dosyalari installer tarafinda acik sekilde dogrulanip kopyalaniyor

## Sinir

Bu bundled plugin payload su an Revit 2022 icindir.
2023+ surumler icin ayni modelle ayri payload vendor etmek gerekir.
