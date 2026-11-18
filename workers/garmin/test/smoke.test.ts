import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("fetch → 404", async () => {
  const r = await exports.default.fetch(new Request("https://mcp.example.com/"));
  expect(r.status).toBe(404);
});

it("UserStore is reachable by name", async () => {
  expect(await env.USER_DO.getByName(`t-${crypto.randomUUID()}@x`).ping()).toBe("pong");
});
