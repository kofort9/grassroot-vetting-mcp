import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../core/config.js";
import { ProPublicaClient } from "../domain/nonprofit/propublica-client.js";
import { CsvDataStore } from "../data-sources/csv-data-store.js";
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
          "Run Tier 1 vetting. Three layers: (1) Pre-screen gates — verified 501(c)(3), OFAC sanctions, 990 filing exists. (2) Scoring engine — years, revenue, expense ratio, 990 recency (100 pts). (3) Red flag overlay. Thresholds: 75+ PASS, 50-74 REVIEW, <50 REJECT.",
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
      return formatToolResponse(
        await tools.checkTier1(
          propublicaClient,
          { ein: argString(args, "ein") },
          thresholds,
          irsClient,
          ofacClient,
          courtClient,
        ),
      );
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

// Graceful shutdown
process.on("SIGINT", () => {
  logInfo("Received SIGINT, shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logInfo("Received SIGTERM, shutting down...");
  process.exit(0);
});
