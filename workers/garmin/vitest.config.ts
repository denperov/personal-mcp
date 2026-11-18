import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // deploy-time values from wrangler.jsonc play no part in tests
        bindings: { KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", STEP_GAP_MS: "3600000" },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
