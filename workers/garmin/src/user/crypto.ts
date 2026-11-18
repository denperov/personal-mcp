// AES-GCM-256 on WebCrypto. aad is the Durable Object id: ciphertext moved into another object will not open.
// v is the KEY_ENCRYPTION_KEY version; rotation (a second secret and lazy re-encryption) comes when needed.
export type Sealed = { v: 1; iv: string; ct: string }; // base64

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();

/** Secret is base64 of exactly 32 bytes; the value itself never goes into the error */
export async function importKek(secretB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = unb64(secretB64);
  } catch {
    raw = new Uint8Array();
  }
  if (raw.length !== 32) throw new Error("KEY_ENCRYPTION_KEY must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(kek: CryptoKey, plain: string, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, kek, enc.encode(plain));
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** Foreign aad or kek, corruption, unknown version: throws */
export async function open(kek: CryptoKey, s: Sealed, aad: string): Promise<string> {
  if (s.v !== 1) throw new Error("unknown sealed version");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv), additionalData: enc.encode(aad) }, kek, unb64(s.ct));
  return new TextDecoder().decode(pt);
}
