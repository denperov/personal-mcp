import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        access: { aud: "test-aud" },
        bindings: { ACCESS_AUD: "test-aud" },
        // MCP_GARMIN in wrangler.jsonc points to the "personal-mcp-garmin" service — here it is a stub
        workers: [{ name: "personal-mcp-garmin", modules: true, scriptPath: "./test/stub-server.js", compatibilityDate: "2026-10-23" }],
      },
    }),
  ],
});
