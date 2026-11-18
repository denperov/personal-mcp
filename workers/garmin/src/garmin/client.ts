export const GARMIN_BASE = "https://personal.connectapi.garmin.com";
export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const MIN_RETRY_MS = 900_000;
const REUSE_MARGIN_MS = 3_600_000;

export class KeyRejectedError extends Error {
  constructor(public status: number) {
    super(`Garmin rejected the API key (${status})`);
  }
}
export class RateLimitedError extends Error {
  constructor(public retryAfterMs: number, path: string) {
    super(`Garmin rate limited (429) ${path}`);
  }
}
export class GarminHttpError extends Error {
  constructor(public status: number, public readonly path: string, public emptyBody: boolean) {
    super(`Garmin HTTP ${status} ${path}`);
  }
}

export interface CachedToken { t: string; exp: number; iat: number } // exp/iat in seconds
export interface TokenStore { load(): CachedToken | undefined; save(v: CachedToken): void }

/** Retry-After (seconds or HTTP-date) → ms, at least 15 minutes. */
export function parseRetryAfter(header: string | null, nowMs: number): number {
  let ms = 0;
  if (header) {
    const s = Number(header);
    ms = Number.isFinite(s) ? s * 1000 : Date.parse(header) - nowMs;
  }
  return Math.max(Number.isFinite(ms) ? ms : 0, MIN_RETRY_MS);
}

function decodeJwt(jwt: string): { exp: number; iat: number } | null {
  try {
    const mid = jwt.split(".")[1];
    const p = JSON.parse(atob(mid.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof p.exp !== "number") return null;
    return { exp: p.exp, iat: typeof p.iat === "number" ? p.iat : p.exp };
  } catch {
    return null;
  }
}

export class GarminClient {
  private last: CachedToken | undefined;

  constructor(
    private apiKey: string,
    private tokens: TokenStore,
    private now: () => number = Date.now,
    private timeoutMs = 20_000,
  ) {}

  tokenLifetimeSec(): number | null {
    return this.last ? this.last.exp - this.last.iat : null;
  }

  /** Key check: one token exchange even if the cache is fresh; errors as in token() */
  async verify(): Promise<void> {
    await this.token(true);
  }

  async get(path: string): Promise<unknown | null> {
    const res = await this.data(path, "application/json");
    const text = await res.text();
    if (res.status === 204 || text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      // the SyntaxError message contains part of the body; do not let it leak out
      throw new GarminHttpError(res.status, path, false);
    }
  }

  async download(path: string): Promise<ArrayBuffer> {
    const res = await this.data(path, "application/zip, application/x-zip-compressed, application/octet-stream");
    return res.arrayBuffer();
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  /** Returns a successful (2xx) response with an unread body; any error is thrown. */
  private async data(path: string, accept: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(attempt > 0);
      const res = await this.fetch(GARMIN_BASE + path, { headers: { Accept: accept, Authorization: `Bearer ${token}` } });
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw await this.fail(res, path);
      return res;
    }
  }

  private async fail(res: Response, path: string): Promise<Error> {
    if (res.status === 429) {
      await res.body?.cancel();
      return new RateLimitedError(parseRetryAfter(res.headers.get("retry-after"), this.now()), path);
    }
    const empty = (await res.text()) === "";
    return new GarminHttpError(res.status, path, empty);
  }

  private async token(force: boolean): Promise<string> {
    const cached = this.tokens.load();
    if (!force && cached && cached.exp * 1000 - this.now() > REUSE_MARGIN_MS) {
      this.last = cached;
      return cached.t;
    }
    const res = await this.fetch(GARMIN_BASE + TOKEN_PATH, {
      method: "POST",
      headers: { Authorization: `ApiKey ${this.apiKey}`, Accept: "*/*" },
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new KeyRejectedError(res.status);
    }
    if (!res.ok) throw await this.fail(res, TOKEN_PATH);
    const t = (await res.text()).trim();
    const claims = decodeJwt(t);
    if (!claims) throw new GarminHttpError(res.status, TOKEN_PATH, false);
    this.last = { t, ...claims };
    this.tokens.save(this.last);
    return t;
  }
}
