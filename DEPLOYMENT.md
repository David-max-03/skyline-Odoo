# Deploying Skyline (Netlify + PostgreSQL)

Production runs on PostgreSQL. A serverless host such as Netlify has no disk
that lasts or is shared between instances, so nothing in production is kept in
local files: the database, sessions, uploads and rate-limit counters are all
in PostgreSQL. SQLite is for local development and tests only, and the server
refuses to use it on a serverless host.

Nothing here is automatic. A build or a deploy never changes the database
schema, never creates an account and never imports data. Each step below is a
command you run.

## What production needs

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Netlify | The **pooled** connection string (Neon: the host containing `-pooler`). Used by the running site |
| `DATABASE_URL_UNPOOLED` | your machine only | The **direct** connection string. Used by `db:migrate`, `db:status`, `admin:create`, `db:import` |
| `SKYLINE_RAZORPAY_MODE` | Netlify | `test`. Live mode is not supported by this version |
| `SKYLINE_RAZORPAY_KEY_ID` | Netlify | Razorpay test Key ID (`rzp_test_…`) |
| `SKYLINE_RAZORPAY_KEY_SECRET` | Netlify | The matching Key Secret |
| `SKYLINE_RAZORPAY_WEBHOOK_SECRET` | Netlify | The secret set on the Razorpay webhook |
| `NEXT_PUBLIC_CURRENCY`, `NEXT_PUBLIC_LOCALE`, `NEXT_PUBLIC_ORG_TZ`, `NEXT_PUBLIC_MEMBERSHIP_FEE_CENTS` | Netlify | Optional display settings; compiled in at build time |
| `SKYLINE_PG_POOL_MAX` | Netlify, optional | Connections each server instance may hold. Default 3 on a serverless host |
| `SKYLINE_UPI_ID`, `SKYLINE_UPI_PAYEE` | Netlify, optional | Only for the QR code on the manual membership form |

Must stay **unset** in production: `SKYLINE_DB_DRIVER`, `SKYLINE_DB_PATH`,
`SKYLINE_UPLOAD_DIR`, `SKYLINE_UPLOADS`, `SKYLINE_DEMO_MODE`, `SKYLINE_AUTO_SEED`,
`SKYLINE_DISABLE_RATE_LIMIT`, `SKYLINE_RAZORPAY_API_BASE`. (The rate-limit bypass
and SQLite are ignored on a serverless host even if set, and demo accounts
cannot exist on PostgreSQL, but leave them out anyway.)

Keep the connection strings in a Git-ignored file on your own machine, for
example `.env.neon`:

```
DATABASE_URL=postgres://…-pooler…/…?sslmode=verify-full
DATABASE_URL_UNPOOLED=postgres://…/…?sslmode=verify-full
```

`.gitignore` already ignores `.env*`. Never put a connection string in a
tracked file, a commit message or a chat.

**Do not name that file `.env.production.local`, `.env.production`, `.env.local`
or `.env`.** Next.js loads those automatically, so a local `npm start` (or any
local production-mode server) would connect to the production database
without being asked to. A name such as `.env.neon` is only read when you pass
it with `--env-file`. The commands below use `.env.neon`.

`sslmode=verify-full` checks the server's certificate. The `pg` driver
currently treats `require` the same way but warns that it will stop doing so
in its next major version; `verify-full` keeps the strict behaviour.

## 1. Create the database (Neon)

1. Create a Neon project in a region near your users. PostgreSQL 17 or 18 (see "What has been verified" below).
2. Copy both connection strings from the project's Connect dialog: the pooled
   one and the direct one. Put them in `.env.neon` as above.
3. Nothing else: Skyline creates its own tables and the `citext` extension.

## 2. Create the schema

```bash
npm run db:migrate -- --env-file .env.neon --dry-run   # shows what would run
npm run db:migrate -- --env-file .env.neon             # applies it
npm run db:status  -- --env-file .env.neon             # checks tables, keys and uniqueness rules
```

The schema is currently at version 4 (version 1 is the baseline; version 2 adds
volunteer requests; version 3 adds the column that lets the president disable a
committee account; version 4 adds the member link and one-time password links for
committee accounts managed from the web). A database at an older version must be migrated before this
build is deployed, or every data route answers 503. One `db:migrate` run applies
every missing version in order.

`db:migrate` is safe to run again; it does nothing when the schema is current.
Each migration and its record are one transaction, so a failure leaves nothing
behind. The running site checks the schema version when it connects and answers
503 if it is behind, so run `db:migrate` **before** deploying a build that
needs a newer schema.

## 3. Create the first administrator

```bash
npm run admin:create -- --email you@example.org --name "Your Name" --env-file .env.neon
```

You are asked for the password at a hidden prompt (at least 12 characters). It
is never taken from the command line or printed. The command refuses to run
when an administrator already exists; `--allow-additional` is the deliberate
override. There is no default account and no demo data on PostgreSQL.

## 4. Configure Netlify

1. Site configuration → Environment variables: add the variables in the table
   above (all scopes that include Functions and Builds).
