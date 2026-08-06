# Deploying the WTFU backend

This environment's network policy currently blocks outbound access to
`api.cloudflare.com`, so these commands can't be run from this Claude Code
session. Run them yourself (locally, or from a Claude Code environment whose
network policy allows Cloudflare) from the repo root, in order.

Do **not** run `wrangler login`. Use the scoped API tokens as environment
variables instead — narrower blast radius than a full account login.

## 0. Install dependencies

```bash
npm install
```

## 1. Create the D1 database and load the schema

Use the D1/Workers-scoped token for this step.

```bash
export CLOUDFLARE_API_TOKEN=<your D1/Workers token>

npx wrangler d1 create wtfu-db
```

This prints a `database_id`. Copy it into `wrangler.toml`, replacing
`REPLACE_AFTER_WRANGLER_D1_CREATE` under `[[d1_databases]]`.

Then load the schema into the **remote** (production) database — this
creates tables, it does not touch/overwrite anything since the database is
brand new:

```bash
npx wrangler d1 execute wtfu-db --remote --file=./schema.sql
```

## 2. Create / confirm the R2 bucket

Use the R2-scoped token for this step (swap the env var).

```bash
export CLOUDFLARE_API_TOKEN=<your R2 token>

npx wrangler r2 bucket create wtfu-uploads
```

If the bucket already exists, this command will report that instead of
erroring destructively — nothing gets overwritten.

## 3. Deploy the Worker

Switch back to the D1/Workers token (deploy needs Workers + D1 + R2 binding
permissions together).

```bash
export CLOUDFLARE_API_TOKEN=<your D1/Workers token>

npx wrangler deploy
```

The command output includes the live `*.workers.dev` URL — that's what gets
sent to Chad for the `game.wakethefupnow.com` DNS record (Section 6, step 8
of the backend plan).

## 4. Smoke test

```bash
curl -X POST https://<your-worker>.workers.dev/api/players \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Player","avatar":"star-green"}'

curl https://<your-worker>.workers.dev/api/leaderboard
```

## Notes

- If `wrangler` can't resolve which Cloudflare account to use (token valid
  for more than one account), set `CLOUDFLARE_ACCOUNT_ID=<account id>` from
  the Cloudflare dashboard sidebar before running the commands above.
- CORS is currently wide open (`Access-Control-Allow-Origin: *`) in
  `src/index.js` so it works from any origin during testing. Once the
  frontend's real domain (`game.wakethefupnow.com`) is known, tighten that
  to the specific origin.
- Frontend wiring (pointing the HTML file's fetch calls at these routes) is
  explicitly out of scope for this step per the backend plan — that's next.
