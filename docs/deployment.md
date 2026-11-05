# Deployment

**Status:** The free Render Postgres database `resqiva-db` is available in Frankfurt. The web service has not been deployed yet, so there is no public app URL. The free Blueprint is committed in [`render.yaml`](../render.yaml).

## Render target

The Blueprint defines a free Node web service and a free Render Postgres database, both in Frankfurt. Render currently limits free web services to 512 MB RAM: they spin down after 15 minutes without traffic and can take about a minute to wake. Free instance hours (750 hours per workspace per month) are shared across the workspace; My Workspace already has three other free web services.

The Postgres instance uses PostgreSQL 18 and 1 GB of storage. Render created it on November 5, 2026, and reports that it expires on **December 5, 2026 at 09:07 UTC**. Free Postgres has no backups; after expiry it is unavailable unless upgraded during Render's 14-day grace period, after which its data is deleted. This database will not remain available through the full judging window ending December 15.

The web service runs Prisma migrations and the idempotent demo seed on each start. That is safe on the free service, which can stop and restart after idle periods; seed reruns preserve live inventory counts, sold/reserved quantities, and pickup-window reservations. The Blueprint generates `SESSION_SECRET`, enables demo login, and links `DATABASE_URL` to the Render Postgres resource. Automatic deploys are off.

No `FIREWORKS_API_KEY` is configured on the hosted target. The meal-preference endpoint will report that the required Fireworks model is not configured until an owner adds a valid key through Render's Environment settings. Do not put the key in this repository or share it in chat. PayPal Sandbox credentials are also not configured: the last Sandbox OAuth test returned `invalid_client`, and no buyer approval, capture, or webhook has been verified. Checkout must not be represented as a completed payment flow until those checks pass.

Render's authenticated Dashboard is needed to apply the Blueprint and create the web service. The existing free database's name, database name, user, PostgreSQL version, and region match `render.yaml`, so the Blueprint can attach it. Once the Blueprint is applied, verify the deploy, seeded data, health endpoint, demo login, and public app URL in the built-in browser.

References: [Render free plan limits](https://render.com/docs/free), [Blueprint YAML](https://render.com/docs/blueprint-spec).

## Local deployment target

The reproducible path is PostgreSQL through Docker Compose, Prisma migrations/seeds, and the Next.js application. A fresh Docker volume received the migration and deterministic seed, and `npm run demo:up` started Next.js successfully after a leftover local dev process was stopped. Keep secrets in a local environment file that is excluded from Git; `.env.example` contains placeholders only.

The previous managed local environment reported an enforced restricted network policy allowing `api.fireworks.ai`, `api-m.sandbox.paypal.com`, and Prisma binary downloads. App-level Fireworks calls succeeded there. PayPal OAuth returned `invalid_client`; that environment's policy did not list `www.paypal.com` (browser JavaScript SDK) or `www.sandbox.paypal.com` (Sandbox buyer approval page).

## Hosted judge demo target

The hosted demo needs further work before it can provide the complete requested experience:

1. Apply the Blueprint from the Render Dashboard, then verify build/start, migrations, idempotent seed, `/api/health`, demo login, and the public URL.
2. Add a valid server-side Fireworks key through Render's secure Environment settings to enable natural-language preference parsing.
3. Replace the invalid PayPal Sandbox credential pair, configure a Sandbox buyer and webhook, then verify buyer approval, capture, and the matching inventory transition.
4. Arrange a database that remains available through December 15. The current free database expires December 5.
5. Verify free-tier capacity and service availability across the judging window.

Official rules allow complete local setup/run instructions instead of a hosted URL, so hosting is optional when a working repository is reproducible. No live Render web service or app URL has been verified yet.
