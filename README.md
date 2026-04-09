# Revit MCP — Claude Code MEP Otomasyon Paketi

Revit ile Claude Code arasında MCP bağlantısı kurarak mekanik tesisat projelerini (HVAC, pis/temiz su, yangın sistemleri) doğrudan Claude üzerinden otomatize etmek için hazırlanmış, bağımsız kurulum paketidir.

## Kapsam

- HVAC kanal sistemleri (besleme, dönüş, egzoz, duman)
- Temiz su, pis su, yağmur suyu drenajı
- Sulu söndürme (sprinkler), yangın dolabı, basınçlandırma
- Metraj (BOQ), basınç kaybı ve kritik hat hesapları

## Neler Var

| Dosya | Açıklama |
|---|---|
| `SKILL.md` | Claude Code skill — MEP otomasyon kuralları ve kod şablonları |
| `kurulum/KURULUM.md` | Adım adım kurulum talimatı |
| `kurulum/revit-plugin/` | Revit MCP eklenti kurulum dosyası |
| `kurulum/Custom_DLL/` | Dinamik C# derleyici eklentisi |
| `kurulum/mcp-server/` | Derlenmiş Node.js MCP sunucusu |

## Hızlı Başlangıç

```bash
git clone https://github.com/BTankut/revit-mcp-skill.git
```

Kurulum için → [`kurulum/KURULUM.md`](kurulum/KURULUM.md)

## Gereksinimler

- Windows 10/11
- Autodesk Revit 2022+
- Node.js v18+
- Claude Code CLI
