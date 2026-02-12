import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { logInfo } from "../core/logging.js";
import { createServerContext } from "./context.js";
import { ToolRegistry } from "./tool-registry.js";
import { getToolDefinitions as getNonprofitTools } from "./nonprofit-tools.js";
import { getToolDefinitions as getDiscoveryTools } from "./discovery-tools.js";
import { getToolDefinitions as getDataManagementTools } from "./data-management-tools.js";
import { getToolDefinitions as getSearchHistoryTools } from "./search-history-tools.js";

const SERVER_NAME = "nonprofit-vetting-mcp";
const SERVER_VERSION = "1.2.0";

export async function startServer(): Promise<void> {
  const ctx = await createServerContext();

  // Build tool registry from domain modules
  const registry = new ToolRegistry();
  registry.register(getNonprofitTools());
  registry.register(getDiscoveryTools());
  registry.register(getDataManagementTools());
  registry.register(getSearchHistoryTools());

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await registry.callTool(name, args, ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    logInfo("Shutting down...");
    ctx.searchHistoryStore?.close();
    ctx.discoveryIndex.close();
    ctx.vettingStore?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}
