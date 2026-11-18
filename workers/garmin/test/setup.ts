import { afterAll, afterEach, beforeAll } from "vitest";
import { setupNetwork } from "@msw/cloudflare";

export const network = setupNetwork();
network.configure({ onUnhandledFrame: "error" });

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
