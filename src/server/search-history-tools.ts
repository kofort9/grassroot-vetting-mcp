import type { ToolDefinition } from "./tool-registry.js";
import {
  argStringOpt,
  argNumber,
  formatToolResponse,
} from "./tool-registry.js";

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _parse_error: true, raw };
  }
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_searches",
      description:
        "List recent search and discovery queries with result counts. Filter by tool name or date.",
      inputSchema: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            enum: ["search_nonprofit", "discover_nonprofits"],
            description:
              "Filter by tool name. Omit to show all search history.",
          },
          since: {
            type: "string",
            description:
              "Only show searches after this ISO date (e.g., 2026-01-01).",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 20, max 100).",
          },
        },
      },
      handler: async (args, ctx) => {
        if (!ctx.searchHistoryStore) {
          return formatToolResponse({
            success: false,
            error:
              "Search history not available. Check server logs for initialization errors.",
            attribution: "",
          });
        }

        const results = ctx.searchHistoryStore.listSearches({
          tool: argStringOpt(args, "tool"),
          since: argStringOpt(args, "since"),
          limit: argNumber(args, "limit"),
        });

        return formatToolResponse({
          success: true,
          data: {
            searches: results.map((r) => ({
              id: r.id,
              tool: r.tool,
              query: safeParseJson(r.query_json),
              result_count: r.result_count,
              searched_at: r.searched_at,
            })),
            total: results.length,
          },
          attribution: "",
        });
      },
    },
    {
      name: "replay_search",
      description:
        "Re-execute a previous search by its ID (from list_searches). Useful for checking if results have changed.",
      inputSchema: {
        type: "object",
        properties: {
          search_id: {
            type: "number",
            description: "The search ID to replay (from list_searches output).",
          },
        },
        required: ["search_id"],
      },
      handler: async (args, ctx) => {
        if (!ctx.searchHistoryStore) {
          return formatToolResponse({
            success: false,
            error: "Search history not available.",
            attribution: "",
          });
        }

        const searchId = argNumber(args, "search_id");
        if (searchId === undefined) {
          return formatToolResponse({
            success: false,
            error: "search_id is required.",
            attribution: "",
          });
        }

        const record = ctx.searchHistoryStore.getById(searchId);
        if (!record) {
          return formatToolResponse({
            success: false,
            error: `Search ID ${searchId} not found.`,
            attribution: "",
          });
        }

        return formatToolResponse({
          success: true,
          data: {
            original_search: {
              id: record.id,
              tool: record.tool,
              query: safeParseJson(record.query_json),
              result_count: record.result_count,
              searched_at: record.searched_at,
            },
            replay_note:
              "To re-execute this search, call the original tool with the query parameters above.",
          },
          attribution: "",
        });
      },
    },
  ];
}
