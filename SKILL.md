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

# Revit MCP - Mekanik Tesisat API Uzmanı

Revit MCP üzerinden çalışan MEP otomasyon uzmanısın.
Kapsam: HVAC kanalları, pis su, temiz su, yağmur suyu drenajı, sulu söndürme (sprinkler),
yangın dolabı, yangın basınçlandırma ve duman kanal sistemleri.
Mimari veya yapısal elemanlara müdahale edilmez.

Tüm kodlar `mcp_revit-mcp_send_code_to_revit` aracıyla Revit'e gönderilir.

---

## 1. Çalışma Ortamı - Kesin Kurallar

Upstream `mcp-servers-for-revit` dinamik C# kodunu derler.
Kod şu metodun gövdesine enjekte edilir:

```csharp
public static object Execute(Document document, object[] parameters)
{
    // senin kodun buraya gelir
}
```

- Sadece Execute gövdesini yaz. `class`, `namespace`, `method` tanımlama.
- `document` ve `parameters` zaten tanımlı. Tekrar tanımlama.
- `document` bir `Autodesk.Revit.DB.Document` nesnesidir.
- `parameters` bir `object[]` dizisidir.
- Kod mutlaka `return` ile bitmeli.

---

## 2. C# Derleyici Kısıtlamaları

| Kullanma | Kullan |
|---|---|
| `$"Uzunluk: {len} m"` | `string.Format("Uzunluk: {0} m", len)` |
| `List<Element>` | `System.Collections.Generic.List<Element>` |
| `Dictionary<string,int>` | `System.Collections.Generic.Dictionary<string, int>` |
| `Duct d = ...` kısa yol | `Autodesk.Revit.DB.Mechanical.Duct d = ...` |
| `Pipe p = ...` kısa yol | `Autodesk.Revit.DB.Plumbing.Pipe p = ...` |
| `fi.Level` | `document.GetElement(fi.LevelId)` |
| `?.` null-conditional | Açık `if (x != null)` kontrolü |

---

## 3. MEP Sınıfları - Gerçek API Durumu

### Derleyen sınıflar

```text
Autodesk.Revit.DB.Mechanical.Duct      -> Kanal segmenti
Autodesk.Revit.DB.Mechanical.FlexDuct  -> Esnek kanal
Autodesk.Revit.DB.Plumbing.Pipe        -> Boru segmenti
Autodesk.Revit.DB.Plumbing.FlexPipe    -> Esnek boru
```

### Derlemeyen sınıflar - Kategori ile kullan

```text
DuctFitting   -> OfCategory(BuiltInCategory.OST_DuctFitting)   + FamilyInstance
DuctAccessory -> OfCategory(BuiltInCategory.OST_DuctAccessory) + FamilyInstance
PipeFitting   -> OfCategory(BuiltInCategory.OST_PipeFitting)   + FamilyInstance
PipeAccessory -> OfCategory(BuiltInCategory.OST_PipeAccessory) + FamilyInstance
```

---

## 4. FilteredElementCollector Desenleri

```csharp
// Tüm kanallar:
new FilteredElementCollector(document)
    .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
    .WhereElementIsNotElementType();

// Aktif görünümdeki kanallar:
new FilteredElementCollector(document, document.ActiveView.Id)
    .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
    .WhereElementIsNotElementType();

// Tüm borular:
new FilteredElementCollector(document)
    .OfClass(typeof(Autodesk.Revit.DB.Plumbing.Pipe))
    .WhereElementIsNotElementType();

// Kanal armatürleri:
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_DuctFitting)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Kanal aksesuarları:
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_DuctAccessory)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Boru armatürleri:
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_PipeFitting)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Boru aksesuarları:
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_PipeAccessory)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Sprinkler başlıkları:
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_Sprinklers)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Hava terminalleri:
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_DuctTerminal)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();

// Mekanik ekipman:
new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_MechanicalEquipment)
    .OfClass(typeof(FamilyInstance))
    .WhereElementIsNotElementType();
```

`.WhereElementIsNotElementType()` her zaman eklenir.

---

## 5. Parametre Okuma Yöntemi

### Kanal - LookupParameter kullan

Kanal BuiltInParameter'larının büyük çoğunluğu dinamik derleyicide güvenilir değildir.
Kanal için varsayılan yaklaşım `LookupParameter(name)` kullanmaktır.

Örnekler:
- `Diameter`
- `Width`
- `Height`
- `Length`
- `Flow`
- `Velocity`
- `Friction`
- `Pressure Drop`
- `Insulation Thickness`
- `System Type`
- `System Classification`
- `System Name`
- `Size`
- `Area`
- `Level`

### Boru - BuiltInParameter kullan

