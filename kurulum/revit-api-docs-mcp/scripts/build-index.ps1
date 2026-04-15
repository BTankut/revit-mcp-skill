param(
    [string]$RevitRoot = "C:\Program Files\Autodesk\Revit 2022",
    [string]$Version = "2022",
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Normalize-Whitespace {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ""
    }

    return ([regex]::Replace($Text, "\s+", " ")).Trim()
}

function Get-XmlNodeText {
    param($Node)

    if ($null -eq $Node) {
        return ""
    }

    if ($Node -is [System.Array]) {
        return Normalize-Whitespace (($Node | ForEach-Object { $_.InnerText }) -join " ")
    }

    return Normalize-Whitespace $Node.InnerText
}

function Get-FriendlyTypeName {
    param([System.Type]$Type)

    if ($Type.IsByRef) {
        return (Get-FriendlyTypeName $Type.GetElementType()) + "&"
    }

    if ($Type.IsPointer) {
        return (Get-FriendlyTypeName $Type.GetElementType()) + "*"
    }

    if ($Type.IsArray) {
        $rankSuffix = if ($Type.GetArrayRank() -eq 1) { "[]" } else { "[" + ("," * ($Type.GetArrayRank() - 1)) + "]" }
        return (Get-FriendlyTypeName $Type.GetElementType()) + $rankSuffix
    }

    if ($Type.IsGenericParameter) {
        return $Type.Name
    }

    if ($Type.IsGenericType) {
        $baseName = $Type.GetGenericTypeDefinition().FullName
        if ([string]::IsNullOrWhiteSpace($baseName)) {
            $baseName = $Type.Name
        }
        $baseName = ($baseName -replace "\+", ".") -replace '`[0-9]+$', ""
        $args = @($Type.GetGenericArguments() | ForEach-Object { Get-FriendlyTypeName $_ })
        return "$baseName<$($args -join ", ")>"
    }

    if (-not [string]::IsNullOrWhiteSpace($Type.FullName)) {
        return $Type.FullName -replace "\+", "."
    }

    return $Type.Name
}

function Get-DocTypeName {
    param([System.Type]$Type)

    if ($Type.IsByRef) {
        return (Get-DocTypeName $Type.GetElementType()) + "@"
    }

    if ($Type.IsPointer) {
        return (Get-DocTypeName $Type.GetElementType()) + "*"
    }

    if ($Type.IsArray) {
        $rankSuffix = if ($Type.GetArrayRank() -eq 1) { "[]" } else { "[" + ("," * ($Type.GetArrayRank() - 1)) + "]" }
        return (Get-DocTypeName $Type.GetElementType()) + $rankSuffix
    }

    if ($Type.IsGenericParameter) {
        if ($null -ne $Type.DeclaringMethod) {
            return '``' + $Type.GenericParameterPosition
        }
        return '`' + $Type.GenericParameterPosition
    }

    if ($Type.IsGenericType) {
        $baseName = $Type.GetGenericTypeDefinition().FullName
        if ([string]::IsNullOrWhiteSpace($baseName)) {
            $baseName = $Type.Name
        }
        $baseName = ($baseName -replace "\+", ".") -replace '`[0-9]+$', ""
        $args = @($Type.GetGenericArguments() | ForEach-Object { Get-DocTypeName $_ })
        return "$baseName{$($args -join ",")}"
    }

    if (-not [string]::IsNullOrWhiteSpace($Type.FullName)) {
        return $Type.FullName -replace "\+", "."
    }

    return $Type.Name
}

function Get-TypeDocId {
    param([System.Type]$Type)

    $typeName = if (-not [string]::IsNullOrWhiteSpace($Type.FullName)) {
        $Type.FullName
    }
    else {
        $Type.Name
    }

    return "T:" + ($typeName -replace "\+", ".")
}

