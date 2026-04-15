import { registerSendCodeToRevitTool } from "./send_code_to_revit.js";
import { registerGetSelectedElementsTool } from "./get_selected_elements.js";
import { registerGetCurrentViewInfoTool } from "./get_current_view_info.js";
import { registerGetCurrentViewElementsTool } from "./get_current_view_elements.js";

export async function registerTools(server) {
    registerSendCodeToRevitTool(server);
    registerGetSelectedElementsTool(server);
    registerGetCurrentViewInfoTool(server);
    registerGetCurrentViewElementsTool(server);
    console.error("Registered 4 Revit MCP tools");
}
