import * as discoveryTools from "../domain/discovery/tools.js";
import type { ToolDefinition } from "./tool-registry.js";
import {
  argStringOpt,
  argStringArray,
  argNumber,
  argBoolOpt,
  formatToolResponse,
} from "./tool-registry.js";

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "discover_nonprofits",
      description:
        "Browse and filter nonprofits from IRS Business Master File (~1.8M orgs). Zero API calls, sub-second response. Filter by state, city, NTEE category, ruling year, or name. Returns candidates ready for screen_nonprofit. Default: 501(c)(3) orgs within platform portfolio scope.",
      inputSchema: {
        type: "object",
        properties: {
          state: {
            type: "string",
            description: 'Filter by state (2-letter code, e.g., "CA", "NY").',
          },
          city: {
            type: "string",
            description: "Filter by city name (case-insensitive).",
          },
          ntee_categories: {
            type: "array",
            items: { type: "string" },
            description:
              'NTEE category prefixes to include (e.g., ["B"] for education, ["E"] for health). Intersected with platform portfolio scope.',
          },
          ntee_exclude: {
            type: "array",
            items: { type: "string" },
            description: "NTEE category prefixes to exclude.",
          },
          subsection: {
            type: "number",
            description:
              "IRS subsection code. Default: 3 (501(c)(3)). Use 0 for all.",
          },
          min_ruling_year: {
            type: "number",
            description: "Minimum ruling year (e.g., 2010).",
          },
          max_ruling_year: {
            type: "number",
            description: "Maximum ruling year (e.g., 2020).",
          },
          name_contains: {
            type: "string",
            description: "Substring match on organization name.",
          },
          portfolio_fit_only: {
            type: "boolean",
            description:
              "Apply platform portfolio-fit NTEE filter. Default: true.",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 100, max 500).",
          },
          offset: {
            type: "number",
            description: "Pagination offset (default 0).",
          },
        },
      },
      handler: async (args, ctx) => {
        if (!ctx.discoveryReady) {
          return formatToolResponse({
            success: false,
            error:
              "Discovery index not ready. Run refresh_discovery_index to build it, or check server logs.",
            attribution: "",
          });
        }

        const queryArgs = {
          state: argStringOpt(args, "state"),
          city: argStringOpt(args, "city"),
          ntee_categories: argStringArray(args, "ntee_categories"),
          ntee_exclude: argStringArray(args, "ntee_exclude"),
          subsection: argNumber(args, "subsection"),
          min_ruling_year: argNumber(args, "min_ruling_year"),
          max_ruling_year: argNumber(args, "max_ruling_year"),
          name_contains: argStringOpt(args, "name_contains"),
          portfolio_fit_only: argBoolOpt(args, "portfolio_fit_only"),
          limit: argNumber(args, "limit"),
          offset: argNumber(args, "offset"),
        };

        const result = discoveryTools.discoverNonprofits(
          ctx.discoveryPipeline,
          queryArgs,
        );

        // Log discovery query (non-blocking)
        if (result.success && result.data && ctx.searchHistoryStore) {
          try {
            ctx.searchHistoryStore.logSearch(
              "discover_nonprofits",
              queryArgs,
              result.data.total,
            );
          } catch {
            // Silently ignore — logging is best-effort
          }
        }

        return formatToolResponse(result);
      },
    },
    {
      name: "refresh_discovery_index",
      description:
        "Re-download IRS BMF data and rebuild the discovery index. Takes ~3-5 minutes. Use when the index is stale or on first setup.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_args, ctx) => {
        const result = await discoveryTools.refreshDiscoveryIndex(
          ctx.discoveryIndex,
        );
        if (result.success) {
          ctx.discoveryReady = true;
        }
        return formatToolResponse(result);
      },
    },
  ];
}
