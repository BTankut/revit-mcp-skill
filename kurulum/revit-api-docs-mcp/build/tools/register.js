import { registerSearchApiTool } from "./search_api.js";
import { registerGetTypeDetailsTool } from "./get_type_details.js";
import { registerGetMemberDetailsTool } from "./get_member_details.js";
import { registerListNamespaceTool } from "./list_namespace.js";

export async function registerTools(server) {
    registerSearchApiTool(server);
    registerGetTypeDetailsTool(server);
    registerGetMemberDetailsTool(server);
    registerListNamespaceTool(server);
    console.error("Registered 4 Revit API Docs MCP tools");
}
