---
name: revit-mcp
description: >
  MEP tesisat mühendisliği için Revit API otomasyon uzmanı. Bu skill'i şu durumlarda kullan:
  kullanıcı Revit'te kanal, boru, armatür, vana, damper, sprinkler, difüzör, klima santrali,
  fan veya herhangi bir mekanik/tesisat elemanıyla ilgili kod yazmak istediğinde; HVAC,
  pis su, temiz su, yağmur suyu drenajı, sulu söndürme, yangın dolabı, yangın basınçlandırma
  veya duman kanal sistemleri üzerinde işlem yapmak istediğinde; metraj (BOQ), basınç kaybı,
  kritik hat hesabı veya sistem debisi gibi mühendislik hesapları yapmak istediğinde;
  mcp_revit-mcp_send_code_to_revit aracını kullanmak istediğinde.
  Kullanıcı "kanal metrajı", "boru listesi", "sprinkler sayısı", "basınç kaybı hesapla",
  "yağmur tesisatı", "difüzör sayısı", "BOQ çıkar" gibi şeyler söylediğinde de devreye gir.
---

# Revit MCP — Mekanik Tesisat API Uzmanı

Revit MCP üzerinden çalışan MEP otomasyon uzmanısın.
Kapsam: HVAC kanalları, pis su, temiz su, yağmur suyu drenajı, sulu söndürme (sprinkler),
yangın dolabı, yangın basınçlandırma ve duman kanal sistemleri.
Mimari veya yapısal elemanlara müdahale edilmez.

Tüm kodlar `mcp_revit-mcp_send_code_to_revit` aracıyla Revit'e gönderilir.

---

## 1. Çalışma Ortamı — Kesin Kurallar

MCP sunucusu C# kodunu `Microsoft.CSharp.CSharpCodeProvider` ile dinamik derler.
Kod şu metodun **gövdesine** enjekte edilir:

```csharp
public object Execute(UIApplication uiApp, JArray parameters)
{
    Document doc = uiApp.ActiveUIDocument.Document;
    // ← SENIN KODUN BURAYA GELİR
    return null;
}
```

- Sadece **Execute gövdesini** yaz — `class`, `namespace`, `method` tanımlama
- `uiApp`, `doc`, `parameters` zaten tanımlı — tekrar tanımlama
- Kod mutlaka `return` ile bitmeli

---

## 2. C# Derleyici Kısıtlamaları (C# 5.0/6.0 Modu)

| ❌ KULLANMA | ✅ KULLAN |
|---|---|
| `$"Uzunluk: {len} m"` | `string.Format("Uzunluk: {0} m", len)` |
| `List<Element>` | `System.Collections.Generic.List<Element>` |
| `Dictionary<string,int>` | `System.Collections.Generic.Dictionary<string, int>` |
| `Duct d = ...` kısa yol | `Autodesk.Revit.DB.Mechanical.Duct d = ...` |
| `Pipe p = ...` kısa yol | `Autodesk.Revit.DB.Plumbing.Pipe p = ...` |
| `fi.Level` | `doc.GetElement(fi.LevelId)` |
| `?.` null-conditional | Açık `if (x != null)` kontrolü |

---

## 3. MEP Sınıfları — Gerçek API Durumu

### Derleyen Sınıflar ✅
```
Autodesk.Revit.DB.Mechanical.Duct        → Kanal segmenti
Autodesk.Revit.DB.Mechanical.FlexDuct   → Esnek kanal
Autodesk.Revit.DB.Plumbing.Pipe         → Boru segmenti
Autodesk.Revit.DB.Plumbing.FlexPipe     → Esnek boru
```

### Derlemeyen Sınıflar ❌ — Kategori ile Kullan
```
DuctFitting    → OfCategory(BuiltInCategory.OST_DuctFitting)  + FamilyInstance
DuctAccessory  → OfCategory(BuiltInCategory.OST_DuctAccessory)+ FamilyInstance
PipeFitting    → OfCategory(BuiltInCategory.OST_PipeFitting)  + FamilyInstance
PipeAccessory  → OfCategory(BuiltInCategory.OST_PipeAccessory)+ FamilyInstance
```

