import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { importKek, open, seal } from "../src/user/crypto";

const kekOf = (byte: number, n = 32) => importKek(btoa(String.fromCharCode(...new Uint8Array(n).fill(byte))));

it("seal/open round trip", async () => {
  const kek = await importKek(env.KEY_ENCRYPTION_KEY);
  const s = await seal(kek, "test-key ключ", "do-a");
  expect(s.v).toBe(1);
  expect(JSON.stringify(s)).not.toContain("test-key");
  expect(await open(kek, s, "do-a")).toBe("test-key ключ");
});

it("two seals of the same text differ", async () => {
  const kek = await kekOf(1);
  const [a, b] = [await seal(kek, "same", "x"), await seal(kek, "same", "x")];
  expect(a.iv).not.toBe(b.iv);
  expect(a.ct).not.toBe(b.ct);
});

it("open with another aad throws", async () => {
  const kek = await kekOf(1);
  await expect(open(kek, await seal(kek, "k", "do-a"), "do-b")).rejects.toThrow();
});

it("open with another kek throws", async () => {
  const s = await seal(await kekOf(1), "k", "do-a");
  await expect(open(await kekOf(2), s, "do-a")).rejects.toThrow();
});

it("importKek rejects a 16-byte secret", async () => {
  await expect(kekOf(1, 16)).rejects.toThrow();
});

it("importKek rejects non-base64 and a missing secret", async () => {
  for (const secret of ["not base64!", undefined as unknown as string]) {
    await expect(importKek(secret)).rejects.toThrow("must be base64 of 32 bytes");
  }
});
