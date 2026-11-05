+# Deployment

**Status:** The free Render web service `resqiva` is live in Frankfurt at [resqiva.onrender.com](https://resqiva.onrender.com), connected to the free Postgres database `resqiva-db`. The built-in browser verified the health endpoint (`status: ok`), shopper session, all three fictional stores, and a sample plan that returned three feasible options within the default $25 budget. The free Blueprint is committed in [`render.yaml`](../render.yaml).

## Render target

The Blueprint defines a free Node web service and a free Render Postgres database, both in Frankfurt. Render currently limits free web services to 512 MB RAM: they spin down after 15 minutes without traffic and can take about a minute to wake. Free instance hours (750 hours per workspace per month) are shared across the workspace; My Workspace already has three other free web services.

The Postgres instance uses PostgreSQL 18 and 1 GB of storage. Render created it on November 5, 2026, and reports that it expires on **December 5, 2026 at 09:07 UTC**. Free Postgres has no backups; after expiry it is unavailable unless upgraded during Render's 14-day grace period, after which its data is deleted. This database will not remain available through the full judging window ending December 15.

The web service runs Prisma migrations and the idempotent demo seed on each start. That is safe on the free service, which can stop and restart after idle periods; seed reruns preserve live inventory counts, sold/reserved quantities, and pickup-window reservations. The Blueprint generates `SESSION_SECRET`, enables demo login, and links `DATABASE_URL` to the Render Postgres resource. Automatic deploys are off.

The hosted free deployment uses `AI_PROVIDER=local`: a bounded deterministic parser reads common dietary preferences and avoid terms, while budget, meal count, and servings come from validated form controls. It does not send requests to an AI provider or require an API key. The optional Fireworks path remains available when a valid key is configured separately; it is not enabled on this free deployment. PayPal Sandbox credentials are not configured: the last Sandbox OAuth test returned `invalid_client`, and no buyer approval, capture, or webhook has been verified. Checkout must not be represented as a completed payment flow until those checks pass.

GitHub Actions `Checks` passed on the final code update, including lint, typecheck, 165 tests, and production build. The database expires before the full judging window, and the free web service can sleep after 15 minutes without traffic.

References: [Render free plan limits](https://render.com/docs/free), [Blueprint YAML](https://render.com/docs/blueprint-spec).

## Local deployment target

The reproducible path is PostgreSQL through Docker Compose, Prisma migrations/seeds, and the Next.js application. A fresh Docker volume received the migration and deterministic seed, and `npm run demo:up` started Next.js successfully after a leftover local dev process was stopped. Keep secrets in a local environment file that is excluded from Git; `.env.example` contains placeholders only.

The previous managed local environment reported an enforced restricted network policy allowing `api.fireworks.ai`, `api-m.sandbox.paypal.com`, and Prisma binary downloads. App-level Fireworks calls succeeded there. PayPal OAuth returned `invalid_client`; that environment's policy did not list `www.paypal.com` (browser JavaScript SDK) or `www.sandbox.paypal.com` (Sandbox buyer approval page).

## Hosted judge demo target

The hosted demo is available for browsing and meal planning. These pieces remain before it can provide the full requested experience:

1. Replace the invalid PayPal Sandbox credential pair, configure a Sandbox buyer and webhook, then verify buyer approval, capture, and the matching inventory transition.
2. If the hackathon demo must demonstrate AI, configure a valid server-side Fireworks key and set `AI_PROVIDER=fireworks`; the deployed free parser is deterministic and does not make AI calls.
3. Arrange a database that remains available through December 15. The current free database expires December 5.
4. Verify free-tier capacity and service availability across the judging window.

Official rules allow complete local setup/run instructions instead of a hosted URL, so hosting is optional when a working repository is reproducible.

