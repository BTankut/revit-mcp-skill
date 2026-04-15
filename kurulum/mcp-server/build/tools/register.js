import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function loadToolManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Tool manifest not found: ${manifestPath}`);
    }
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    if (!manifest || typeof manifest !== "object" || !manifest.profiles) {
        throw new Error(`Invalid tool manifest: ${manifestPath}`);
    }
    return manifest;
}

function getAvailableToolNames(toolsDir) {
    return new Set(fs
        .readdirSync(toolsDir)
        .filter((file) => (file.endsWith(".ts") || file.endsWith(".js")) &&
        file !== "index.ts" &&
        file !== "index.js" &&
        file !== "register.ts" &&
        file !== "register.js")
        .map((file) => file.replace(/\.(ts|js)$/, "")));
}

function getRegisterFunction(module, toolName) {
    const registerFunctionName = Object.keys(module).find((key) => key.startsWith("register") && typeof module[key] === "function");
    if (!registerFunctionName) {
        throw new Error(`No register function found for tool: ${toolName}`);
    }
    return module[registerFunctionName];
}

export async function registerTools(server) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const manifestPath = path.join(__dirname, "tool-manifest.json");
    const manifest = loadToolManifest(manifestPath);
    const defaultProfile = manifest.defaultProfile || "core";
    const requestedProfile = process.env.REVIT_MCP_TOOL_PROFILE
        ? process.env.REVIT_MCP_TOOL_PROFILE.trim()
        : "";
    let activeProfile = requestedProfile || defaultProfile;
    if (!manifest.profiles[activeProfile]) {
        console.warn(`Unknown REVIT_MCP_TOOL_PROFILE="${activeProfile}". Falling back to "${defaultProfile}".`);
        activeProfile = defaultProfile;
    }
    const requestedTools = manifest.profiles[activeProfile];
    if (!Array.isArray(requestedTools) || requestedTools.length === 0) {
        throw new Error(`Tool profile "${activeProfile}" is empty.`);
    }
    const availableTools = getAvailableToolNames(__dirname);
    const uniqueTools = [...new Set(requestedTools)];
    let registeredCount = 0;
    console.error(`Revit MCP tool profile: ${activeProfile}`);
    for (const toolName of uniqueTools) {
        if (!availableTools.has(toolName)) {
            throw new Error(`Tool "${toolName}" listed in profile "${activeProfile}" was not found in ${__dirname}`);
        }
        const importPath = `./${toolName}.js`;
        const module = await import(importPath);
        const registerTool = getRegisterFunction(module, toolName);
        registerTool(server);
        registeredCount++;
        console.error(`Registered tool [${activeProfile}]: ${toolName}`);
    }
    console.error(`Registered ${registeredCount} Revit MCP tools for profile "${activeProfile}"`);
}
