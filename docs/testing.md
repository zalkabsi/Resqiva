# Testing and verification

**Last verified:** November 3, 2026. Results below are from the current fresh implementation. Re-run them after code or environment changes.

## Automated results

| Command | Result | Evidence and boundary |
|---|---|---|
| `npm run lint` | Pass | ESLint completed with no findings. |
| `npm run typecheck` | Pass | Strict TypeScript check completed with no errors. |
| `npm test` | Pass: 40 tests in 5 files | Unit and route tests. PayPal and Fireworks client tests use mocked provider responses; they are not live payment evidence. |
| `npm run build` | Pass | Optimized Next.js production build completed, including `/orders/[orderId]` and `/api/orders`. |
| `npx prisma validate` | Pass | Prisma 7.10.1 schema validated. |
| `npm run demo:up` | Pass after stopping a leftover local dev process | A fresh Docker volume received the initial migration and seed; Next.js reached Ready on port 3000. Seed output: 3 fictional merchants/stores, 45 products, 6 recipes. |
| `npm run smoke:local` | Pass with live local app, database, and Fireworks | The app preference route returned validated preferences; planning returned 3 bundles; reservation held 3 units and cancellation restored them; repeated order-create and cancellation requests were exercised; customer history and merchant dashboard loaded. |
| `npm run e2e:local` | Pass: 1 Playwright browser test | Chromium opened the real app, called the configured Fireworks-backed planner through the UI, displayed inventory-grounded bundles, and loaded the merchant inventory workspace. This stops before PayPal approval/capture. |
| `npm run benchmark:optimizer` | Pass: 12 scenarios × 25 repetitions | Seeded inventory comparison against the greedy discount-ranking baseline; 11/12 scenarios feasible in both, 0 independent optimizer-output violations, median 4.721 ms vs 4.628 ms, p95 9.491 ms vs 10.036 ms. Full method and limits are in [optimization.md](optimization.md). |

The API smoke called the actual Resqiva preference route and an actual Fireworks API using only `accounts/fireworks/models/deepseek-v4p1-flash-1017`; this is live AI integration evidence. Its order-creation request returned HTTP 502 with a sanitized PayPal Sandbox credential rejection (`invalid_client`). Repeating the request did not create a payment. Cancellation succeeded twice and restored the exact reserved quantity. The webhook endpoint returned HTTP 503 because `PAYPAL_WEBHOOK_ID` is not configured. No buyer approval, capture, paid order, webhook delivery, or payment reconciliation was verified.

The smoke is an API/database integration check, not a browser E2E test. The Playwright test covers the shopper planning and merchant inventory views, not checkout. Both use fictional seeded data. No output from a mocked PayPal test should be presented as evidence of a real payment.

## Remaining test coverage

- The Vitest suite covers optimizer constraints, AI schema and prompt-injection rejection, exact PayPal money formatting, mocked Orders API and webhook verification, capture-evidence validation, and customer-order route authorization/payload.
- The optimizer microbenchmark independently checks emitted bundle totals, stores, inventory IDs, prices, stock, expiry, diet/allergen constraints, and records the seeded greedy comparison. It is not a production load test.
- The API smoke covers a real app-to-Fireworks request, plan generation, atomic reserve/release counts, retry behavior, cancellation idempotency, customer history, merchant data loading, and the webhook configuration blocker.
- There is no live Sandbox capture, browser PayPal SDK checkout, actual webhook signature delivery/replay test, concurrent last-unit database test, expiry integration test, or post-capture database-failure recovery test yet.
- Merchant pickup confirmation requires a genuinely captured order and therefore could not be exercised.
- A direct test against `/orders/[orderId]` after a paid order remains blocked by the missing capture. The page is production-build verified; customer history and its safe API output are tested separately.
- `npm audit --omit=dev` found zero production dependency vulnerabilities. Full `npm audit --audit-level=moderate` reported 17 moderate findings in the development ESLint dependency chain rooted in `minimatch`; npm reported no fix available. A dedicated credential scanner has not been run. `.env` is ignored and no secret value is intentionally stored in tracked files.

## Reproduce locally

Use Node.js 24+, npm, Docker Compose, and a local `.env` copied from `.env.example`.

```sh
npm ci
npm run demo:up
```

In a second terminal, run the app/database smoke check:

```sh
npm run smoke:local
```

For browser E2E, install Chromium with Playwright if a system Chromium is unavailable, then run:

```sh
npx playwright install chromium
npm run e2e:local
```

The current Playwright test uses the configured Fireworks key and makes a real preference-parser request. It does not require or exercise a PayPal buyer. To use an alternate local browser binary, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; to use a different local app URL, set `RESQIVA_BASE_URL`.

All live integration checks must use Sandbox credentials only. Never add keys, buyer passwords, tokens, webhook secrets, or private URLs to test output or documentation.
