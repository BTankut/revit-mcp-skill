# Gemini CLI - Revit MCP Otomatik Kurulum Talimatı

Merhaba Gemini! Kullanıcımız bu bilgisayara özel, dinamik C# kod çalıştırma yeteneğine sahip (`send_code_to_revit`) modifiye edilmiş bir Revit MCP sunucusu kurmak istiyor. Lütfen aşağıdaki adımları **sırasıyla ve eksiksiz** olarak yerine getir.

## 1. Resmi Revit MCP Eklentisini Kur
Aşağıdaki adresten resmi kurulum dosyasını indir ve sessiz kurulum parametreleriyle (`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`) kur. Eklentinin halihazırda güncel bir sürümü varsa, uyumlu olanı kurabilirsin:
- `Invoke-WebRequest -Uri "https://github.com/mcp-servers-for-revit/revit-mcp-plugin/releases/download/v1.0.1/revit-mcp-plugin_Setup_v1.0.1.exe" -OutFile "$env:TEMP\revit-mcp-plugin_Setup.exe"`
- `Start-Process -FilePath "$env:TEMP\revit-mcp-plugin_Setup.exe" -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -NoNewWindow`

## 2. Node.js MCP Sunucusunu Hazırla
1. Kullanıcının bilgisayarında (örneğin `~\Projects\revit-mcp` dizinine) şu repoyu klonla:
`git clone https://github.com/revit-mcp/revit-mcp.git`
2. Klonlanan dizine girip `npm install` ve ardından `npm run build` komutlarını çalıştır.

## 3. Dinamik C# Derleyicisi (Özel DLL) Entegrasyonu
Kullanıcı bu talimat dosyasının yanında `Custom_DLL` isimli bir klasör getirdi. Bu klasörün içinde bizim özel olarak derlediğimiz ve C# kodlarını Revit içinde doğrudan çalıştırabilen `SampleCommandSet.dll` ve `command.json` dosyaları var.
Bu dosyaları Revit'in eklenti dizinine kopyalamalısın. (Kullanıcının Revit sürümüne göre ilgili `202X` klasörlerini güncelle. Eğer 2022 ise aşağıdaki yolları kullan):

1. `Custom_DLL\SampleCommandSet.dll` dosyasını şu hedefe kopyala (üzerine yaz):
`%APPDATA%\Autodesk\Revit\Addins\2022\Commands\SampleCommandset\2022\SampleCommandSet.dll`

2. `Custom_DLL\command.json` dosyasını şu hedefe kopyala (üzerine yaz):
`%APPDATA%\Autodesk\Revit\Addins\2022\Commands\SampleCommandset\command.json`

## 4. commandRegistry.json Dosyasını Güncelle
Revit eklenti klasöründeki `%APPDATA%\Autodesk\Revit\Addins\2022\Commands\commandRegistry.json` dosyasını `read_file` ile oku. İçindeki `"Commands"` dizisine (array) şu yeni komutu ekle ve dosyayı güncelle (`replace` veya `write_file` kullanarak):

```json
{
  "commandName": "send_code_to_revit",
  "assemblyPath": "SampleCommandSet\\{VERSION}\\SampleCommandSet.dll",
  "enabled": true,
  "supportedRevitVersions": [
    "2022"
  ],
  "developer": {
    "name": "revit-mcp",
    "email": "",
    "website": "",
    "organization": "revit-mcp"
  },
  "description": "Send C# code to Revit for execution"
}
```

## 5. Gemini CLI'a MCP Sunucusunu Ekle
Son olarak, oluşturduğun Node.js sunucusunu kendi ayarlarına (`~/.gemini/settings.json`) ekle (veya `gemini mcp list` ile kontrol et):
```json
"mcpServers": {
  "revit-mcp": {
    "command": "node",
    "args": [
      "C:\\...tam_yol...\\Projects\\revit-mcp\\build\\index.js"
    ]
  }
}
```

**Önemli Not:** İşlem tamamlandığında kullanıcıya Revit'i açıp Eklentiler (Add-Ins) sekmesinden "MCP service switch" butonuna basarak bağlantıyı aktif etmesini söyle ve "Hello MCP" test komutunu çalıştırmak için ondan izin iste!
