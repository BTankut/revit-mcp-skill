import { z } from "zod";
import { getMemberDetails } from "../utils/docIndex.js";

export function registerGetMemberDetailsTool(server) {
    server.tool("get_member_details", "Get detailed information about a Revit API member, including signature, parameters, and XML documentation.", {
        member_name: z.string().min(1).describe("Member identifier. Supports XML doc IDs, full member names like Autodesk.Revit.DB.Wall.Create, or simple names like Create."),
        type_name: z.string().optional().describe("Optional declaring type filter, such as Autodesk.Revit.DB.Wall."),
        kind: z.enum(["constructor", "method", "property", "field", "event"]).optional().describe("Optional member kind filter."),
        revit_version: z.string().optional().describe("Optional Revit version. Defaults to 2022."),
    }, async (args) => {
        try {
            const result = await getMemberDetails({
                memberName: args.member_name,
                typeName: args.type_name,
                kind: args.kind,
                revitVersion: args.revit_version,
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
                        text: `get_member_details failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
}
