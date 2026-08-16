# Cloudflare Deployment

Agathos runs as two Cloudflare Workers:

- `agathos-evaluator` is a private Python Worker. It evaluates Agathos source
  and is reached through a Service Binding. Its isolated
  `workers/evaluator/wrangler.jsonc` sets `workers_dev: false`, so Wrangler does
  not publish a workers.dev URL for it; the interaction Worker can still call it
  through `AGATHOS_EVALUATOR`.
- `agathos-interactions` is the public TypeScript Worker. It verifies Discord
  signatures, handles PING and `/r` or `/roll`, and calls the evaluator.

The evaluator has no public route. Deploy it before the interaction Worker so
the `AGATHOS_EVALUATOR` Service Binding target exists. Do not add a route or
turn `workers_dev` back on: the Service Binding is the evaluator's production
ingress.

The interaction Worker binds one SQLite-backed Durable Object named
`ReplayGuard`. It transactionally claims each Discord application-command ID
before evaluator invocation and retains the claim for ten minutes. A replayed
ID receives a bounded ephemeral response and never reaches the evaluator.

## Prerequisites

Install Bun 1.3 or newer, `uv`, and Node.js 20.6 or newer. Bun manages the
TypeScript Worker's dependencies and scripts. Node remains required because
`pywrangler` currently invokes Wrangler through `npx` for Python Worker
deployments. Authenticate Wrangler before deploying:

```bash
cd workers/interactions
bunx wrangler login
```

Run all commands below from the repository root unless a `cd` is shown.

## Local Development

Install the Python dependencies and start the evaluator Worker:

```bash
cd workers/evaluator
uv sync
uv run pywrangler dev
```

In a second shell, install and start the interaction Worker:

```bash
cd workers/interactions
bun install
bun run dev
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
bun run test
bun run typecheck
```

The TypeScript tests use a mock evaluator binding. They do not require a
Cloudflare account or a Discord token.

## Secrets

The interaction Worker needs the Discord application's public key. Store it
as a Wrangler secret; do not put it in source control:

```bash
cd workers/interactions
bunx wrangler secret put DISCORD_PUBLIC_KEY
```

The evaluator Worker does not need Discord secrets. `DISCORD_APPLICATION_ID`,
`DISCORD_BOT_TOKEN`, and `DISCORD_GUILD_ID` are used only by the separate
command-registration script. For local registration, put those three names
in a local `.env` file or export them in the shell. `.env` is ignored by Git.

## Deploy

Deploy the private evaluator first:

```bash
cd workers/evaluator
uv sync
uv run pywrangler deploy
```

Deploy the public interaction Worker second:

```bash
cd workers/interactions
bun run deploy
```

The interaction deployment must retain the `AGATHOS_EVALUATOR` service binding
from `workers/interactions/wrangler.jsonc`, as well as the `REPLAY_GUARD`
Durable Object binding and its `new_sqlite_classes` migration. The evaluator
deployment has no Discord token and no public route.

## Register Commands

`register_commands.mjs` reads environment variables from the process. When run
from the repository root, Bun automatically loads the local `.env` file. You
can also export the variables explicitly:

```bash
export DISCORD_APPLICATION_ID="..."
export DISCORD_BOT_TOKEN="..."
export DISCORD_GUILD_ID="..."
bun scripts/register_commands.mjs
```

Guild registration is the development default because Discord updates guild
commands immediately:

```bash
bun scripts/register_commands.mjs
```

When the shell is already in `workers/interactions`, export the variables in
that shell before using the corresponding path to the root-level script:

```bash
bun ../../scripts/register_commands.mjs
```

The script sends the exact `/r` and `/roll` definitions to the guild endpoint.
Use global registration only after the guild deployment has been validated;
global command updates can take longer to appear:

```bash
bun scripts/register_commands.mjs --global
```

From `workers/interactions`, run
`bun ../../scripts/register_commands.mjs --global` instead.

The script uses Bun's built-in `fetch`, fails on any non-2xx Discord response,
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

Never deploy a pre-Durable-Object revision or configuration as a rollback. The
rollback target must be a known-good revision that includes the SQLite
`ReplayGuard` migration in `workers/interactions/wrangler.jsonc` with
`new_sqlite_classes`. If reverting interaction code to an older implementation,
retain the current post-migration migration configuration while deploying the
reverted code instead of restoring the old Worker configuration. Commit
`89eb927` or any earlier revision predates this migration and is not a valid
post-migration rollback target.

Use a clean checkout of the last known-good revision so the working tree with
the current deployment changes is not disturbed:

```bash
git worktree add ../agathos-rollback <known-good-revision>
cd ../agathos-rollback
cd workers/evaluator
uv sync
uv run pywrangler deploy
cd ../interactions
bun install --frozen-lockfile
bun run deploy
```

If only one Worker changed, deploy only that Worker's command from the
known-good checkout. Validate a signed PING and `/r` after rollback. Leave the
existing Discord command registrations unchanged unless the command schema
itself changed; rollback is a Worker deployment operation, not a registration
operation.