---

## 4. FilteredElementCollector Desenleri

```csharp
// Tüm kanallar:
new FilteredElementCollector(doc)
    .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
    .WhereElementIsNotElementType()

// Aktif görünümdeki kanallar:
new FilteredElementCollector(doc, doc.ActiveView.Id)
    .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
    .WhereElementIsNotElementType()

// Tüm borular:
new FilteredElementCollector(doc)
    .OfClass(typeof(Autodesk.Revit.DB.Plumbing.Pipe))
    .WhereElementIsNotElementType()

// Kanal armatürleri (dirsek, T, kaplin, redüksiyon):
new FilteredElementCollector(doc)
    .OfCategory(BuiltInCategory.OST_DuctFitting)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType()

// Kanal aksesuarları (damper, yangın damperi, sessizleştirici):
new FilteredElementCollector(doc)
    .OfCategory(BuiltInCategory.OST_DuctAccessory)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType()

// Boru armatürleri:
new FilteredElementCollector(doc)
    .OfCategory(BuiltInCategory.OST_PipeFitting)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType()

// Boru aksesuarları (vana, check valf, süzgeç):
new FilteredElementCollector(doc)
    .OfCategory(BuiltInCategory.OST_PipeAccessory)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType()

// Sprinkler başlıkları:
new FilteredElementCollector(doc)
    .OfCategory(BuiltInCategory.OST_Sprinklers)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType()

// Hava terminalleri (difüzör, menfez, anemostat):
new FilteredElementCollector(doc)
    .OfCategory(BuiltInCategory.OST_DuctTerminal)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType()

// Mekanik ekipman (KSK, pompa, fan, yangın dolabı):
new FilteredElementCollector(doc)
    .OfCategory(BuiltInCategory.OST_MechanicalEquipment)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType()
```

`.WhereElementIsNotElementType()` — **her zaman** ekle.

---

## 5. Parametre Okuma Yöntemi

### Kanal (Duct) — LookupParameter Kullan
Kanal BuiltInParameter'larının büyük çoğunluğu dinamik derleyicide derlemiyor.
**Her zaman `LookupParameter(name)` kullan:**

| Parametre | LookupParameter Adı | Birim (raw) |
|---|---|---|
| Yuvarlak çap | `"Diameter"` | feet → mm |
| Dikdörtgen genişlik | `"Width"` | feet → mm |
| Dikdörtgen yükseklik | `"Height"` | feet → mm |
| Uzunluk | `"Length"` | feet → m |
| Hava debisi | `"Flow"` | ft³/s → m³/h |
| Hava hızı | `"Velocity"` | ft/s → m/s |
| Sürtünme kaybı | `"Friction"` | internal → Pa/m |
| Basınç kaybı | `"Pressure Drop"` | internal → Pa |
| İzolasyon kalınlığı | `"Insulation Thickness"` | feet → mm |
| Sistem tipi adı | `"System Type"` | string |
| Sistem sınıfı | `"System Classification"` | string (ör: "Supply Air") |
| Sistem adı | `"System Name"` | string |
| Boyut etiketi | `"Size"` | string (ör: "Φ200", "400x200") |
| Alan | `"Area"` | ft² → m² |
| Kat | `"Level"` | string |

### Boru (Pipe) — BuiltInParameter Kullan
Boru parametreleri için BuiltInParameter çalışıyor:

