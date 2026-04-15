import { z } from "zod";
import { searchApi } from "../utils/docIndex.js";

export function registerSearchApiTool(server) {
    server.tool("search_api", "Search the local Revit API index built from Revit assemblies and XML documentation.", {
        query: z.string().min(1).describe("Free-form search query such as 'Wall.Create', 'FilteredElementCollector', or 'Autodesk.Revit.DB.Plumbing'."),
        kind: z.enum(["namespace", "type", "constructor", "method", "property", "field", "event"]).optional().describe("Optional symbol kind filter."),
        assembly: z.string().optional().describe("Optional assembly name filter such as RevitAPI or RevitAPIUI."),
        revit_version: z.string().optional().describe("Optional Revit version. Defaults to 2022."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return."),
    }, async (args) => {
        try {
            const result = await searchApi({
                query: args.query,
                kind: args.kind,
                assembly: args.assembly,
                revitVersion: args.revit_version,
                limit: args.limit,
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
                        text: `search_api failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
}
