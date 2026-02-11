import type { ServerContext } from "./context.js";

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
  ) => Promise<ToolResponse>;
}

// ============================================================================
// Arg-parsing helpers (moved from server/index.ts)
// ============================================================================

export function argString(
  args: Record<string, unknown> | undefined,
  key: string,
): string {
  const val = args?.[key];
  return typeof val === "string" ? val : "";
}

export function argStringOpt(
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const val = args?.[key];
  return typeof val === "string" ? val : undefined;
}

export function argBool(
  args: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return args?.[key] === true;
}

export function argNumber(
  args: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const val = args?.[key];
  return typeof val === "number" ? val : undefined;
}

export function argBoolOpt(
  args: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const val = args?.[key];
  return typeof val === "boolean" ? val : undefined;
}

export function argStringArray(
  args: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const val = args?.[key];
  if (!Array.isArray(val)) return undefined;
  return val.filter((v): v is string => typeof v === "string");
}

/**
 * Format any ToolResponse-shaped object into an MCP content response.
 */
export function formatToolResponse(result: {
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    isError: !result.success,
  };
}

/**
 * Collects tool definitions from domain modules and provides dispatch.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(defs: ToolDefinition[]): void {
    for (const def of defs) {
      if (this.tools.has(def.name)) {
        throw new Error(`Duplicate tool name: ${def.name}`);
      }
      this.tools.set(def.name, def);
    }
  }

  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
  ): Promise<ToolResponse> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args, ctx);
  }
}