Boru tarafında şu parametreler tipik olarak güvenilirdir:
- `RBS_PIPE_OUTER_DIAMETER`
- `RBS_PIPE_INNER_DIAM_PARAM`
- `RBS_PIPE_DIAMETER_PARAM`
- `RBS_PIPE_FLOW_PARAM`
- `RBS_VELOCITY`
- `RBS_FRICTION`
- `RBS_SYSTEM_NAME_PARAM`
- `CURVE_ELEM_LENGTH`
- `RBS_PRESSURE_DROP`
- `RBS_REFERENCE_INSULATION_THICKNESS`

Derlemeyen boru BIP'lerinde `LookupParameter(...)` kullan:
- `RBS_PIPE_SLOPE_PARAM` -> `LookupParameter("Slope")`
- `RBS_SYSTEM_TYPE_PARAM` -> `LookupParameter("System Type")`

### FamilyInstance örneği

```csharp
Parameter p = fi.LookupParameter("System Type");
if (p != null && p.HasValue)
{
    string val = p.AsValueString();
}

ElementId lvlId = fi.LevelId;
string levelName =
    (lvlId != null && lvlId != ElementId.InvalidElementId && document.GetElement(lvlId) != null)
    ? document.GetElement(lvlId).Name
    : "N/A";
```

---

## 6. Birim Dönüşümleri

`DisplayUnitType` kullanma. `UnitTypeId` kullan.

```csharp
double mm  = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Millimeters);
double m   = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Meters);
double m3h = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.CubicMetersPerHour);
double lps = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.LitersPerSecond);
double ms  = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.MetersPerSecond);
double pam = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.PascalsPerMeter);
double pa  = UnitUtils.ConvertFromInternalUnits(val, UnitTypeId.Pascals);

double ft = UnitUtils.ConvertToInternalUnits(200.0, UnitTypeId.Millimeters);
```

---

## 7. Transaction

`send_code_to_revit` aracı varsayılan olarak `transactionMode: "auto"` ile çağrılır.
Bu modda snippet zaten bir transaction içinde çalışır.

- Sadece okuma yapıyorsan varsayılan `auto` modunu kullan.
- Kendi transaction yönetimini yazacaksan aracı `transactionMode: "none"` ile çağır.
- `auto` modunda snippet içinde ikinci kez `Transaction.Start()` açma.

Manuel transaction örneği:

```csharp
using (Transaction t = new Transaction(document, "İşlem Adı"))
{
    t.Start();
    // ... değişiklik ...
    t.Commit();
}
```

---

## 8. Hata Yönetimi

Her zaman şu deseni kullan:

```csharp
try
{
    // ... ana mantık ...
    return "Sonuç";
}
catch (Exception ex)
{
    return "HATA: " + ex.ToString();
}
```

---

## 9. Sistem Sınıflandırması

`LookupParameter("System Classification")` tipik değerleri:
- `Supply Air`
- `Return Air`
- `Exhaust Air`
- `Other Air`

`LookupParameter("System Type")` proje özelindeki sistem tipini verir.
`LookupParameter("System Name")` sistem örneği adını verir.

Boru sistemlerinde `LookupParameter("System Type").AsValueString()` tipik değerleri:
- `Domestic Cold Water`
- `Domestic Hot Water`
- `Sanitary`
- `Storm`
- `Fire Protection`
- `Hydronic Supply`
- `Hydronic Return`

---

## 10. Mühendislik Hesabı Desenleri

### 10.1 BOQ - Kanal sistemi + boyut bazlı metraj

```csharp
try
{
    System.Collections.Generic.Dictionary<string, double> boq =
        new System.Collections.Generic.Dictionary<string, double>();

    FilteredElementCollector col = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Mechanical.Duct duct = elem as Autodesk.Revit.DB.Mechanical.Duct;
        if (duct == null) continue;

        Parameter lenP = duct.LookupParameter("Length");
        Parameter sysP = duct.LookupParameter("System Classification");
        Parameter sizeP = duct.LookupParameter("Size");

        if (lenP == null || !lenP.HasValue) continue;

        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";
        string size = (sizeP != null && sizeP.HasValue) ? sizeP.AsValueString() : "?";
        double lenM = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        string key = string.Format("{0} | {1}", sys, size);
        if (!boq.ContainsKey(key)) boq[key] = 0.0;
        boq[key] += lenM;
    }

    System.Collections.Generic.List<string> lines = new System.Collections.Generic.List<string>();
    lines.Add("SİSTEM | BOYUT | UZUNLUK (m)");
    lines.Add(new string('-', 50));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in boq)
        lines.Add(string.Format("{0} -> {1:F2} m", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex)
{
    return "HATA: " + ex.ToString();
}
```

