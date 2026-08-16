# Cloudflare Deployment

Agathos runs as two Cloudflare Workers:

- `agathos-evaluator` is a private Python Worker. It evaluates Agathos source
  and is reached through a Service Binding.
- `agathos-interactions` is the public TypeScript Worker. It verifies Discord
  signatures, handles PING and `/r` or `/roll`, and calls the evaluator.

The evaluator has no public route. Deploy it before the interaction Worker so
the `AGATHOS_EVALUATOR` Service Binding target exists.

## Prerequisites

Install `uv`, Node.js 20.6 or newer, and Wrangler. This provides built-in
`fetch` support and the `--env-file` option used by the registration examples.
Authenticate Wrangler before deploying:

```bash
npx wrangler login
```

Run all commands below from the repository root unless a `cd` is shown.

## Local Development

Install the Python dependencies and start the evaluator Worker:

```bash
uv sync
uv run pywrangler dev --config wrangler.evaluator.jsonc
```

In a second shell, install and start the interaction Worker:

```bash
cd workers/interactions
npm install
npm run dev
```

To start both Workers through Wrangler's multi-config development command,
use this from the repository root instead:

```bash
npx wrangler dev \
  -c workers/interactions/wrangler.jsonc \
  -c wrangler.evaluator.jsonc
```

The interaction Worker uses the `AGATHOS_EVALUATOR` Service Binding in local
development. Discord requests must still have valid Ed25519 signatures, so
use the signed interaction fixtures in the TypeScript tests or a signed local
request when testing the HTTP endpoint.

## Tests

Run the Python evaluator and interpreter tests from the repository root:

```bash
uv run python -m unittest discover -s tests -v
```

Run the interaction Worker tests and type check:

```bash
cd workers/interactions
npm test
npm run typecheck
```

The TypeScript tests use a mock evaluator binding. They do not require a
Cloudflare account or a Discord token.

## Secrets

The interaction Worker needs the Discord application's public key. Store it
as a Wrangler secret; do not put it in source control:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY --config workers/interactions/wrangler.jsonc
```

The evaluator Worker does not need Discord secrets. `DISCORD_APPLICATION_ID`,
`DISCORD_BOT_TOKEN`, and `DISCORD_GUILD_ID` are used only by the separate
command-registration script. For local registration, put those three names
in a local `.env` file or export them in the shell. `.env` is ignored by Git.

## Deploy

Deploy the private evaluator first:

```bash
uv run pywrangler deploy --config wrangler.evaluator.jsonc
```

Deploy the public interaction Worker second:

```bash
cd workers/interactions
npx wrangler deploy
```

The interaction deployment must retain the `AGATHOS_EVALUATOR` service binding
from `workers/interactions/wrangler.jsonc`. The evaluator deployment has no
Discord token and no public route.

## Register Commands

`register_commands.mjs` reads environment variables from the process; it does
not load `.env` itself. From the repository root, either export the variables:

```bash
export DISCORD_APPLICATION_ID="..."
export DISCORD_BOT_TOKEN="..."
export DISCORD_GUILD_ID="..."
node scripts/register_commands.mjs
```

Or load the local `.env` file with Node. Guild registration is the development
default because Discord updates guild commands immediately:

```bash
node --env-file=.env scripts/register_commands.mjs
```

When the shell is already in `workers/interactions`, use the corresponding
path to the root-level script:

```bash
node --env-file=.env ../../scripts/register_commands.mjs
```

The same export-based setup works from `workers/interactions` with
`node ../../scripts/register_commands.mjs`.

The script sends the exact `/r` and `/roll` definitions to the guild endpoint.
Use global registration only after the guild deployment has been validated;
global command updates can take longer to appear:

```bash
node --env-file=.env scripts/register_commands.mjs --global
```

From `workers/interactions`, run
`node --env-file=.env ../../scripts/register_commands.mjs --global` instead.

The script uses Node's built-in `fetch`, fails on any non-2xx Discord response,
and never prints the bot token.

## Discord Interactions Endpoint

1. Deploy `agathos-evaluator`, deploy `agathos-interactions`, and set
   `DISCORD_PUBLIC_KEY` before configuring Discord.
2. In the Discord Developer Portal, open the application and select **General
   Information**.
3. Set **Interactions Endpoint URL** to the public URL printed for
   `agathos-interactions`, for example
   `https://agathos-interactions.<account-subdomain>.workers.dev/`.
4. Save the URL. Discord sends a signed PING while validating it; the Worker
   must return `{ "type": 1 }` with HTTP 200.
5. Confirm that a signed `/r` request returns an interaction response before
   switching command registration from the guild endpoint to `--global`.

The evaluator URL must not be used as Discord's endpoint. Invalid signatures
return HTTP 401, and the endpoint must be HTTPS and publicly reachable.

## Rollback

Use a clean checkout of the last known-good revision so the working tree with
the current deployment changes is not disturbed:

```bash
git worktree add ../agathos-rollback <known-good-revision>
cd ../agathos-rollback
uv sync
uv run pywrangler deploy --config wrangler.evaluator.jsonc
cd workers/interactions
npm ci
npx wrangler deploy
```

If only one Worker changed, deploy only that Worker's command from the
known-good checkout. Validate a signed PING and `/r` after rollback. Leave the
existing Discord command registrations unchanged unless the command schema
itself changed; rollback is a Worker deployment operation, not a registration
operation.
