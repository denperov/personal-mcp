import { http, HttpResponse, delay } from "msw";
import { GARMIN_BASE } from "../src/garmin/client";

export const TOKEN_URL = `${GARMIN_BASE}/personalapitoken-service/personal-api/personal-api-key/token`;

const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

// Unsigned JWT: base64url(header).base64url(payload).signature
export function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64u({ alg: "none", typ: "JWT" })}.${b64u(payload)}.sig`;
}

type DataValue = unknown | ((url: URL) => Response);

/**
 * calls: every request as "<METHOD> <pathname+search>", e.g. "POST /personalapitoken-service/..." and
 * "GET /hrv-service/hrv/2026-10-28". dataCalls(): only the data GET requests, in the same format.
 */
export function garminMock(opts: { data?: Record<string, DataValue> } = {}) {
  const data = opts.data ?? {};
  const calls: string[] = [];
  let inFlight = 0;
  let max = 0;
  const track = async <T>(label: string, f: () => T): Promise<T> => {
    calls.push(label);
    max = Math.max(max, ++inFlight);
    try {
      await delay(5); // so that concurrent requests really overlap
      return f();
    } finally {
      inFlight--;
    }
  };
  const handlers = [
    http.post(TOKEN_URL, () =>
      track("POST " + new URL(TOKEN_URL).pathname, () => {
        const now = Math.floor(Date.now() / 1000);
        return new HttpResponse(fakeJwt({ exp: now + 86400, iat: now }), {
          headers: { "content-type": "text/plain" },
        });
      }),
    ),
    http.get(`${GARMIN_BASE}/*`, ({ request }) => {
      const url = new URL(request.url);
      const key = url.pathname + url.search;
      return track("GET " + key, () => {
        const prefix = Object.keys(data)
          .filter((p) => key.startsWith(p))
          .sort((a, b) => b.length - a.length)[0];
        if (prefix === undefined) return HttpResponse.json([]);
        const v = data[prefix];
        return typeof v === "function" ? (v as (u: URL) => Response)(url) : HttpResponse.json(v as any);
      });
    }),
  ];
  return {
    handlers,
    calls,
    dataCalls: () => calls.filter((c) => c.startsWith("GET ")),
    maxInFlight: () => max,
  };
}
