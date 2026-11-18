# Deploy from a terminal

This is the terminal way to do [step 2 of the install](../README.md#2-deploy), and to update later. It needs
a computer with Node.js 22 (22.18+), 24 (24.11+) or 26+, npm, git and openssl, in a POSIX shell (macOS, Linux
or WSL). Do [step 1, Access](../README.md#1-access), first, and keep your host and the AUD at hand.

This path and the GitHub workflow are interchangeable on the same Cloudflare account. The workflow finds the
existing encryption key and never replaces it.

**Already deployed, from GitHub or another computer?** Then the first-install steps below (creating the key,
the `--secrets-file` deploys, `--domain`) do not apply, and would overwrite the live key. Clone, run
`npm install` and `npx wrangler login`, then deploy with `npm run deploy:garmin` and `npm run deploy:gateway`,
both without flags, as in "Later deploys" under [Check](#check). That keeps the key, the AUD and the host.
Never create a new key for an existing deployment: every saved Garmin key would become unreadable.

## Deploy

First install. Run everything from the repository root.

```bash
git clone <repository URL> personal-mcp
cd personal-mcp
npm install
npx wrangler login
npx wrangler whoami
```

If `whoami` lists several accounts, tell wrangler which one holds your host:

```bash
printf 'CLOUDFLARE_ACCOUNT_ID=%s\n' '<account id>' > .env
```

### Create the encryption key

**First install only.** If the service is already deployed, skip everything from here to "Check" and see the
note at the top.

It protects every Garmin key the service stores; the command writes it once and never shows it. Back the file
up, for example in a password manager: **a lost or changed key makes every saved Garmin key unreadable**, and
everyone has to paste theirs again.

```bash
[ -e workers/garmin/.dev.vars ] || printf 'KEY_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" > workers/garmin/.dev.vars
```

### Deploy the servers

Deploy the Garmin server, then the gateway on your host. `--domain` creates the DNS record and certificate;
the host must have no DNS record and no other Worker, because wrangler replaces them.

```bash
npm run deploy:garmin -- --secrets-file workers/garmin/.dev.vars
printf 'ACCESS_AUD=%s\n' '<aud>' > workers/gateway/.dev.vars
npm run deploy:gateway -- --secrets-file workers/gateway/.dev.vars --domain <host>
```

### Check

The certificate can take a few minutes. The first command must print `401` (Access asks for a sign-in) and
the second `200` (Access covers the whole host):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/garmin/mcp
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/.well-known/oauth-authorization-server
```

| Answer | Meaning |
|---|---|
| `302` on the first | Managed OAuth is off (Access, step 4) |
| `403` on the first | No Access application covers the host, or Bot Fight Mode challenged the request |
| `403` on the second | The application has a path; change it to the whole host |
| `000` | The host or its certificate is not ready yet |

Later deploys, and any deploy of an existing service from a new computer, need no flags:
`npm run deploy:garmin`, then `npm run deploy:gateway`. If wrangler asks "Would you like to continue?" because
the remote configuration differs, answer yes, and never let it update `wrangler.jsonc`.

Then continue with [step 3, Connect](../README.md#3-connect). If the settings page says `Forbidden`, the AUD is
wrong: fix `workers/gateway/.dev.vars` and rerun the gateway deploy with `--secrets-file`.

## Restore the encryption key

First open Workers & Pages → personal-mcp-garmin → Settings → Variables and Secrets. If
`KEY_ENCRYPTION_KEY` is listed, the key is there: change nothing, and report the failed run (open an issue in
the upstream repo). Only if it is not listed, continue below.

Needed only if the `KEY_ENCRYPTION_KEY` secret was deleted from the `personal-mcp-garmin` Worker. Never delete
the Worker itself: that erases everyone's data. Add the secret either in the dashboard (Workers & Pages →
personal-mcp-garmin → Settings → Variables and Secrets → Add, type Secret) or in a terminal:

```bash
npx wrangler secret put KEY_ENCRYPTION_KEY -c workers/garmin/wrangler.jsonc
```

- **With a backup** (a terminal install keeps it in `workers/garmin/.dev.vars`): enter that same value. Saved
  Garmin keys keep working.
- **Without a backup** (always the case on the GitHub path, where the key is never shown): the saved Garmin
  keys cannot be read any more. Enter a new value, the output of `openssl rand -base64 32`, then ask everyone
  to paste their Garmin key again on the settings page. Their data stays.

Then deploy again.

## Update

```bash
git pull
npm install
npm test
npm run deploy:garmin
npm run deploy:gateway
```