2. `netlify.toml` in this repository sets the build command and Node 22.
3. Site configuration → Access & security: visitor access must allow the
   public to reach the site, or at least `/api/webhooks/razorpay`; Razorpay
   cannot log in to Netlify.
4. Deploy.

## 5. Razorpay webhook (test mode)

In the Razorpay dashboard, in Test Mode, add a webhook:

- URL: `https://<your-site>/api/webhooks/razorpay`
- Secret: a long random value; set the same value as `SKYLINE_RAZORPAY_WEBHOOK_SECRET` in Netlify, then redeploy
- Events: `payment.captured`, `order.paid`, `payment.failed`

To test it: make a test payment with the browser closed before it returns, or
use the dashboard's "send test webhook". A correct setup answers 200 with an
`outcome`; a wrong secret answers 401 `bad_signature`. Razorpay retries
anything that is not a 2xx, including a 503 while the database is unreachable,
so a payment that could not be recorded is delivered again.

## 6. Verify production

1. `GET /api/health` answers `{"data":{"status":"ok","database":"postgres"}}`.
2. Sign in at `/login` with the administrator you created; reload: still signed in.
3. Create a product and an event; register for the event from a private window.
4. Pay a membership in Razorpay test mode; confirm the member, the paid term,
   one settled ledger entry and the password link.
5. Place a merchandise order as that member and pay it online; confirm it is
   marked paid once and hand-over is still separate.
6. Upload a claim receipt; open it; redeploy; open it again (it is in the database).
7. `npm run db:status -- --env-file .env.neon` still passes.
8. Netlify function logs show no `database unavailable` lines.

## What has been verified

| What | PostgreSQL 17.7 (local, disposable) | Neon PostgreSQL 18.6 |
|---|---|---|
| Migration applied to an empty database | yes | yes |
| `db:status` (tables, keys, uniqueness rules, `citext`) | yes | yes |
| Connection through the pooled and the direct URL, with TLS | n/a | yes |
| Transaction advisory lock through the pooler | n/a | yes (read-only probe) |
| First administrator created with `admin:create` | yes (tests) | yes |
| Full test suite (`npm run test:pg`) | yes | **no** |
| End-to-end check of the production build (`npm run e2e:pg`) | yes | **no** |
| The application serving requests against it | yes | **no** |

So on PostgreSQL 18 the schema and the commands are verified, but the
application itself has not yet run a request against it. The schema and
queries use nothing specific to either version.

## Not yet verified on Netlify itself

These points can only be confirmed on the deployed site, and have not been:

- That the build and the functions work on Netlify at all with this version
  (bundling of the `pg` driver, the Node version, cold starts).
- Netlify's request-size limit for functions. Skyline accepts images up to
  5 MB; if Netlify's limit is lower, large uploads will be refused by Netlify
  before they reach Skyline. Test with a photo of 4–5 MB.
- The exact names of Netlify's dashboard menus above, which change over time.
- Connection time to Neon after it has been idle (about 3 seconds was seen from a laptop).
- That Netlify passes the visitor's address in `x-forwarded-for`, which the
  rate limiter uses. Without it every visitor shares one limit.

## Failure behaviour

| Situation | What happens |
|---|---|
| `DATABASE_URL` missing or wrong | Every data route answers 503 `database_unavailable`. The log names the reason, never the connection string. No local file is created |
| Schema older than the build | 503, with "schema is at version X but this build needs Y" in the log |
| Database unreachable during a payment | Nothing is marked paid. The webhook is retried by Razorpay; the member or applicant can also press "check" to reconcile |
| Payment recorded but member not created | The payment stays on record as "needs review" and is retried on the next visit, webhook or by a treasurer |

## Backups, rollback and recovery

- Neon keeps point-in-time restore history for the project (how far back depends on the plan).
- Rolling back the site: redeploy the previous Netlify deploy. A deploy never changes the schema, so the old build keeps working as long as the schema version matches.
- Migrations are forward-only. Before a migration that changes existing tables, create a Neon branch or restore point first.
- Your local SQLite database and uploads are never touched by any of these commands.

## Moving real data from SQLite (optional, not the default)

A new production database should start empty (steps 2 and 3). If you later
have real data in a SQLite file that must move, there is a separate tool:

```bash
npm run db:import -- --source data/backups/<backup>.db --env-file .env.neon          # dry run
npm run db:import -- --source data/backups/<backup>.db --env-file .env.neon --apply
```

It needs a backup file (not the live database) and an empty, migrated
destination. It copies every row with ids and relationships unchanged, in one
transaction, then compares row counts, ledger totals and payment/settlement
consistency with the source and rolls everything back on any difference.
Sessions and password links are not copied. It does not know which rows are
test data: do not import local test members, demo accounts or Razorpay test
payments into production.

## How concurrency is kept safe on PostgreSQL

SQLite allowed one writer at a time, and the code relies on it (member
numbers, stock, seats, recording a payment once). On PostgreSQL every write
transaction starts by taking the same transaction-level advisory lock, so two
write transactions never overlap on any instance. Unique constraints and
conditional updates stay underneath as a second line of defence. Calls to
Razorpay are always made outside a transaction.
