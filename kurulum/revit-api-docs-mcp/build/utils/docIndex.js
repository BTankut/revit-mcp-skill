import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, stat } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const INDEX_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "build-index.ps1");
const DEFAULT_REVIT_VERSION = "2022";
const INDEX_CACHE = new Map();

function parseJson(text) {
    return JSON.parse(String(text).replace(/^\uFEFF/, ""));
}

function normalize(text) {
    return String(text || "").trim().toLowerCase();
}

function uniqueBy(items, keySelector) {
    const seen = new Set();
    return items.filter((item) => {
        const key = keySelector(item);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function defaultRevitRoot(version) {
    return path.join("C:\\Program Files\\Autodesk", `Revit ${version}`);
}

async function discoverAssemblyPairs(rootPath) {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && /^RevitAPI.*\.dll$/i.test(entry.name))
        .map((entry) => {
        const dllPath = path.join(rootPath, entry.name);
        const xmlPath = path.join(rootPath, `${path.parse(entry.name).name}.xml`);
        return {
            assemblyName: path.parse(entry.name).name,
            dllPath,
            xmlPath,
        };
    })
        .filter((pair) => existsSync(pair.xmlPath))
        .sort((left, right) => left.assemblyName.localeCompare(right.assemblyName));
}

async function getConfig(options = {}) {
    const revitVersion = String(options.revitVersion || process.env.REVIT_API_DOCS_VERSION || DEFAULT_REVIT_VERSION);
    const rootPath = options.rootPath || process.env.REVIT_API_DOCS_ROOT || defaultRevitRoot(revitVersion);
    if (!existsSync(rootPath)) {
        throw new Error(`Revit API root not found: ${rootPath}`);
    }
    const assemblyPairs = await discoverAssemblyPairs(rootPath);
    if (assemblyPairs.length === 0) {
        throw new Error(`No RevitAPI*.dll + .xml pairs were found under ${rootPath}`);
    }
    const cacheDir = process.env.REVIT_API_DOCS_CACHE_DIR ||
        path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "revit-api-docs-mcp", "cache");
    const cacheFile = path.join(cacheDir, `revit-api-docs-${revitVersion}.json`);
    return {
        revitVersion,
        rootPath,
        assemblyPairs,
        cacheDir,
        cacheFile,
    };
}

async function cacheIsStale(config) {
    if (!existsSync(config.cacheFile)) {
        return true;
    }
    const cacheStats = await stat(config.cacheFile);
    for (const pair of config.assemblyPairs) {
        const dllStats = await stat(pair.dllPath);
        const xmlStats = await stat(pair.xmlPath);
        if (dllStats.mtimeMs > cacheStats.mtimeMs || xmlStats.mtimeMs > cacheStats.mtimeMs) {
            return true;
        }
    }
    return false;
}

async function runIndexBuilder(config) {
    await mkdir(config.cacheDir, { recursive: true });
    await new Promise((resolve, reject) => {
        const child = spawn("powershell", [
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            INDEX_SCRIPT,
            "-RevitRoot",
            config.rootPath,
            "-Version",
            config.revitVersion,
            "-OutputPath",
            config.cacheFile,
        ], {
            windowsHide: true,
        });
        let stderr = "";
        let stdout = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`Index build failed with exit code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        });
    });
}

function toSummaryRecord(symbol) {
    return {
        id: symbol.id,
        kind: symbol.kind || "type",
        name: symbol.name,
        fullName: symbol.fullName,
        assembly: symbol.assembly,
        namespace: symbol.namespace,
        summary: symbol.summary,
        signature: symbol.signature,
        declaringType: symbol.declaringType,
    };
}

function hydrateIndex(raw) {
    const typeById = new Map();
    const typeByFullName = new Map();
    const typesByName = new Map();
    const membersById = new Map();
    const membersByFullName = new Map();
    const membersByName = new Map();
    const membersByType = new Map();
    const namespaces = new Map();
    const searchItems = [];

    for (const type of raw.types) {
        const hydratedType = {
            ...type,
            simpleName: type.name,
        };
        typeById.set(normalize(type.id), hydratedType);
        typeByFullName.set(normalize(type.fullName), hydratedType);
        const typeList = typesByName.get(normalize(type.name)) || [];
        typeList.push(hydratedType);
        typesByName.set(normalize(type.name), typeList);
        if (!namespaces.has(type.namespace)) {
            namespaces.set(type.namespace, { name: type.namespace, types: [] });
        }
        namespaces.get(type.namespace).types.push(hydratedType);
        searchItems.push({
            id: type.id,
            kind: "type",
            name: type.name,
            fullName: type.fullName,
            assembly: type.assembly,
            namespace: type.namespace,
            summary: type.summary,
            searchText: [type.id, type.name, type.fullName, type.namespace, type.summary].join(" ").toLowerCase(),
        });
    }

    for (const member of raw.members) {
        const hydratedMember = {
            ...member,
            fullName: `${member.declaringType}.${member.name}`,
        };
        membersById.set(normalize(member.id), hydratedMember);
        const fullNameKey = normalize(hydratedMember.fullName);
        const sameFullName = membersByFullName.get(fullNameKey) || [];
        sameFullName.push(hydratedMember);
        membersByFullName.set(fullNameKey, sameFullName);
        const nameKey = normalize(hydratedMember.name);
        const sameName = membersByName.get(nameKey) || [];
        sameName.push(hydratedMember);
        membersByName.set(nameKey, sameName);
        const typeKey = normalize(hydratedMember.declaringType);
        const sameType = membersByType.get(typeKey) || [];
        sameType.push(hydratedMember);
        membersByType.set(typeKey, sameType);
        searchItems.push({
            id: member.id,
            kind: member.kind,
            name: member.name,
            fullName: hydratedMember.fullName,
            assembly: member.assembly,
            namespace: member.namespace,
            summary: member.summary,
            signature: member.signature,
            declaringType: member.declaringType,
            searchText: [member.id, member.name, hydratedMember.fullName, member.signature, member.summary, member.declaringType].join(" ").toLowerCase(),
        });
    }

    const namespaceItems = [...namespaces.values()].map((entry) => ({
        id: `N:${entry.name}`,
        kind: "namespace",
        name: entry.name.split(".").at(-1),
        fullName: entry.name,
        namespace: entry.name,
        assembly: uniqueBy(entry.types, (type) => type.assembly).map((type) => type.assembly).join(", "),
        summary: `Namespace with ${entry.types.length} public types.`,
        searchText: entry.name.toLowerCase(),
    }));

    return {
        ...raw,
        typeById,
        typeByFullName,
        typesByName,
        membersById,
        membersByFullName,
        membersByName,
        membersByType,
        namespaces,
        searchItems: [...searchItems, ...namespaceItems],
    };
}

async function loadIndex(options = {}) {
    const config = await getConfig(options);
    const cacheKey = `${config.revitVersion}|${config.rootPath}`;
    const stale = await cacheIsStale(config);
    if (!stale && INDEX_CACHE.has(cacheKey)) {
        return INDEX_CACHE.get(cacheKey);
    }
    if (stale) {
        await runIndexBuilder(config);
    }
    const raw = parseJson(await readFile(config.cacheFile, "utf8"));
    if (raw.version !== config.revitVersion || normalize(raw.sourceRoot) !== normalize(config.rootPath)) {
        await runIndexBuilder(config);
        const rebuilt = parseJson(await readFile(config.cacheFile, "utf8"));
        const hydrated = hydrateIndex(rebuilt);
        INDEX_CACHE.set(cacheKey, hydrated);
        return hydrated;
    }
    const hydrated = hydrateIndex(raw);
    INDEX_CACHE.set(cacheKey, hydrated);
    return hydrated;
}

function scoreMatch(item, query) {
    const lowered = normalize(query);
    const name = normalize(item.name);
    const fullName = normalize(item.fullName);
    const signature = normalize(item.signature || "");
    const summary = normalize(item.summary || "");
    const qualifiedTail = lowered.includes(".") ? `.${lowered}` : "";
    if (normalize(item.id) === lowered) {
        return 1000;
    }
    if (fullName === lowered || signature === lowered) {
        return 900;
    }
    if (qualifiedTail && (fullName.includes(qualifiedTail) || signature.includes(qualifiedTail))) {
        return 850;
    }
    if (name === lowered) {
        return 800;
    }
    if (fullName.startsWith(lowered) || signature.startsWith(lowered)) {
        return 700;
    }
    if (name.startsWith(lowered)) {
        return 650;
    }
    if (fullName.includes(lowered) || signature.includes(lowered)) {
        return 500;
    }
    if (name.includes(lowered)) {
        return 450;
    }
    if (summary.includes(lowered)) {
        return 150;
    }
    let tokenScore = 0;
    for (const token of lowered.split(/\s+/).filter(Boolean)) {
        if (fullName.includes(token) || signature.includes(token)) {
            tokenScore += 50;
        }
        if (summary.includes(token)) {
            tokenScore += 10;
        }
    }
    return tokenScore;
}

function filterByAssembly(items, assembly) {
    if (!assembly) {
        return items;
    }
    const assemblyFilter = normalize(assembly);
    return items.filter((item) => normalize(item.assembly).includes(assemblyFilter));
}

function filterByKind(items, kind) {
    if (!kind) {
        return items;
    }
    return items.filter((item) => item.kind === kind);
}

function findTypeMatches(index, typeName) {
    const query = normalize(typeName);
    if (!query) {
        return [];
    }
    if (query.startsWith("t:")) {
        const exact = index.typeById.get(query);
        return exact ? [exact] : [];
    }
    const byFullName = index.typeByFullName.get(query);
    if (byFullName) {
        return [byFullName];
    }
    const bySimpleName = index.typesByName.get(query) || [];
    if (bySimpleName.length > 0) {
        return bySimpleName;
    }
    const fuzzy = index.types.filter((type) => normalize(type.fullName).includes(query) || normalize(type.name).includes(query));
    return fuzzy.slice(0, 20);
}

function findMemberMatches(index, memberName, typeName, kind) {
    const query = normalize(memberName);
    let matches = [];
    if (!query) {
        return matches;
    }
    if (/^[mpefc]:/i.test(memberName)) {
        const exact = index.membersById.get(query);
        matches = exact ? [exact] : [];
    }
    else {
        matches = [
            ...(index.membersByFullName.get(query) || []),
            ...(index.membersByName.get(query) || []),
        ];
        if (matches.length === 0) {
            matches = index.members.filter((member) => normalize(member.fullName).includes(query) ||
                normalize(member.name).includes(query) ||
                normalize(member.signature).includes(query));
        }
    }
    if (typeName) {
        const types = findTypeMatches(index, typeName);
        const allowed = new Set(types.map((type) => normalize(type.fullName)));
        matches = matches.filter((member) => allowed.has(normalize(member.declaringType)));
    }
    if (kind) {
        matches = matches.filter((member) => member.kind === kind);
    }
    return uniqueBy(matches, (member) => member.id);
}

function groupMembers(members) {
    const groups = {
        constructors: [],
        methods: [],
        properties: [],
        fields: [],
        events: [],
    };
    for (const member of members) {
        const summaryRecord = toSummaryRecord(member);
        if (member.kind === "constructor") {
            groups.constructors.push(summaryRecord);
        }
        else if (member.kind === "method") {
            groups.methods.push(summaryRecord);
        }
        else if (member.kind === "property") {
            groups.properties.push(summaryRecord);
        }
        else if (member.kind === "field") {
            groups.fields.push(summaryRecord);
        }
        else if (member.kind === "event") {
            groups.events.push(summaryRecord);
        }
    }
    for (const key of Object.keys(groups)) {
        groups[key].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    }
    return groups;
}

function resolveUniqueType(index, typeName) {
    const matches = findTypeMatches(index, typeName);
    if (matches.length === 0) {
        throw new Error(`No type matched '${typeName}'.`);
    }
    if (matches.length > 1) {
        return {
            ambiguous: true,
            matches: matches.slice(0, 20).map(toSummaryRecord),
        };
    }
    return {
        ambiguous: false,
        type: matches[0],
    };
}

export async function searchApi(options) {
    const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
    const index = await loadIndex({ revitVersion: options.revitVersion });
    const filtered = filterByAssembly(filterByKind(index.searchItems, options.kind), options.assembly);
    const ranked = filtered
        .map((item) => ({ item, score: scoreMatch(item, options.query) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.item.fullName.localeCompare(right.item.fullName))
        .slice(0, limit)
        .map((entry) => entry.item);
    return {
        query: options.query,
        revitVersion: index.version,
        sourceRoot: index.sourceRoot,
        resultCount: ranked.length,
        results: ranked.map(toSummaryRecord),
    };
}

export async function getTypeDetails(options) {
    const index = await loadIndex({ revitVersion: options.revitVersion });
    const resolution = resolveUniqueType(index, options.typeName);
    if (resolution.ambiguous) {
        return {
            typeName: options.typeName,
            ambiguous: true,
            matches: resolution.matches,
        };
    }
    const type = resolution.type;
    const declaredMembers = index.membersByType.get(normalize(type.fullName)) || [];
    const inheritedMembers = [];
    if (options.includeInherited) {
        let baseTypeName = type.baseType;
        while (baseTypeName) {
            const baseType = index.typeByFullName.get(normalize(baseTypeName));
            if (!baseType) {
                break;
            }
            inheritedMembers.push({
                declaringType: baseType.fullName,
                members: groupMembers(index.membersByType.get(normalize(baseType.fullName)) || []),
            });
            baseTypeName = baseType.baseType;
        }
    }
    return {
        type: toSummaryRecord(type),
        metadata: {
            assembly: type.assembly,
            namespace: type.namespace,
            baseType: type.baseType,
            interfaces: type.interfaces,
            isAbstract: type.isAbstract,
            isSealed: type.isSealed,
            isInterface: type.isInterface,
            isEnum: type.isEnum,
            isValueType: type.isValueType,
            summary: type.summary,
            remarks: type.remarks,
            since: type.since,
        },
        declaredMembers: groupMembers(declaredMembers),
        inheritedMembers,
    };
}

export async function getMemberDetails(options) {
    const index = await loadIndex({ revitVersion: options.revitVersion });
    const matches = findMemberMatches(index, options.memberName, options.typeName, options.kind);
    if (matches.length === 0) {
        throw new Error(`No member matched '${options.memberName}'.`);
    }
    if (matches.length > 1) {
        return {
            memberName: options.memberName,
            typeName: options.typeName || null,
            ambiguous: true,
            matches: matches.slice(0, 25).map(toSummaryRecord),
        };
    }
    const member = matches[0];
    return {
        member: {
            id: member.id,
            kind: member.kind,
            name: member.name,
            fullName: member.fullName,
            declaringType: member.declaringType,
            assembly: member.assembly,
            namespace: member.namespace,
            isStatic: member.isStatic,
            signature: member.signature,
            summary: member.summary,
            remarks: member.remarks,
            returns: member.returns,
            value: member.value,
            since: member.since,
            parameters: member.parameters,
            exceptions: member.exceptions,
        },
    };
}

export async function listNamespace(options) {
    const index = await loadIndex({ revitVersion: options.revitVersion });
    const exact = index.namespaces.get(options.namespaceName) ||
        [...index.namespaces.values()].find((entry) => normalize(entry.name) === normalize(options.namespaceName));
    if (!exact) {
        const fuzzyMatches = [...index.namespaces.keys()]
            .filter((name) => normalize(name).includes(normalize(options.namespaceName)))
            .slice(0, 20);
        if (fuzzyMatches.length === 0) {
            throw new Error(`Namespace not found: ${options.namespaceName}`);
        }
        return {
            namespace: options.namespaceName,
            ambiguous: true,
            matches: fuzzyMatches,
        };
    }
    const childNamespaces = options.includeChildNamespaces
        ? [...index.namespaces.keys()]
            .filter((name) => name.startsWith(`${exact.name}.`) && name !== exact.name)
            .map((name) => name.slice(exact.name.length + 1))
            .filter((name) => !name.includes("."))
            .sort()
        : [];
    return {
        namespace: exact.name,
        assemblyNames: uniqueBy(exact.types, (type) => type.assembly).map((type) => type.assembly).sort(),
        childNamespaces,
        typeCount: exact.types.length,
        types: exact.types
            .slice()
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(toSummaryRecord),
    };
}
