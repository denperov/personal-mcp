import { expect, it } from "vitest";
import { accessEmail } from "../src/access";

const ctx = (aud: string, identity: () => Promise<CloudflareAccessIdentity | undefined>): CloudflareAccessContext =>
  ({ aud, getIdentity: identity });
const owner = async () => ({ email: "alex@example.com" });

it("no Access context → null", async () => {
  expect(await accessEmail(undefined, "aud")).toBeNull();
});

it("foreign aud → null", async () => {
  expect(await accessEmail(ctx("other-aud", owner), "aud")).toBeNull();
});

it("no identity → null", async () => {
  expect(await accessEmail(ctx("aud", async () => undefined), "aud")).toBeNull();
  expect(await accessEmail(ctx("aud", async () => ({ name: "x" })), "aud")).toBeNull();
});

it("getIdentity() failure → null", async () => {
  expect(await accessEmail(ctx("aud", () => Promise.reject(new Error("boom"))), "aud")).toBeNull();
});

it("email is lowercased", async () => {
  expect(await accessEmail(ctx("aud", async () => ({ email: "Alex@Example.com" })), "aud")).toBe("alex@example.com");
});

it("an empty expected AUD never matches → null", async () => {
  expect(await accessEmail(ctx("", owner), "")).toBeNull();
});