| Parametre | BuiltInParameter | Birim (raw) |
|---|---|---|
| Dış çap | `RBS_PIPE_OUTER_DIAMETER` | feet → mm |
| İç çap | `RBS_PIPE_INNER_DIAM_PARAM` | feet → mm |
| Nominal çap | `RBS_PIPE_DIAMETER_PARAM` | feet → mm |
| Debi | `RBS_PIPE_FLOW_PARAM` | ft³/s → L/s |
| Hız | `RBS_VELOCITY` | ft/s → m/s |
| Sürtünme | `RBS_FRICTION` | internal → Pa/m |
| Sistem adı | `RBS_SYSTEM_NAME_PARAM` | string |
| Uzunluk | `CURVE_ELEM_LENGTH` | feet → m |
| Basınç kaybı | `RBS_PRESSURE_DROP` | internal → Pa |
| İzolasyon | `RBS_REFERENCE_INSULATION_THICKNESS` | feet → mm |

**Derlemeyen boru BIP'leri → LookupParameter kullan:**
- `RBS_PIPE_SLOPE_PARAM` ❌ → `LookupParameter("Slope")`
- `RBS_SYSTEM_TYPE_PARAM` ❌ → `LookupParameter("System Type")`

### FamilyInstance (Armatür, Difüzör, Sprinkler vb.)
```csharp
// LookupParameter ile tüm parametreler:
Parameter p = fi.LookupParameter("System Type");
if (p != null && p.HasValue) string val = p.AsValueString();

// Kat bilgisi — fi.Level DERLEMIYOR, şöyle kullan:
ElementId lvlId = fi.LevelId;
string levelName = (lvlId != null && lvlId != ElementId.InvalidElementId && doc.GetElement(lvlId) != null)
    ? doc.GetElement(lvlId).Name : "N/A";
// VEYA:
Parameter lvlP = fi.LookupParameter("Level");
string levelName = (lvlP != null && lvlP.HasValue) ? lvlP.AsValueString() : "N/A";
```

---

## 6. Birim Dönüşümleri (Revit 2022+ — Canlı Doğrulanmış)

`DisplayUnitType` deprecated — **sadece `UnitTypeId`** kullan:

```csharp
// Uzunluk: feet → mm
double mm = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Millimeters);

// Uzunluk: feet → m
double m = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Meters);

// Hava debisi: ft³/s → m³/h
double m3h = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.CubicMetersPerHour);

// Hava debisi: ft³/s → L/s
double lps = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.LitersPerSecond);

// Hız: ft/s → m/s
double ms = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.MetersPerSecond);

// Sürtünme kaybı → Pa/m
double pam = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.PascalsPerMeter);

// Basınç → Pa
double pa = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Pascals);

// Girdi (mm → feet, set ederken):
double ft = UnitUtils.ConvertToInternalUnits(200.0, UnitTypeId.Millimeters);
```

**Doğrulanmış örnekler (bu modelden):**
- Diameter raw=0.6562 ft → 200.0 mm ✅
- Flow raw=3.9239 ft³/s → 400.0 m³/h ✅
- Velocity raw=11.6036 ft/s → 3.54 m/s ✅
- Friction raw=0.0808 → 0.8692 Pa/m ✅

---

## 7. Transaction (Model Değişikliği)

```csharp
using (Transaction t = new Transaction(doc, "Islem Adi"))
{
    t.Start();
    // ... değişiklik ...
    t.Commit();
}
```

---

## 8. Hata Yönetimi — Her Zaman Kullan

```csharp
try
{
    // ... ana mantık ...
    return "Sonuc";
}
catch (Exception ex)
{
    return "HATA: " + ex.ToString();
}
```

---

## 9. Sistem Sınıflandırması

`LookupParameter("System Classification")` değerleri (Revit standart):

| Tesisat | System Classification |
|---|---|
| Besleme havası (HVAC) | `"Supply Air"` |
| Dönüş havası | `"Return Air"` |
| Egzoz / Duman | `"Exhaust Air"` |
| Diğer hava | `"Other Air"` |

`LookupParameter("System Type")` → proje özelinde tanımlanmış sistem tipi adını verir (ör: "120_V_ETA_В_ADSK_М_Вытяжка").
`LookupParameter("System Name")` → sistem örneği adını verir (ör: "AHU-COF-DE-1-R").

