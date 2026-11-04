# Deployment

**Status:** Render Blueprint prepared; not deployed or synced to the Render Dashboard.

## Render target

[`render.yaml`](../render.yaml) defines a Node web service and managed Postgres in Frankfurt. The web service runs on the smallest paid always-on plan, and Postgres uses the smallest paid plan so the database does not expire during the judging period. Render's current listed rates are about $7/month for the web service and $6/month for Postgres, or about $13/month before any additional usage. Confirm the current dashboard estimate before creating resources.

The Blueprint pins Node 24, runs Prisma migrations on startup, seeds the demo data once after the first successful deploy, and disables automatic deploys. Seed reruns preserve inventory counts, sold/reserved units, and pickup reservations. It generates `SESSION_SECRET` and prompts for `FIREWORKS_API_KEY` during the first Blueprint setup. Do not put secret values in this file or in GitHub.

The service would be publicly reachable at its Render URL. Demo login is enabled for judge access. PayPal credentials are intentionally not configured: the last Sandbox OAuth test returned `invalid_client`, and no buyer approval, capture, or webhook has been verified. Checkout must not be represented as a completed payment flow until those checks pass.

No Render resources have been created. Creating this Blueprint would incur the listed monthly charges and publish a public app, so both remain subject to the owner's explicit approval.

## Local deployment target

The reproducible path is PostgreSQL through Docker Compose, Prisma migrations/seeds, and the Next.js application. A fresh Docker volume received the migration and deterministic seed, and `npm run demo:up` started Next.js successfully after a leftover local dev process was stopped. Keep secrets in a local environment file that is excluded from Git; `.env.example` contains placeholders only.

The previous managed local environment reported an enforced restricted network policy allowing `api.fireworks.ai`, `api-m.sandbox.paypal.com`, and Prisma binary downloads. App-level Fireworks calls succeeded there. PayPal OAuth returned `invalid_client`; that environment's policy did not list `www.paypal.com` (browser JavaScript SDK) or `www.sandbox.paypal.com` (Sandbox buyer approval page).

## Hosted judge demo target

The uploaded master prompt requests a hosted demo that loads reliably, supports seeded interaction, uses the configured server-side AI key, and demonstrates Sandbox checkout. Before publishing a host:

1. Confirm app startup, migrations, and deterministic seed/reset from an empty database. Local startup was verified previously; repeat on the hosting provider.
2. Configure HTTPS, environment secrets, database backups/retention, health checks, and safe logs.
3. Verify that judges do not need to provide their own AI key.
4. Run the actual PayPal Sandbox buyer-approval/capture flow and verify merchant inventory changes.
5. Recheck free and unrestricted judge access through the judging period.
6. Obtain explicit owner approval before deploying publicly and incurring the monthly hosting charges.

Official rules allow complete local setup/run instructions instead of a hosted URL, so hosting is not an official requirement if the working repository is reproducible. No deployment has been attempted or verified.