function Get-MemberDocId {
    param($Member)

    $declaringType = $Member.DeclaringType.FullName -replace "\+", "."

    if ($Member -is [System.Reflection.MethodBase]) {
        $memberName = if ($Member.IsConstructor) { "#ctor" } else { $Member.Name }
        if (($Member -is [System.Reflection.MethodInfo]) -and $Member.IsGenericMethodDefinition) {
            $memberName += ('``' + $Member.GetGenericArguments().Length)
        }
        $docId = "M:$declaringType.$memberName"
        $parameters = @($Member.GetParameters() | ForEach-Object { Get-DocTypeName $_.ParameterType })
        if ($parameters.Count -gt 0) {
            $docId += "(" + ($parameters -join ",") + ")"
        }
        if (($Member -is [System.Reflection.MethodInfo]) -and ($Member.Name -eq "op_Implicit" -or $Member.Name -eq "op_Explicit")) {
            $docId += "~" + (Get-DocTypeName $Member.ReturnType)
        }
        return $docId
    }

    if ($Member -is [System.Reflection.PropertyInfo]) {
        $docId = "P:$declaringType.$($Member.Name)"
        $indexParameters = @($Member.GetIndexParameters() | ForEach-Object { Get-DocTypeName $_.ParameterType })
        if ($indexParameters.Count -gt 0) {
            $docId += "(" + ($indexParameters -join ",") + ")"
        }
        return $docId
    }

    if ($Member -is [System.Reflection.FieldInfo]) {
        return "F:$declaringType.$($Member.Name)"
    }

    if ($Member -is [System.Reflection.EventInfo]) {
        return "E:$declaringType.$($Member.Name)"
    }

    throw "Unsupported member type: $($Member.MemberType)"
}

function Get-MemberKind {
    param($Member)

    if ($Member -is [System.Reflection.MethodBase]) {
        if ($Member.IsConstructor) {
            return "constructor"
        }
        return "method"
    }

    if ($Member -is [System.Reflection.PropertyInfo]) {
        return "property"
    }

    if ($Member -is [System.Reflection.FieldInfo]) {
        return "field"
    }

    if ($Member -is [System.Reflection.EventInfo]) {
        return "event"
    }

    return $null
}

function Get-MemberSignature {
    param($Member)

    $declaringType = Get-FriendlyTypeName $Member.DeclaringType

    if ($Member -is [System.Reflection.MethodBase]) {
        $parameterParts = @()
        foreach ($parameter in $Member.GetParameters()) {
            $modifier = ""
            if ($parameter.IsOut) {
                $modifier = "out "
            }
            elseif ($parameter.ParameterType.IsByRef) {
                $modifier = "ref "
            }
            $parameterParts += "$modifier$($parameter.Name): $(Get-FriendlyTypeName $parameter.ParameterType)"
        }

        $methodName = if ($Member.IsConstructor) { $Member.DeclaringType.Name } else { $Member.Name }
        $signature = "$declaringType.$methodName(" + ($parameterParts -join ", ") + ")"
        if ($Member -is [System.Reflection.MethodInfo]) {
            $signature += " -> $(Get-FriendlyTypeName $Member.ReturnType)"
        }
        return $signature
    }

    if ($Member -is [System.Reflection.PropertyInfo]) {
        return "$declaringType.$($Member.Name): $(Get-FriendlyTypeName $Member.PropertyType)"
    }

    if ($Member -is [System.Reflection.FieldInfo]) {
        return "$declaringType.$($Member.Name): $(Get-FriendlyTypeName $Member.FieldType)"
    }

    if ($Member -is [System.Reflection.EventInfo]) {
        return "$declaringType.$($Member.Name): $(Get-FriendlyTypeName $Member.EventHandlerType)"
    }

    return "$declaringType.$($Member.Name)"
}

function Get-ParameterPayload {
    param([System.Reflection.ParameterInfo[]]$Parameters, $DocEntry)

    $parameterDocs = @{}
    if ($null -ne $DocEntry -and $null -ne $DocEntry.params) {
        foreach ($param in $DocEntry.params) {
            $parameterDocs[[string]$param.name] = Get-XmlNodeText $param
        }
    }

    $items = New-Object 'System.Collections.Generic.List[object]'
    foreach ($parameter in $Parameters) {
        $items.Add([ordered]@{
                name = $parameter.Name
                type = Get-FriendlyTypeName $parameter.ParameterType
                isOut = $parameter.IsOut
                isOptional = $parameter.IsOptional
                defaultValue = if ($parameter.IsOptional) { "$($parameter.DefaultValue)" } else { $null }
                description = if ($parameterDocs.ContainsKey($parameter.Name)) { $parameterDocs[$parameter.Name] } else { "" }
            })
    }

    return $items
}

