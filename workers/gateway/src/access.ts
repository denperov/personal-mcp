/** Verified Access identity: lower(email), or null if there is no Access context, the AUD is foreign or there is no email */
export async function accessEmail(access: CloudflareAccessContext | undefined, aud: string): Promise<string | null> {
  if (!access || !aud || access.aud !== aud) return null;
  try {
    const email = (await access.getIdentity())?.email;
    return email ? email.toLowerCase() : null;
  } catch {
    return null; // getIdentity() failure = no identity → 403; the error text is not exposed
  }
}
