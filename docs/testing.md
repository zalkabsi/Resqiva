# Testing and verification

**Last verified:** November 5, 2026. GitHub Actions run #13 passed on the final code update, including clean install, Prisma generation, lint, typecheck, 165 tests, and production build. Documentation-only run #14 also passed. In the built-in browser, the deployed service returned `/api/health` status `ok`; the shopper session, three fictional stores, and a sample plan with three feasible options under $25 were verified. The Render deployment is live on commit `923fc653e2117ef795ec1670b248413197a6a88f`. Earlier database smoke/E2E/benchmark results below are from November 3.

## Automated results

| Command | Result | Evidence and boundary |
|---|---|---|
| `npm run lint` | Pass | ESLint completed with no findings. |
| `npm run typecheck` | Pass | Strict TypeScript check completed with no errors. |
| `npm test` | Pass: 165 tests in 19 files (November 5 CI) | Unit and route tests. Provider, database-race, and reconciliation tests use controlled mocks; they are not live payment evidence. |
| `npm run build` | Pass (November 5 CI) | Optimized Next.js production build completed, including `/orders/[orderId]` and `/api/orders`. |
| `npx prisma validate` | Pass | Prisma 7.10.1 schema validated. |
| GitHub Actions `Checks` | Pass, run #13 for code; run #14 for docs | Run #13: clean `npm ci`, Prisma client generation, lint, typecheck, 165 tests, and production build on Node 24.22.1. [Run #14](https://github.com/zalkabsi/Resqiva/actions/runs/42005848058) also passed for the documentation update. |
| `npm run demo:up` | Pass after stopping a leftover local dev process | A fresh Docker volume received the initial migration and seed; Next.js reached Ready on port 3000. Seed output: 3 fictional merchants/stores, 45 products, 6 recipes. |
| `npm run smoke:local` | Pass with live local app, database, and Fireworks | The app preference route returned validated preferences; planning returned 3 bundles; reservation held 3 units and cancellation restored them; repeated order-create and cancellation requests were exercised; customer history and merchant dashboard loaded. |
| `npm run e2e:local` | Pass: 1 Playwright browser test | Chromium called the configured Fireworks-backed planner through the UI, displayed inventory-grounded bundles, loaded merchant inventory, created a fictional demo store, and created a pickup window. It stops before PayPal approval/capture. |
| `npm run benchmark:optimizer` | Pass: 12 scenarios × 25 repetitions | Seeded inventory comparison against the greedy discount-ranking baseline; 11/12 scenarios feasible in both, 0 independent optimizer-output violations, median 5.201 ms vs 4.990 ms, p95 24.117 ms vs 21.259 ms. Full method and limits are in [optimization.md](optimization.md). |

The November 3 local API smoke called the actual Resqiva preference route and Fireworks API using `accounts/fireworks/models/deepseek-v4p1-flash-1017`; this is live AI integration evidence for the configured Fireworks mode. It returned 3 planner bundles, held and restored 3 units exactly, retried/cancelled idempotently, and loaded customer and merchant data. Its order-creation request returned HTTP 502 with a sanitized PayPal Sandbox credential rejection (`invalid_client`). Repeating the request did not create a payment. The webhook endpoint returned HTTP 503 because `PAYPAL_WEBHOOK_ID` was not configured in that environment. No buyer approval, capture, paid order, webhook delivery, or live payment reconciliation was verified. The current free Render deployment uses `AI_PROVIDER=local` and makes no external AI calls.

The smoke is an API/database integration check, not a browser E2E test. The Playwright test covers shopper planning and basic merchant store/pickup creation, not inventory editing, CSV import, or checkout. Both use fictional seeded data. No output from a mocked PayPal test should be presented as evidence of a real payment.

## Remaining test coverage

- The Vitest suite covers optimizer constraints, AI schema and prompt-injection rejection, exact PayPal money formatting, mocked Orders API and webhook verification, capture/reservation state transitions and races, bounded request bodies, merchant store and pickup-window validation, inventory ownership/stock safety, manual reconciliation authorization, and customer-order route authorization/payload.
- The optimizer microbenchmark independently checks emitted bundle totals, stores, inventory IDs, prices, stock, expiry, diet/allergen constraints, and records the seeded greedy comparison. It is not a production load test.
- The API smoke covers a real app-to-Fireworks request, plan generation, atomic reserve/release counts, retry behavior, cancellation idempotency, customer history, merchant data loading, and the webhook configuration blocker.
- There is no live Sandbox capture, browser PayPal SDK checkout, actual webhook signature delivery/replay test, concurrent last-unit database test, expiry integration test, or post-capture database-failure recovery test yet.
- Merchant pickup confirmation requires a genuinely captured order and therefore could not be exercised. Customer and merchant reconciliation controls only have mocked provider coverage; they have not been verified against live Sandbox statuses.
- A direct test against `/orders/[orderId]` after a paid order remains blocked by the missing capture. The page is production-build verified; customer history and its safe API output are tested separately.
- `npm audit --omit=dev` found zero production dependency vulnerabilities. Full `npm audit --audit-level=moderate` reported 17 moderate findings in the development ESLint dependency chain rooted in `minimatch`; npm reported no fix available. A dedicated credential scanner is unavailable in this environment; `.env` is ignored/untracked, and a manual source scan found only short test placeholders, not credentials.

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
