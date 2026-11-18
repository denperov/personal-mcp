import { WorkerEntrypoint } from "cloudflare:workers";

// Stub of personal-mcp-garmin: answers over RPC with what it received, as SSE from a regular (non-byte) ReadableStream
export default class extends WorkerEntrypoint {
  async handle(request, email) {
    const url = new URL(request.url);
    const echo = JSON.stringify({
      path: url.pathname, search: url.search, method: request.method, body: await request.text(), email, urlOrigin: url.origin,
      host: request.headers.get("host"), headers: Object.fromEntries(request.headers),
    });
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(echo));
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
}