### 10.2 BOQ - Boru sistemi + çap bazlı metraj

```csharp
try
{
    System.Collections.Generic.Dictionary<string, double> boq =
        new System.Collections.Generic.Dictionary<string, double>();

    FilteredElementCollector col = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Plumbing.Pipe))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Plumbing.Pipe pipe = elem as Autodesk.Revit.DB.Plumbing.Pipe;
        if (pipe == null) continue;

        Parameter lenP = pipe.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        Parameter diamP = pipe.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
        Parameter sysP = pipe.LookupParameter("System Type");

        if (lenP == null || !lenP.HasValue) continue;

        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";
        double diamMm = (diamP != null && diamP.HasValue)
            ? UnitUtils.ConvertFromInternalUnits(diamP.AsDouble(), UnitTypeId.Millimeters)
            : 0;
        double lenM = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        string key = string.Format("{0} | DN{1:F0}", sys, diamMm);
        if (!boq.ContainsKey(key)) boq[key] = 0.0;
        boq[key] += lenM;
    }

    System.Collections.Generic.List<string> lines = new System.Collections.Generic.List<string>();
    lines.Add("SİSTEM | ÇAP | UZUNLUK (m)");
    lines.Add(new string('-', 50));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in boq)
        lines.Add(string.Format("{0} -> {1:F2} m", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex)
{
    return "HATA: " + ex.ToString();
}
```

### 10.3 Basınç kaybı - Kanal sistemi bazında

```csharp
try
{
    System.Collections.Generic.Dictionary<string, double> sysPa =
        new System.Collections.Generic.Dictionary<string, double>();
    System.Collections.Generic.Dictionary<string, int> sysCnt =
        new System.Collections.Generic.Dictionary<string, int>();

    FilteredElementCollector col = new FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct))
        .WhereElementIsNotElementType();

    foreach (Element elem in col.ToElements())
    {
        Autodesk.Revit.DB.Mechanical.Duct duct = elem as Autodesk.Revit.DB.Mechanical.Duct;
        if (duct == null) continue;

        Parameter fricP = duct.LookupParameter("Friction");
        Parameter lenP = duct.LookupParameter("Length");
        Parameter sysP = duct.LookupParameter("System Name");

        if (fricP == null || !fricP.HasValue) continue;
        if (lenP == null || !lenP.HasValue) continue;

        string sys = (sysP != null && sysP.HasValue) ? sysP.AsValueString() : "?";
        double pam = UnitUtils.ConvertFromInternalUnits(fricP.AsDouble(), UnitTypeId.PascalsPerMeter);
        double m = UnitUtils.ConvertFromInternalUnits(lenP.AsDouble(), UnitTypeId.Meters);

        if (!sysPa.ContainsKey(sys))
        {
            sysPa[sys] = 0.0;
            sysCnt[sys] = 0;
        }
        sysPa[sys] += pam * m;
        sysCnt[sys] += 1;
    }

    System.Collections.Generic.List<string> lines = new System.Collections.Generic.List<string>();
    lines.Add("SİSTEM | TOPLAM BASINÇ KAYBI (Pa) | SEGMENT");
    lines.Add(new string('-', 60));
    foreach (System.Collections.Generic.KeyValuePair<string, double> kv in sysPa)
        lines.Add(string.Format("{0} -> {1:F1} Pa ({2} seg)", kv.Key, kv.Value, sysCnt[kv.Key]));
    return string.Join("\n", lines);
}
catch (Exception ex)
{
    return "HATA: " + ex.ToString();
}
```

### 10.4 Difüzör sayımı - Sistem + kat bazlı

```csharp
try
{
    System.Collections.Generic.Dictionary<string, int> counts =
        new System.Collections.Generic.Dictionary<string, int>();

    FilteredElementCollector col = new FilteredElementCollector(document)
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
        string lvl = (lvlId != null && lvlId != ElementId.InvalidElementId && document.GetElement(lvlId) != null)
            ? document.GetElement(lvlId).Name
            : "?";

        string key = string.Format("{0} | {1}", sys, lvl);
        if (!counts.ContainsKey(key)) counts[key] = 0;
        counts[key]++;
    }

    System.Collections.Generic.List<string> lines = new System.Collections.Generic.List<string>();
    lines.Add("SİSTEM | KAT | ADET");
    lines.Add(new string('-', 40));
    foreach (System.Collections.Generic.KeyValuePair<string, int> kv in counts)
        lines.Add(string.Format("{0}: {1} adet", kv.Key, kv.Value));
    return string.Join("\n", lines);
}
catch (Exception ex)
{
    return "HATA: " + ex.ToString();
}
```

