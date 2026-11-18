# Install with your agent

A coding agent that runs commands in a terminal, such as Claude Code, can do the GitHub part of the
installation: fork the repository, set the secrets and run the deploy. You still do
[Access](../README.md#1-access) in the Cloudflare dashboard first, create the Cloudflare token, and do
[Connect](../README.md#3-connect) at the end. The agent needs only `gh` (the GitHub CLI), no Node or wrangler.

## Prompt

Copy the repository URL from your browser and fill in your host, account ID and AUD:

```text
Install <repository URL> into my Cloudflare account. Follow docs/install-with-agent.md in that repository
exactly. My host is <host>. My Cloudflare account ID is <account id>. The AUD of my Access application is <aud>.
Ask me whenever a step needs me. Never print, log or commit secrets.
```

## Steps for the agent

`<upstream>` is the repository from the prompt (`owner/name`). `<fork>` is the fork's `<login>/<name>`, taken from the `gh repo fork` output (usually the upstream repository name; it may differ if the person already has a repo with that name). `<host>`,
`<account id>` and `<aud>` come from the prompt. Do not clone anything.

1. **Log in to GitHub.** Run `gh auth status`. If it is not logged in, ask the person to run `! gh auth login`
   and wait. Then run `gh api user -q .login`: this is `<login>`.
   Check that the `gh auth status` output lists the `workflow` scope (`gh repo sync` needs it when upstream
   changed files under `.github/workflows/`). If it is missing, ask the person to run
   `! gh auth refresh -s workflow`.

2. **Fork.**

   ```bash
   gh repo fork <upstream> --clone=false --default-branch-only
   ```

   If the fork already exists, sync it instead: `gh repo sync <fork>`.

3. **Enable workflows.** Run `gh workflow list -R <fork> --all`. If `Deploy` is not `active`, run
   `gh workflow enable deploy.yml -R <fork>`. If that fails, ask the person to open
   `https://github.com/<fork>/actions` and enable workflows, then wait.

4. **Token. Stop here: the person acts.** Tell the person to create the Cloudflare token and add it
   themselves. Never ask for its value. Say:

   > Open Cloudflare dashboard → Account API tokens (`https://dash.cloudflare.com/?to=/:account/api-tokens`)
   > → Create Token. Under Permission policies open the Custom dropdown and select Edit Cloudflare Workers.
   > Name the token, scope it to your account and to the zone of your host, and create it. Cloudflare shows
   > it once. Open `https://github.com/<fork>/settings/secrets/actions/new`, name the secret
   > `CLOUDFLARE_API_TOKEN`, paste the token, and tell me when it is saved. Do not paste it here.

   If the token appears in the chat anyway, tell the person to delete that token in Cloudflare and create a
   new one. Then confirm the secret exists (names only):

   ```bash
   gh secret list -R <fork>
   ```

5. **Set the other secrets.**

   ```bash
   gh secret set CLOUDFLARE_ACCOUNT_ID -R <fork> --body '<account id>'
   gh secret set ACCESS_AUD -R <fork> --body '<aud>'
   gh secret set MCP_HOST -R <fork> --body '<host>'
   ```

6. **Check the host. Stop here: the person answers.** Ask the person to confirm that `<host>` has no DNS record
   and is not used by another Worker: the workflow replaces a plain DNS record on it without asking. Stop if
   they cannot confirm.

7. **Deploy.** A Deploy run triggered by a push may appear after `gh repo sync`; ignore it (if it ran before
   the secrets existed it skips or fails harmlessly). Report only on the run you dispatch. First record the
   newest manual run, which may print nothing on a first install:

   ```bash
   gh run list -R <fork> --workflow deploy.yml --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId'
   ```

   Then dispatch. If this command does not exit 0, stop and show its output:

   ```bash
   gh workflow run deploy.yml -R <fork>
   ```

   Repeat the list command every 5 seconds, for up to 60 seconds, until it prints a different number from the
   one you recorded. That number is `<id>`. If none appears, stop and tell the person what you ran and that no
   run started; point them to `https://github.com/<fork>/actions`. Otherwise watch it (deploys are serialized,
   so it may wait for another run first):

   ```bash
   gh run watch <id> -R <fork> --exit-status
   ```

   The first run takes a few minutes and creates the encryption key by itself. On failure:

   ```bash
   gh run view <id> -R <fork> --log-failed
   ```

   Show the person the last lines of the failed step and stop. The failure tables in
   [Deploy](../README.md#2-deploy) explain each message; do not repeat or guess fixes beyond them.

8. **Hand over.** Ask the person to open `https://<host>/garmin/settings` and sign in, then to follow
   [Connect](../README.md#3-connect). If the page says `Forbidden`, the AUD is wrong: set the right one with
   step 5 and repeat step 7.

## Update

Record the newest push-triggered run (it may print nothing), then sync:

```bash
gh run list -R <fork> --workflow deploy.yml --event push --limit 1 --json databaseId -q '.[0].databaseId'
gh repo sync <fork>
```

A push to `main` starts Deploy by itself. Repeat the list command every 5 seconds, for up to 60 seconds, until
it prints a different number from the one you recorded. That number is `<id>`: watch it with
`gh run watch <id> -R <fork> --exit-status` and handle a failure as in step 7. If none appears, do step 7.
See also [Update](../README.md#update).

## Rules

- Never print, log or commit secrets. The Cloudflare token never passes through you: the person adds it.
- Never edit anything in `.github/` or any `wrangler.jsonc`.
- If a command fails, stop and show the person the error. Do not work around it.
- Never delete the Garmin Worker: that erases everyone's data. For a lost encryption key see
  [Restore the encryption key](install-manual.md#restore-the-encryption-key).
