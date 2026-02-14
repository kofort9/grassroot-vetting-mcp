import * as tools from "../domain/nonprofit/tools.js";
import { compactScreening, compactRedFlags } from "./response-formatter.js";
import {
  type ToolDefinition,
  argString,
  argStringOpt,
  argBool,
  argStringArray,
  formatToolResponse,
} from "./tool-registry.js";

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "search_nonprofit",
      description:
        "Search for nonprofits by name. Returns matching organizations with EIN, name, city, state, and NTEE code. Data from ProPublica Nonprofit Explorer.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (organization name or keywords)",
          },
          state: {
            type: "string",
            description:
              'Optional: Filter by state (2-letter code, e.g., "CA", "NY")',
          },
          city: {
            type: "string",
            description: "Optional: Filter by city name",
          },
        },
        required: ["query"],
      },
      handler: async (args, ctx) => {
        const queryArgs = {
          query: argString(args, "query"),
          state: argStringOpt(args, "state"),
          city: argStringOpt(args, "city"),
        };
        const result = await tools.searchNonprofit(
          ctx.propublicaClient,
          queryArgs,
        );

        // Log search (non-blocking)
        if (result.success && result.data && ctx.searchHistoryStore) {
          try {
            ctx.searchHistoryStore.logSearch(
              "search_nonprofit",
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
      name: "get_nonprofit_profile",
      description:
        "Get detailed profile for a nonprofit by EIN. Returns organization info, 501(c)(3) status, years operating, and latest 990 financial summary including overhead ratio. Data from ProPublica Nonprofit Explorer.",
      inputSchema: {
        type: "object",
        properties: {
          ein: {
            type: "string",
            description:
              'Employer Identification Number (EIN). Accepts formats: "12-3456789" or "123456789"',
          },
        },
        required: ["ein"],
      },
      handler: async (args, ctx) =>
        formatToolResponse(
          await tools.getNonprofitProfile(ctx.propublicaClient, {
            ein: argString(args, "ein"),
          }),
        ),
    },
    {
      name: "check_tier1",
      description:
        "Run Tier 1 vetting. Three layers: (1) Pre-screen gates — verified 501(c)(3), OFAC sanctions, 990 filing exists, portfolio fit (NTEE category). (2) Scoring engine — years, revenue, expense ratio, 990 recency (100 pts). (3) Red flag overlay. Thresholds: 75+ PASS, 50-74 REVIEW, <50 REJECT. Results are saved and cached — re-vetting returns the cached result unless force_refresh is true.",
      inputSchema: {
        type: "object",
        properties: {
          ein: {
            type: "string",
            description:
              'Employer Identification Number (EIN). Accepts formats: "12-3456789" or "123456789"',
          },
          force_refresh: {
            type: "boolean",
            description:
              "Skip cached result and re-run the full vetting pipeline. Default: false.",
          },
          verbose: {
            type: "boolean",
            description:
              "Return full vetting details including gates, checks, and summary. Default: true (verbose). Set to false for compact output.",
          },
        },
        required: ["ein"],
      },
      handler: async (args, ctx) => {
        const ein = argString(args, "ein");
        const forceRefresh = argBool(args, "force_refresh");
        const verbose = args?.verbose !== false; // default true for backward compat

        const { response, cached, cachedNote } =
          await ctx.vettingPipeline.runScreening(ein, { forceRefresh });

        // Check error FIRST — before attempting to format data
        if (!response.success || response.error) {
          return formatToolResponse({
            success: false,
            error: response.error ?? "Unknown error",
            attribution: response.attribution,
          });
        }

        // Apply compact formatting if not verbose
        const data =
          !verbose && response.data
            ? compactScreening(response.data)
            : response.data;

        const result = cached
          ? {
              success: true,
              data,
              cached: true,
              cached_note: cachedNote,
              attribution: response.attribution,
            }
          : {
              success: true,
              data,
              attribution: response.attribution,
            };

        return formatToolResponse(result);
      },
    },
    {
      name: "get_red_flags",
      description:
        "Get red flags and warnings for a nonprofit. Checks for: stale data, high overhead, very low revenue, revenue decline, high officer compensation, and court records. Returns list of flags with severity (HIGH/MEDIUM) and details.",
      inputSchema: {
        type: "object",
        properties: {
          ein: {
            type: "string",
            description:
              'Employer Identification Number (EIN). Accepts formats: "12-3456789" or "123456789"',
          },
          verbose: {
            type: "boolean",
            description:
              "Return full red flag details. Default: true (verbose). Set to false for compact output.",
          },
        },
        required: ["ein"],
      },
      handler: async (args, ctx) => {
        const verbose = args?.verbose !== false;
        const response = await tools.getRedFlags(
          ctx.propublicaClient,
          { ein: argString(args, "ein") },
          ctx.config.thresholds,
          ctx.courtClient,
          ctx.ofacClient,
        );

        if (!verbose && response.data) {
          return formatToolResponse({
            ...response,
            data: compactRedFlags(response.data),
          });
        }
        return formatToolResponse(response);
      },
    },
    {
      name: "batch_tier1",
      description:
        "Run Tier 1 vetting on multiple nonprofits at once. Processes EINs sequentially (respects rate limits). Max 25 EINs per batch. Returns per-EIN results + summary stats.",
      inputSchema: {
        type: "object",
        properties: {
          eins: {
            type: "array",
            items: { type: "string" },
            description:
              'Array of EINs to vet. Max 25. Accepts "12-3456789" or "123456789" formats.',
          },
          force_refresh: {
            type: "boolean",
            description:
              "Skip cached results and re-run vetting for all EINs. Default: false.",
          },
          verbose: {
            type: "boolean",
            description:
              "Return full vetting details for each EIN. Default: false (compact). Set to true for full output.",
          },
        },
        required: ["eins"],
      },
      handler: async (args, ctx) => {
        const MAX_BATCH = 25;
        const eins = argStringArray(args, "eins") ?? [];
        const forceRefresh = argBool(args, "force_refresh");
        const verbose = args?.verbose === true; // default false for batch

        if (eins.length === 0) {
          return formatToolResponse({
            success: false,
            error: "eins array is required and must not be empty.",
            attribution: "ProPublica Nonprofit Explorer API",
          });
        }

        if (eins.length > MAX_BATCH) {
          return formatToolResponse({
            success: false,
            error: `Too many EINs. Max ${MAX_BATCH} per batch, got ${eins.length}.`,
            attribution: "ProPublica Nonprofit Explorer API",
          });
        }

        const results: Array<{
          ein: string;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result: any;
          cached: boolean;
          error?: string;
        }> = [];

        const stats = { pass: 0, review: 0, reject: 0, error: 0, cached: 0 };

        for (const ein of eins) {
          try {
            const { response, cached } = await ctx.vettingPipeline.runScreening(
              ein,
              { forceRefresh },
            );

            if (cached) stats.cached++;

            if (response.success && response.data) {
              const rec = response.data.recommendation;
              if (rec === "PASS") stats.pass++;
              else if (rec === "REVIEW") stats.review++;
              else if (rec === "REJECT") stats.reject++;

              const data = verbose
                ? response.data
                : compactScreening(response.data);

              results.push({ ein, result: data, cached });
            } else {
              stats.error++;
              results.push({
                ein,
                result: null,
                cached: false,
                error: response.error ?? "Unknown error",
              });
            }
          } catch (err) {
            stats.error++;
            results.push({
              ein,
              result: null,
              cached: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return formatToolResponse({
          success: true,
          data: { results, stats, total: eins.length },
          attribution: "ProPublica Nonprofit Explorer API",
        });
      },
    },
  ];
}