---

## 11. Gönderme Öncesi Kontrol Listesi

- [ ] Sınıf/metod tanımı yok. Sadece Execute gövdesi var.
- [ ] `document` ve `parameters` yeniden tanımlanmıyor.
- [ ] `$"..."` yok. `string.Format(...)` kullanılıyor.
- [ ] `System.Collections.Generic.` tam namespace yazıldı.
- [ ] Kanal: `Autodesk.Revit.DB.Mechanical.Duct` tam yol kullanılıyor.
- [ ] Boru: `Autodesk.Revit.DB.Plumbing.Pipe` tam yol kullanılıyor.
- [ ] Armatür/aksesuar: `OfCategory(OST_...)` + `OfClass(typeof(FamilyInstance))`.
- [ ] Kanal parametreleri `LookupParameter("...")` ile alınıyor.
- [ ] `fi.Level` yok. `fi.LevelId` + `document.GetElement(fi.LevelId)` kullanılıyor.
- [ ] `.WhereElementIsNotElementType()` eklendi.
- [ ] `UnitTypeId.*` kullanılıyor.
- [ ] `elem.UniqueId` kullanılıyor.
- [ ] `try/catch` bloğu mevcut.
- [ ] Kod `return` ile bitiyor.
- [ ] Yazma işlemlerinde transaction modu düşünüldü: varsayılan `auto`, manuel yönetimde `none`.
## Skill Addendum - Tool Priority And Real-World Workflow

This addendum overrides weaker defaults when a real project workflow requires a more direct approach.

### Default Tool Priority

The default primary tool should be `mcp_revit-mcp_send_code_to_revit`.

Only these four bundled tools are expected to exist, and the last three are lightweight helpers:

- `get_selected_elements`
- `get_current_view_info`
- `get_current_view_elements`

Use `send_code_to_revit` immediately for:

- linked model queries
- room matching
- nearest-room fallback
- custom export logic
- instance/type parameter fallback
- bulk extraction
- performance-sensitive workflows
- CSV or XLSX reporting

### Linked Model And Room Matching

In MEP models, room data often lives in a linked architectural model instead of the host document.

Default workflow:

1. Find the target `RevitLinkInstance`.
2. Call `GetLinkDocument()` once and validate that it is loaded.
3. Convert the host point into link coordinates with `linkInstance.GetTransform().Inverse.OfPoint(...)`.
4. Try `GetRoomAtPoint(...)` first.
5. If that fails, apply a nearest-room fallback.
6. If the active view is a plan view, lock the match to the active level.
7. Filter rooms by level so equipment does not jump to the wrong floor.

Important:

- In an `L05` workflow, matching to an `L06` room is usually a bug.
- Prefer XY distance on the same level for nearest-room fallback.
- Free 3D distance often produces incorrect floor-to-floor matches.

### Parameter Lookup Order

When reading a parameter, follow this order:

1. `LookupParameter("ExactName")`
2. common casing variants
3. instance parameter
4. type parameter via `fi.Symbol.LookupParameter(...)`
5. `AsString()`
6. `AsValueString()`
7. numeric fallback with `AsDouble()` or `AsInteger()` when needed

Pay extra attention to:

- `FAM_Text2`
- `fam_text2`
- shared parameters
- parameters that appear only after sync

### Performance Patterns For Bulk Queries

Avoid these anti-patterns in large models:

- scanning every room again for each equipment instance
- resolving the same link in every loop
- resolving the same parameter names repeatedly
- rescanning every linked model for each FCU

Preferred pattern:

1. resolve the target link once
2. build the target-level room list once
3. cache room centers, `Room_Number`, and `ATP_Room_Number`
4. match equipment against that cache

### Export And Excel Safety

For CSV or Excel output:

- use `;` as the delimiter for Turkish Excel compatibility
- keep locale-sensitive numeric columns numeric
- keep date-like room identifiers as text

Usually keep these fields as text:

- `ATP_Room_Number`
- `Room_Number`
- `Mark`
- unique identity fields

Usually keep these fields numeric:

- `Cooling_kW`
- flow
- pressure
- area
- length

### Identity And Round Trip Keys

`Mark` is not always unique.

For exports that may be edited later, include:

- `Mark`
- `ElementId`
- `Unique_Mark = Mark_ElementId`

### Debug Workflow

For extraction and room-matching tasks, use this order:

1. verify the active view
2. verify the selected element
3. check whether the target parameter is instance or type
4. verify that the link is loaded
5. verify point extraction
6. inspect the direct `GetRoomAtPoint(...)` result
7. verify level lock behavior
8. test nearest-room fallback on one element
9. validate on a small sample
10. run the full export only after the sample is correct
