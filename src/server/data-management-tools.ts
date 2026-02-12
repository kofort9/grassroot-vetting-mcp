import type { ToolDefinition } from "./tool-registry.js";
import {
  argString,
  argStringOpt,
  argNumber,
  formatToolResponse,
} from "./tool-registry.js";

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "refresh_data",
      description:
        "Re-download IRS revocation list and/or OFAC SDN data. Use when data may be stale.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: ["irs", "ofac", "all"],
            description:
              'Which data source to refresh: "irs", "ofac", or "all"',
          },
        },
        required: ["source"],
      },
      handler: async (args, ctx) => {
        const source = argString(args, "source");
        if (!["irs", "ofac", "all"].includes(source)) {
          return formatToolResponse({
            success: false,
            error: 'Invalid source. Must be "irs", "ofac", or "all".',
            attribution: "",
          });
        }
        try {
          const result = await ctx.dataStore.refresh(
            source as "irs" | "ofac" | "all",
          );
          return formatToolResponse({
            success: true,
            data: { refreshed: source, ...result },
            attribution: "",
          });
        } catch (err) {
          return formatToolResponse({
            success: false,
            error: `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            attribution: "",
          });
        }
      },
    },
    {
      name: "list_vetted",
      description:
        "List previously vetted nonprofits with summary stats. Filter by recommendation or date.",
      inputSchema: {
        type: "object",
        properties: {
          recommendation: {
            type: "string",
            enum: ["PASS", "REVIEW", "REJECT"],
            description: "Filter by recommendation outcome.",
          },
          since: {
            type: "string",
            description:
              "Only show results vetted after this ISO date (e.g., 2026-01-01).",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 20, max 100).",
          },
        },
      },
      handler: async (args, ctx) => {
        if (!ctx.vettingStore) {
          return formatToolResponse({
            success: false,
            error:
              "VettingStore not available. Check server logs for initialization errors.",
            attribution: "",
          });
        }
        const results = ctx.vettingStore.listVetted({
          recommendation: argStringOpt(args, "recommendation") as
            | "PASS"
            | "REVIEW"
            | "REJECT"
            | undefined,
          since: argStringOpt(args, "since"),
          limit: argNumber(args, "limit"),
        });
        const stats = ctx.vettingStore.getStats();
        return formatToolResponse({
          success: true,
          data: {
            results: results.map((r) => ({
              ein: r.ein,
              name: r.name,
              recommendation: r.recommendation,
              score: r.score,
              gate_blocked: r.gate_blocked,
              red_flag_count: r.red_flag_count,
              vetted_at: r.vetted_at,
              vetted_by: r.vetted_by,
            })),
            stats,
          },
          attribution: "",
        });
      },
    },
  ];
}
