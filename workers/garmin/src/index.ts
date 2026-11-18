import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp/server";
import { handleSettings } from "./settings/route";
export { UserStore } from "./user/user-store";

// No public address: MCP and the settings page come only from personal-mcp-gateway via RPC handle() with a verified
// email (lowercased); only Access decides who gets in
export default class extends WorkerEntrypoint<Env> {
  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  }

  async handle(request: Request, email: string): Promise<Response> {
    if (new URL(request.url).pathname === "/settings") return handleSettings(request, email, this.env);
    // Take the address from the request: the gateway passes a URL with the public origin
    return createMcpHandler(() => createServer(email, new URL(request.url).origin), { route: "/mcp" })(request, this.env, this.ctx);
  }
}
