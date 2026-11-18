import { VALIDITY_DAYS } from "../user/user-store";
import { ERRORS, renderPage, type PageError } from "./page";

const PAGE = "/garmin/settings"; // address in the browser: gateway strips /garmin
const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // not no-referrer: with it the browser sends Origin: null in form POSTs, and the Origin check would reject every one
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

const isError = (code: string | null): code is PageError => code !== null && Object.hasOwn(ERRORS, code);
/** Key validity from the request — only one of VALIDITY_DAYS; otherwise undefined */
const validDays = (v: unknown): number | undefined => VALIDITY_DAYS.find((d) => d === Number(v));

/**
 * GET — the page for the user's state (?error= — known codes only, ?validity= — values from the list only).
 * POST — only with our own Origin, then always 303 to the page (post/redirect/get); after a failed save the chosen
 * validity stays in the URL (it is not a secret), the key goes into neither the URL nor the response.
 * A failed object call — ?error=unavailable.
 */
export async function handleSettings(request: Request, email: string, env: Env): Promise<Response> {
  const user = env.USER_DO.getByName(email.toLowerCase());
  const origin = new URL(request.url).origin;
  if (request.method === "GET") {
    const q = new URL(request.url).searchParams, code = q.get("error");
    const page = renderPage(await user.settingsState(),
      { email, origin, error: isError(code) ? code : undefined, validity: validDays(q.get("validity")) });
    return new Response(page, { headers: HEADERS });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  if (request.headers.get("origin") !== origin) return new Response("Forbidden", { status: 403 });

  const form = await request.formData().catch(() => new FormData()); // not a form — same as an unknown action
  let error: PageError | undefined, query = ""; // query goes into the address only together with error
  try {
    switch (form.get("action")) {
      case "save": {
        const days = validDays(form.get("validity"));
        if (days) query = `&validity=${days}`;
        const r = await user.saveKey(String(form.get("key") ?? ""), Number(form.get("validity")));
        if (!r.ok) error = r.reason;
        break;
      }
      case "delete-key":
        await user.deleteKey();
        break;
      case "delete-all":
        if (!(await user.deleteAllData()).done) error = "deleting";
        break;
    }
  } catch {
    error = "unavailable"; // RPC failure (object reset, quota) — the same page with an error, not a 1101
  }
  return new Response(null, { status: 303, headers: { Location: error ? `${PAGE}?error=${error}${query}` : PAGE } });
}
