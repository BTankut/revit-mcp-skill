import { z } from "zod";
import { getTypeDetails } from "../utils/docIndex.js";

export function registerGetTypeDetailsTool(server) {
    server.tool("get_type_details", "Get detailed information about a Revit API type, including declared members and XML documentation.", {
        type_name: z.string().min(1).describe("Type name to resolve. Supports full names like Autodesk.Revit.DB.Wall or simple names like Wall."),
        revit_version: z.string().optional().describe("Optional Revit version. Defaults to 2022."),
        include_inherited: z.boolean().optional().describe("When true, include members declared on base types."),
    }, async (args) => {
        try {
            const result = await getTypeDetails({
                typeName: args.type_name,
                revitVersion: args.revit_version,
                includeInherited: args.include_inherited,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `get_type_details failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
}
