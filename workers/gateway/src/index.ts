import { accessEmail } from "./access";
import { PAGE_HEADERS, PAGES } from "./pages";

/**
 * RPC contract of a server behind the gateway (service binding MCP_<NAME>); Access decides admission by email,
 * the server accepts any verified identity
 */
interface ServerBackend {
  handle(request: Request, email: string): Promise<Response>;
}

const ROUTE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/.*)?$/;
// Credentials of the whole Access application on the host: the server does not need them (identity is the email argument)
const CREDENTIALS = ["cookie", "cf-access-jwt-assertion", "authorization"];

export default {
  // Identity comes only from verified Access; /<name>/… → MCP_<NAME>.handle(request without the prefix, email)
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const page = req.method === "GET" || req.method === "HEAD" ? PAGES.get(url.pathname) : undefined;
    if (page) return new Response(page, { headers: PAGE_HEADERS }); // public page: no identity, never reaches the servers
    const email = await accessEmail(ctx.access, env.ACCESS_AUD);
    if (email === null) {
      console.log(JSON.stringify({ auth: "deny", access: !!ctx.access }));
      return new Response("Forbidden", { status: 403 });
    }
    const m = ROUTE.exec(url.pathname);
    const key = m ? `MCP_${m[1].toUpperCase().replaceAll("-", "_")}` : ""; // only service bindings have the MCP_ prefix
    if (!m || !Object.hasOwn(env, key)) return new Response("Not Found", { status: 404 });
    url.pathname = m[2] ?? "/";
    const fwd = new Request(url, req);
    for (const h of CREDENTIALS) fwd.headers.delete(h);
    return (env as unknown as Record<string, ServerBackend>)[key].handle(fwd, email);
  },
} satisfies ExportedHandler<Env>;
