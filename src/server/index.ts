import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../core/config.js";
import { ProPublicaClient } from "../domain/nonprofit/propublica-client.js";
import { CsvDataStore } from "../data-sources/csv-data-store.js";
import { VettingStore } from "../data-sources/vetting-store.js";
import { IrsRevocationClient } from "../domain/red-flags/irs-revocation-client.js";
import { OfacSdnClient } from "../domain/red-flags/ofac-sdn-client.js";
import { CourtListenerClient } from "../domain/red-flags/courtlistener-client.js";
import * as tools from "../domain/nonprofit/tools.js";
import { logInfo, logError } from "../core/logging.js";

// Server configuration
const SERVER_NAME = "nonprofit-vetting-mcp";
const SERVER_VERSION = "1.1.0";

// Load configuration and initialize clients
const config = loadConfig();
const propublicaClient = new ProPublicaClient(config.propublica);
const { thresholds } = config;

// Data store for IRS revocation + OFAC SDN lists
const dataStore = new CsvDataStore(config.redFlag);
const irsClient = new IrsRevocationClient(dataStore);
const ofacClient = new OfacSdnClient(dataStore);

// CourtListener is optional (requires API token)
const courtClient = config.redFlag.courtlistenerApiToken
  ? new CourtListenerClient(config.redFlag)
  : undefined;

// Vetting result persistence (SQLite, same dataDir as IRS/OFAC caches)
const vettingStore = new VettingStore(config.redFlag.dataDir);
let vettingStoreReady = false;

// Create MCP server instance
const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Handle list_tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
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
      },
      {
        name: "check_tier1",
        description:
          "Run Tier 1 vetting. Three layers: (1) Pre-screen gates — verified 501(c)(3), OFAC sanctions, 990 filing exists. (2) Scoring engine — years, revenue, expense ratio, 990 recency (100 pts). (3) Red flag overlay. Thresholds: 75+ PASS, 50-74 REVIEW, <50 REJECT. Results are saved and cached — re-vetting returns the cached result unless force_refresh is true.",
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
          },
          required: ["ein"],
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
          },
          required: ["ein"],
        },
      },
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
      },
    ],
  };
});

// Format any ToolResponse into an MCP content response
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatToolResponse(result: { success: boolean; [key: string]: any }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    isError: !result.success,
  };
}

function argString(
  args: Record<string, unknown> | undefined,
  key: string,
): string {
  const val = args?.[key];
  return typeof val === "string" ? val : "";
}

function argStringOpt(
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const val = args?.[key];
  return typeof val === "string" ? val : undefined;
}

function argBool(
  args: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return args?.[key] === true;
}

function argNumber(
  args: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const val = args?.[key];
  return typeof val === "number" ? val : undefined;
}

// Handle call_tool request
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "search_nonprofit") {
      return formatToolResponse(
        await tools.searchNonprofit(propublicaClient, {
          query: argString(args, "query"),
          state: argStringOpt(args, "state"),
          city: argStringOpt(args, "city"),
        }),
      );
    }

    if (name === "get_nonprofit_profile") {
      return formatToolResponse(
        await tools.getNonprofitProfile(propublicaClient, {
          ein: argString(args, "ein"),
        }),
      );
    }

    if (name === "check_tier1") {
      const ein = argString(args, "ein");
      const forceRefresh = argBool(args, "force_refresh");

      // Dedup: return cached result unless force_refresh
      if (!forceRefresh && vettingStoreReady) {
        const cached = vettingStore.getLatestByEin(ein);
        if (cached) {
          const cachedResult = JSON.parse(cached.result_json);
          return formatToolResponse({
            success: true,
            data: cachedResult,
            cached: true,
            cached_note: `Previously vetted on ${cached.vetted_at} by ${cached.vetted_by}. Use force_refresh: true to re-vet.`,
            attribution: "ProPublica Nonprofit Explorer API",
          });
        }
      }

      const result = await tools.checkTier1(
        propublicaClient,
        { ein },
        thresholds,
        irsClient,
        ofacClient,
        courtClient,
      );

      // Persist on success (non-blocking — errors logged, not thrown)
      if (result.success && result.data && vettingStoreReady) {
        try {
          vettingStore.saveResult(result.data);
        } catch (err) {
          logError(
            "Failed to save vetting result:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return formatToolResponse(result);
    }

    if (name === "get_red_flags") {
      return formatToolResponse(
        await tools.getRedFlags(
          propublicaClient,
          { ein: argString(args, "ein") },
          thresholds,
          courtClient,
        ),
      );
    }

    if (name === "refresh_data") {
      const source = argString(args, "source");
      if (!["irs", "ofac", "all"].includes(source)) {
        return formatToolResponse({
          success: false,
          error: 'Invalid source. Must be "irs", "ofac", or "all".',
          attribution: "",
        });
      }
      try {
        const result = await dataStore.refresh(
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
    }

    if (name === "list_vetted") {
      if (!vettingStoreReady) {
        return formatToolResponse({
          success: false,
          error:
            "VettingStore not available. Check server logs for initialization errors.",
          attribution: "",
        });
      }
      const results = vettingStore.listVetted({
        recommendation: argStringOpt(args, "recommendation") as
          | "PASS"
          | "REVIEW"
          | "REJECT"
          | undefined,
        since: argStringOpt(args, "since"),
        limit: argNumber(args, "limit"),
      });
      const stats = vettingStore.getStats();
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
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
export async function startServer(): Promise<void> {
  // Initialize data stores (downloads IRS/OFAC data on first run or when stale)
  try {
    await dataStore.initialize();
    logInfo("Data stores initialized");
  } catch (err) {
    logError(
      "Data store initialization failed (gates requiring IRS/OFAC will fail):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Initialize vetting result persistence (SQLite)
  try {
    vettingStore.initialize();
    vettingStoreReady = true;
  } catch (err) {
    logError(
      "VettingStore initialization failed (persistence disabled):",
      err instanceof Error ? err.message : String(err),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

// Graceful shutdown
process.on("SIGINT", () => {
  logInfo("Received SIGINT, shutting down...");
  vettingStore.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logInfo("Received SIGTERM, shutting down...");
  vettingStore.close();
  process.exit(0);
});