Boru sistemleri için `LookupParameter("System Type").AsValueString()` tipik değerleri:
`"Domestic Cold Water"`, `"Domestic Hot Water"`, `"Sanitary"`, `"Storm"`, `"Fire Protection"`, `"Hydronic Supply"`, `"Hydronic Return"`

---

## 10. Mühendislik Hesabı Desenleri

### 10.1 BOQ — Kanal Sistemi + Boyut Bazlı Metraj

```csharp
try
{
    System.Collections.Generic.Dictionary<string, double> boq =
        new System.Collections.Generic.Dictionary<string, double>();

    FilteredElementCollector col = new FilteredElementCollector(doc)
        .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Mechanical.Duct duct = elem as Autodesk.Revit.DB.Mechanical.Duct;
        if (duct == null) continue;

        Parameter lenP  = duct.LookupParameter("Length");
        Parameter sysP  = duct.LookupParameter("System Classification");
        Parameter sizeP = duct.LookupParameter("Size");

        if (lenP == null || !lenP.HasValue) continue;

        string sys  = (sysP  != null && sysP.HasValue)  ? sysP.AsValueString()  : "?";
        string size = (sizeP != null && sizeP.HasValue)  ? sizeP.AsValueString() : "?";
        double lenM = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        string key = string.Format("{0} | {1}", sys, size);
        if (!boq.ContainsKey(key)) boq[key] = 0.0;
        boq[key] += lenM;
    }

    System.Collections.Generic.List<string> lines =
        new System.Collections.Generic.List<string>();
    lines.Add("SİSTEM | BOYUT | UZUNLUK (m)");
    lines.Add(new string('-', 50));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in boq)
        lines.Add(string.Format("{0} -> {1:F2} m", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex) { return "HATA: " + ex.ToString(); }
```

### 10.2 BOQ — Boru Sistemi + Çap Bazlı Metraj

```csharp
try
{
    System.Collections.Generic.Dictionary<string, double> boq =
        new System.Collections.Generic.Dictionary<string, double>();

    FilteredElementCollector col = new FilteredElementCollector(doc)
        .OfClass(typeof(Autodesk.Revit.DB.Plumbing.Pipe))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Plumbing.Pipe pipe = elem as Autodesk.Revit.DB.Plumbing.Pipe;
        if (pipe == null) continue;

        Parameter lenP  = pipe.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        Parameter diamP = pipe.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
        Parameter sysP  = pipe.LookupParameter("System Type");

        if (lenP == null || !lenP.HasValue) continue;

        string sys   = (sysP  != null && sysP.HasValue)  ? sysP.AsValueString()  : "?";
        double diamMm = (diamP != null && diamP.HasValue)
            ? UnitUtils.ConvertFromInternalUnits(diamP.AsDouble(), UnitTypeId.Millimeters) : 0;
        double lenM   = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        string key = string.Format("{0} | DN{1:F0}", sys, diamMm);
        if (!boq.ContainsKey(key)) boq[key] = 0.0;
        boq[key] += lenM;
    }

    System.Collections.Generic.List<string> lines =
        new System.Collections.Generic.List<string>();
    lines.Add("SİSTEM | CAP | UZUNLUK (m)");
    lines.Add(new string('-', 50));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in boq)
        lines.Add(string.Format("{0} -> {1:F2} m", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex) { return "HATA: " + ex.ToString(); }
```

### 10.3 Basınç Kaybı — Kanal Sistemi Bazında

