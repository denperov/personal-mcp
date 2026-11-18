import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TOOLS } from "./tools";

const RETRY = "temporary error or query too heavy for the Free CPU limit; narrow the range and retry";
// A failure of the RPC itself (CPU limit, DO reset, overload) is recognized by its text: errors come from another isolate.
// The RPC error text is never exposed.
const TRANSIENT = /exceeded|reset|overloaded|connection lost/i;

function rpcFailure(e: unknown): string {
  const { name, message } = Object(e) as Partial<Error>;
  return TRANSIENT.test(`${name} ${message}`) ? RETRY : `internal error (${name ?? "Error"})`;
}

/** email is the verified identity, never a tool argument; origin is the public address from the request; DO name is lower(email); one call is one RPC to the DO */
export function createServer(email: string, origin: string): McpServer {
  const user = email.toLowerCase();
  const server = new McpServer({ name: "garmin", title: "Garmin", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: z.object(t.input), annotations: t.annotations },
      async (args) => {
        let r: { text: string; isError: boolean };
        try {
          r = await env.USER_DO.getByName(user).callTool(t.name, args, origin);
        } catch (e) {
          r = { isError: true, text: rpcFailure(e) };
        }
        return { content: [{ type: "text", text: r.text }], isError: r.isError };
      });
  }
  return server;
}