$assemblyPairs = Get-ChildItem -LiteralPath $RevitRoot -Filter "RevitAPI*.dll" |
    ForEach-Object {
        $xmlPath = Join-Path $RevitRoot ($_.BaseName + ".xml")
        if (Test-Path -LiteralPath $xmlPath) {
            [ordered]@{
                AssemblyName = $_.BaseName
                DllPath = $_.FullName
                XmlPath = $xmlPath
            }
        }
    } |
    Where-Object { $_ -ne $null } |
    Sort-Object AssemblyName

if ($assemblyPairs.Count -eq 0) {
    throw "No RevitAPI*.dll + .xml pairs were found under $RevitRoot"
}

$xmlDocs = @{}
foreach ($pair in $assemblyPairs) {
    [xml]$xml = Get-Content -LiteralPath $pair.XmlPath
    foreach ($member in $xml.doc.members.member) {
        $xmlDocs[[string]$member.name] = $member
    }
}

$script:LoadedAssemblies = @{}

$resolveHandler = [System.ResolveEventHandler]{
    param($sender, $args)

    $assemblyName = New-Object System.Reflection.AssemblyName($args.Name)
    $alreadyLoaded = if ($script:LoadedAssemblies.ContainsKey($assemblyName.Name)) {
        $script:LoadedAssemblies[$assemblyName.Name]
    }
    else {
        [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq $assemblyName.Name } | Select-Object -First 1
    }
    if ($null -ne $alreadyLoaded) {
        return $alreadyLoaded
    }

    $candidate = Join-Path $RevitRoot ($assemblyName.Name + ".dll")
    if (Test-Path -LiteralPath $candidate) {
        $loaded = [System.Reflection.Assembly]::LoadFrom($candidate)
        $script:LoadedAssemblies[$assemblyName.Name] = $loaded
        return $loaded
    }

    return $null
}

[AppDomain]::CurrentDomain.add_AssemblyResolve($resolveHandler)

