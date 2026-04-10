# Revit MCP - Upstream `mcp-servers-for-revit` Kurulum Talimatı

Bu repo artık eski `SampleCommandSet` / `Custom_DLL` / yerel `mcp-server` hattını kullanmaz.
Kurulum, resmi upstream release ZIP'i ve npm paketi üzerinden yapılır.

## Gereksinimler

- Windows 10/11
- Autodesk Revit 2022, 2023, 2024, 2025 veya 2026
- Node.js 18+
- Codex CLI

## Adım 1 - Upstream release paketini kur

Repo içindeki PowerShell script'ini çalıştır:

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\install-upstream-release.ps1 -RevitVersion 2022
```

Script şu işleri yapar:

1. `mcp-servers-for-revit` projesinin en güncel release bilgisini alır
2. Seçtiğin Revit sürümüne uygun ZIP paketini indirir
3. `%APPDATA%\Autodesk\Revit\Addins\<version>\` altına açar
4. Varsa duplikat `revit-mcp.addin` dosyasını pasifleştirir
5. Varsa boş `commandRegistry.json` dosyasını `command.json` manifest'inden üretir

## Adım 2 - Revit içinde komutları etkinleştir

1. Revit'i aç
2. İlk açılışta add-in için güven uyarısı gelirse `Always Load` seç
3. Şeritte `mcp-servers-for-revit` sekmesini aç
4. `Settings` düğmesine tıkla
5. Kullanmak istediğin komutları işaretle
6. `Save` ile kaydet

Not: `say_hello`, `get_current_view_info`, `get_current_view_elements`, `analyze_model_statistics` ve `send_code_to_revit` açık olmalı.

## Adım 3 - Codex CLI tarafına MCP server ekle

```powershell
codex mcp add revit-mcp -- cmd /c npx -y mcp-server-for-revit
```

Doğrulama:

```powershell
codex mcp list
```

Listede şu satıra benzer bir kayıt görmelisin:

```text
revit-mcp    cmd    /c npx -y mcp-server-for-revit
```

## Adım 4 - Skill'i Codex'e yükle

Repo kökünü Codex skill dizinine kopyala:

```powershell
xcopy /E /I /Y . "%USERPROFILE%\.codex\skills\revit-mcp"
```

Ardından Codex içinde:

```text
/skills reload
```

## Adım 5 - Test

Önce temel bağlantıyı test et:

```text
Revit'e hello gönder.
```

Sonra okuma testi:

```text
Aktif görünüm bilgisini getir.
```

Sonra işlevsel test:

```text
Modeldeki kanal metraj tablosunu çıkar.
```

## Sorun giderme

### 1. `Duplicated AddInId`

Aynı GUID'e sahip iki `.addin` dosyası yükleniyordur.
Kurulum script'i bunu otomatik düzeltir. Yine de sürerse `%APPDATA%\Autodesk\Revit\Addins\<version>` altında birden fazla `revit-mcp*.addin` dosyası olup olmadığını kontrol et.

### 2. `Method 'say_hello' not found`

Plugin yüklenmiş ama komut registry boş kalmış olabilir.
Kurulum script'i `commandRegistry.json` dosyasını otomatik üretir. Script'i tekrar çalıştırıp Revit'i yeniden başlat.

### 3. `send_code_to_revit` içinde `doc does not exist`

Bu eski skill sözleşmesidir. Güncel upstream sözleşmesi şudur:

```csharp
public static object Execute(Document document, object[] parameters)
```

Kod içinde `document` kullan.

## Bu repoda artık ne yok?

Eski ve artık kullanılmayan içerikler repo yapısından çıkarıldı:

- `kurulum/revit-plugin/`
- `kurulum/Custom_DLL/`
- `kurulum/mcp-server/`

Bu klasörler upstream modelinde resmi kaynak değil; zamanla bayatladıkları için yanlış kurulumlara neden oluyordu.