# Deployment

**Status:** Not deployed. Render is a proposal from the Resqiva master prompt, not verified hosting.

## Local deployment target

The reproducible path is PostgreSQL through Docker Compose, Prisma migrations/seeds, and the Next.js application. A fresh Docker volume received the migration and deterministic seed, and `npm run demo:up` started Next.js successfully after a leftover local dev process was stopped. Keep secrets in a local environment file that is excluded from Git; `.env.example` contains placeholders only.

The managed environment currently reports an enforced restricted network policy allowing `api.fireworks.ai`, `api-m.sandbox.paypal.com`, and Prisma binary downloads. Required AI/model and PayPal client runtime bindings report ready; app-level Fireworks calls succeeded. PayPal OAuth returned `invalid_client`. The current policy does not list `www.paypal.com` (browser JavaScript SDK) or `www.sandbox.paypal.com` (Sandbox buyer approval page).

## Hosted judge demo target

The uploaded master prompt requests a hosted demo that loads reliably, supports seeded interaction, uses the configured server-side AI key, and demonstrates Sandbox checkout. Before publishing a host:

1. Confirm app startup, migrations, and deterministic seed/reset from an empty database. Local startup was verified; repeat on the hosting provider.
2. Configure HTTPS, environment secrets, database backups/retention, health checks, and safe logs.
3. Verify that judges do not need to provide their own AI key.
4. Run the actual PayPal Sandbox buyer-approval/capture flow and verify merchant inventory changes.
5. Recheck free and unrestricted judge access through the judging period.
6. Obtain explicit owner approval before deploying publicly.

Official rules allow complete local setup/run instructions instead of a hosted URL, so hosting is not an official requirement if the working repository is reproducible. No deployment has been attempted or verified.