try {
    $typeRecords = New-Object 'System.Collections.Generic.List[object]'
    $memberRecords = New-Object 'System.Collections.Generic.List[object]'

    foreach ($pair in $assemblyPairs) {
        if (-not $script:LoadedAssemblies.ContainsKey($pair.AssemblyName)) {
            $script:LoadedAssemblies[$pair.AssemblyName] = [System.Reflection.Assembly]::LoadFrom($pair.DllPath)
        }
    }

    foreach ($pair in $assemblyPairs) {
        $assembly = $script:LoadedAssemblies[$pair.AssemblyName]
        $assemblyVersion = $assembly.GetName().Version.ToString()
        $types = @()
        try {
            $types = $assembly.GetExportedTypes() | Sort-Object FullName
        }
        catch [System.Reflection.ReflectionTypeLoadException] {
            $types = $_.Exception.Types | Where-Object { $_ -ne $null } | Sort-Object FullName
        }

        foreach ($type in $types) {
            $typeDocId = Get-TypeDocId $type
            $typeDoc = if ($xmlDocs.ContainsKey($typeDocId)) { $xmlDocs[$typeDocId] } else { $null }
            $typeRecords.Add([ordered]@{
                    id = $typeDocId
                    name = ($type.Name -replace '`[0-9]+$', "")
                    fullName = ($type.FullName -replace "\+", ".")
                    namespace = $type.Namespace
                    assembly = $pair.AssemblyName
                    assemblyVersion = $assemblyVersion
                    baseType = if ($null -ne $type.BaseType) { Get-FriendlyTypeName $type.BaseType } else { $null }
                    interfaces = @($type.GetInterfaces() | ForEach-Object { Get-FriendlyTypeName $_ } | Sort-Object)
                    isAbstract = $type.IsAbstract
                    isSealed = $type.IsSealed
                    isInterface = $type.IsInterface
                    isEnum = $type.IsEnum
                    isValueType = $type.IsValueType
                    summary = Get-XmlNodeText $typeDoc.summary
                    remarks = Get-XmlNodeText $typeDoc.remarks
                    since = Get-XmlNodeText $typeDoc.since
                })

            $bindingFlags = [System.Reflection.BindingFlags]"Public, Instance, Static, DeclaredOnly"
            $constructors = @($type.GetConstructors($bindingFlags))
            $methods = @($type.GetMethods($bindingFlags) | Where-Object { -not $_.IsSpecialName })
            $properties = @($type.GetProperties($bindingFlags))
            $fields = @($type.GetFields($bindingFlags) | Where-Object { -not $_.IsSpecialName })
            $events = @($type.GetEvents($bindingFlags))
            $members = @($constructors + $methods + $properties + $fields + $events)

            foreach ($member in $members) {
                $memberKind = Get-MemberKind $member
                if ([string]::IsNullOrWhiteSpace($memberKind)) {
                    continue
                }

                $memberDocId = Get-MemberDocId $member
                $docEntry = if ($xmlDocs.ContainsKey($memberDocId)) { $xmlDocs[$memberDocId] } else { $null }
                $returnsText = if ($member -is [System.Reflection.MethodInfo]) { Get-XmlNodeText $docEntry.returns } else { "" }
                $valueText = if ($member -is [System.Reflection.PropertyInfo]) { Get-XmlNodeText $docEntry.value } else { "" }
                $exceptionEntries = New-Object 'System.Collections.Generic.List[object]'
                if ($null -ne $docEntry -and $null -ne $docEntry.exception) {
                    foreach ($exception in $docEntry.exception) {
                        $exceptionEntries.Add([ordered]@{
                                cref = [string]$exception.cref
                                description = Get-XmlNodeText $exception
                            })
                    }
                }

                if ($member -is [System.Reflection.MethodBase]) {
                    $parameters = Get-ParameterPayload $member.GetParameters() $docEntry
                    $isStatic = $member.IsStatic
                }
                elseif ($member -is [System.Reflection.PropertyInfo]) {
                    $parameters = Get-ParameterPayload $member.GetIndexParameters() $docEntry
                    $getter = $member.GetGetMethod()
                    if ($null -eq $getter) {
                        $getter = $member.GetSetMethod()
                    }
                    $isStatic = if ($null -ne $getter) { $getter.IsStatic } else { $false }
                }
                elseif ($member -is [System.Reflection.FieldInfo]) {
                    $parameters = @()
                    $isStatic = $member.IsStatic
                }
                else {
                    $parameters = @()
                    $adder = $member.GetAddMethod()
                    if ($null -eq $adder) {
                        $adder = $member.GetRemoveMethod()
                    }
                    $isStatic = if ($null -ne $adder) { $adder.IsStatic } else { $false }
                }

                $memberRecords.Add([ordered]@{
                        id = $memberDocId
                        kind = $memberKind
                        name = if ($memberKind -eq "constructor") { ($type.Name -replace '`[0-9]+$', '') } else { $member.Name }
                        declaringType = ($type.FullName -replace "\+", ".")
                        namespace = $type.Namespace
                        assembly = $pair.AssemblyName
                        isStatic = $isStatic
                        signature = Get-MemberSignature $member
                        summary = Get-XmlNodeText $docEntry.summary
                        remarks = Get-XmlNodeText $docEntry.remarks
                        returns = $returnsText
                        value = $valueText
                        since = Get-XmlNodeText $docEntry.since
                        parameters = $parameters
                        exceptions = $exceptionEntries
                    })
            }
        }
    }

    $payload = [ordered]@{
        version = $Version
        sourceRoot = $RevitRoot
        builtAtUtc = [DateTime]::UtcNow.ToString("o")
        assemblies = @($assemblyPairs | ForEach-Object {
                $dllInfo = Get-Item -LiteralPath $_.DllPath
                $xmlInfo = Get-Item -LiteralPath $_.XmlPath
                [ordered]@{
                    name = $_.AssemblyName
                    dllPath = $_.DllPath
                    xmlPath = $_.XmlPath
                    dllLastWriteUtc = $dllInfo.LastWriteTimeUtc.ToString("o")
                    xmlLastWriteUtc = $xmlInfo.LastWriteTimeUtc.ToString("o")
                }
            })
        types = $typeRecords
        members = $memberRecords
    }

    $outputDir = Split-Path -Parent $OutputPath
    if (-not (Test-Path -LiteralPath $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }

    $json = $payload | ConvertTo-Json -Depth 8 -Compress
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutputPath, $json, $utf8NoBom)
    Write-Host "Revit API index written to $OutputPath"
}
finally {
    [AppDomain]::CurrentDomain.remove_AssemblyResolve($resolveHandler)
}