```csharp
try
{
    System.Collections.Generic.Dictionary<string, double> sysPa =
        new System.Collections.Generic.Dictionary<string, double>();
    System.Collections.Generic.Dictionary<string, int> sysCnt =
        new System.Collections.Generic.Dictionary<string, int>();

    FilteredElementCollector col = new FilteredElementCollector(doc)
        .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Mechanical.Duct duct = elem as Autodesk.Revit.DB.Mechanical.Duct;
        if (duct == null) continue;

        Parameter fricP = duct.LookupParameter("Friction");
        Parameter lenP  = duct.LookupParameter("Length");
        Parameter sysP  = duct.LookupParameter("System Name");

        if (fricP == null || !fricP.HasValue) continue;
        if (lenP  == null || !lenP.HasValue)  continue;

        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";
        double pam = UnitUtils.ConvertFromInternalUnits(fricP.AsDouble(), UnitTypeId.PascalsPerMeter);
        double m   = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        if (!sysPa.ContainsKey(sys))  { sysPa[sys] = 0.0; sysCnt[sys] = 0; }
        sysPa[sys]  += pam * m;
        sysCnt[sys] += 1;
    }

    System.Collections.Generic.List<string> lines =
        new System.Collections.Generic.List<string>();
    lines.Add("SİSTEM | TOPLAM BASINC KAYBI (Pa) | SEGMENT");
    lines.Add(new string('-', 60));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in sysPa)
        lines.Add(string.Format("{0} -> {1:F1} Pa ({2} seg)", kv.Key, kv.Value, sysCnt[kv.Key]));
    return string.Join("\n", lines);
}
catch (Exception ex) { return "HATA: " + ex.ToString(); }
```

### 10.4 Difüzör Sayımı — Sistem + Kat Bazlı

```csharp
try
{
    System.Collections.Generic.Dictionary<string, int> counts =
        new System.Collections.Generic.Dictionary<string, int>();

    FilteredElementCollector col = new FilteredElementCollector(doc)
        .OfCategory(BuiltInCategory.OST_DuctTerminal)
        .OfClass(typeof(FamilyInstance))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        FamilyInstance fi = elem as FamilyInstance;
        if (fi == null) continue;

        Parameter sysP = fi.LookupParameter("System Classification");
        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";

        ElementId lvlId = fi.LevelId;
        string lvl = (lvlId != null && lvlId != ElementId.InvalidElementId && doc.GetElement(lvlId) != null)
            ? doc.GetElement(lvlId).Name : "?";

        string key = string.Format("{0} | {1}", sys, lvl);
        if (!counts.ContainsKey(key)) counts[key] = 0;
        counts[key]++;
    }

    System.Collections.Generic.List<string> lines =
        new System.Collections.Generic.List<string>();
    lines.Add("SİSTEM | KAT | ADET");
    lines.Add(new string('-', 40));
    foreach (System.Collections.Generic.KeyValuePair<string, int> kv in counts)
        lines.Add(string.Format("{0}: {1} adet", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex) { return "HATA: " + ex.ToString(); }
```

---

## 11. Gönderme Öncesi Kontrol Listesi

- [ ] Sınıf/metod tanımı YOK — sadece Execute gövdesi
- [ ] `$"..."` YOK — `string.Format(...)` kullanılıyor
- [ ] `System.Collections.Generic.` tam namespace yazıldı
- [ ] Kanal: `Autodesk.Revit.DB.Mechanical.Duct` (tam yol)
- [ ] Boru: `Autodesk.Revit.DB.Plumbing.Pipe` (tam yol)
- [ ] Armatür/aksesuar: `OfCategory(OST_...)` + `OfClass(typeof(FamilyInstance))`
- [ ] Kanal parametreleri: `LookupParameter("...")` ile alınıyor (BIP değil)
- [ ] `fi.Level` YOK — `fi.LevelId` + `doc.GetElement(fi.LevelId)` kullanılıyor
- [ ] Model değişikliği varsa `Transaction` içinde
- [ ] `.WhereElementIsNotElementType()` eklendi
- [ ] `UnitTypeId.*` kullanılıyor (DisplayUnitType YOK)
- [ ] `elem.UniqueId` kullanılıyor (IntegerValue YOK)
- [ ] `try { ... } catch (Exception ex) { return "HATA: " + ex.ToString(); }` mevcut
- [ ] Kod `return` ile bitiyor
