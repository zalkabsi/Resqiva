# Build and submission checklist

Repository rules and managed-environment status were rechecked November 4, 2026. Product smoke, browser E2E, and live integration evidence below is dated November 3; lint, typecheck, unit tests, and production build were rerun November 4. “Implemented” means source exists; “verified” means the listed check actually ran. See [testing.md](testing.md) for scope and limitations.

## Product

- [x] Shopper can choose a fictional store, enter preferences, and receive inventory-grounded meal bundles. API smoke and Playwright UI test passed.
- [x] Deterministic optimizer tests cover budget, serving, stock, store, pickup, expiry, explicit exclusions, and allergen constraints.
- [x] Seeded optimizer benchmark compared 12 store/request scenarios with a greedy discount baseline; feasibility matched at 11/12, returned optimizer bundles had 0 independently checked violations, and runtime results are recorded in [optimization.md](optimization.md). No general superiority claim is made.
- [x] Unknown/partial allergen status is preserved; the optimizer does not treat unknown data as allergy-safe.
- [x] Price, comparable value, and savings use integer cents and inventory-derived values.
- [x] No feasible bundle returns a constraint explanation instead of relaxing constraints silently.
- [x] Merchant can view inventory and orders, edit stock/prices without reducing committed units, import CSV to a selected demo store, create/edit demo stores and pickup windows, manually reconcile PayPal status, and confirm pickup for paid orders. E2E created a demo store and pickup window; inventory editing/import and paid-order pickup still lack browser/live-payment coverage.
- [x] Shopper order-history API and receipt page are implemented; authorization/payload tests pass. No paid receipt exists because live capture is blocked.
- [x] Clean database setup produced 3 fictional merchants/stores, 45 products, and 6 recipes.
- [x] Demo seed updates leave live inventory, sold/reserved quantities, and pickup-window reservations untouched on reruns (code-path reviewed; the database rerun was not exercised this turn).
- [x] Demo-store setup, pickup-window CRUD, and manual customer/merchant reconciliation actions are implemented and covered by route/unit tests. Real account signup, authentication, tenant isolation, store deletion, scheduled reconciliation, and refunds are not provided.

## AI and payments

- [x] App calls only `accounts/fireworks/models/deepseek-v4p1-flash-1017`; live Resqiva route request and Playwright planning both succeeded.
- [x] No alternate model or silent fallback is configured.
- [x] AI output cannot select inventory IDs, set totals, authorize payment, or mutate stock; schema tests and code path separate it from financial actions.
- [x] Server recomputes totals from saved inventory and uses a serializable stock reservation; API smoke verified reserve and exact release counts.
- [ ] PayPal Sandbox order creation, buyer approval, capture, paid status, and sold-inventory update are not verified. Current OAuth attempt returned `invalid_client`.
- [x] Cancellation and retry behavior were exercised in the local API smoke. Retry was blocked by credential rejection; it did not create a provider order.
- [ ] Reservation expiry and concurrent final-unit access against a real database, actual webhook delivery/replay, and reconciliation after successful capture plus database failure remain untested. Transition and route tests use controlled mocks.
- [ ] A matching PayPal Sandbox app credential set, Sandbox buyer approval, `PAYPAL_WEBHOOK_ID`, and reachable HTTPS webhook endpoint are required for the remaining live payment checks.

## Quality and submission

- [x] Clean local Postgres migration/seed and `npm run demo:up` startup verified.
- [x] `npm run db:generate`, `npx prisma validate`, `npm run lint`, `npm run typecheck`, `npm test` (163/163 in 19 files), and `npm run build` passed on Node 24.22.1 November 4. The built-in browser loaded the production homepage and confirmed the database-aware health response. `npm run smoke:local` and `npm run e2e:local` passed November 3; see [testing.md](testing.md) for dates and scope.
- [x] `npm audit --omit=dev` found no production dependency advisories.
- [ ] Full `npm audit` reports 17 moderate development-tool dependency findings rooted in `minimatch`, with no fix available. A dedicated credential scanner is unavailable, and a formal penetration test remains outstanding; a manual multi-agent source review and staged-file credential-pattern scan found no credentials.
- [x] Public source is pushed at [`work`](https://github.com/zalkabsi/Resqiva/tree/work); the public GitHub page and branch return HTTP 200 and display the detected MIT license.
- [ ] Free, unrestricted judge access from Dec 1, 2026 at 2:00 p.m. Pacific to Dec 15, 2026 at 8:00 a.m. Pacific is not ready: no public demo, and a local AI run requires the configured Fireworks credential.
- [ ] Public YouTube demo under three minutes is not recorded or uploaded.
- [x] Official rules and deadline were rechecked November 4, 2026; final submission content still needs owner review.
- [ ] Hosted demo is unverified and not deployed; no Render URL exists. A paid Render Blueprint is prepared in [`render.yaml`](../render.yaml), with current listed service costs of about $13/month combined. Hosting is optional under official rules when complete local run instructions work.
- [x] Pushed `work` to `origin` after the user authorized it. Public deployment, video upload, and Devpost submission remain gated on separate explicit approval.

## Exact external blockers

- **PayPal account:** the client ID and secret bindings report ready, but the last actual Sandbox OAuth test on November 3 returned `invalid_client`. Replace them in the managed environment with a matching pair from the same Sandbox app; do not send values in chat.
- **Buyer account:** a Sandbox buyer must approve the browser checkout after the merchant app credential issue is fixed.
- **Network policy:** as observed November 4, the environment is connected/running and restricted egress is enforced. It allows `api-m.sandbox.paypal.com` and `api.fireworks.ai`, but not `www.paypal.com` (browser SDK) or `www.sandbox.paypal.com` (buyer approval page). Add those hosts only through the managed environment's approved network configuration; no bypass was attempted.
- **Webhook:** `PAYPAL_WEBHOOK_ID` is absent from the current managed environment bindings, and there is no public HTTPS endpoint for PayPal delivery.
- **Judge access:** a stable publicly accessible demo or an approved plan for free, unrestricted judge access is still needed. Local setup is reproducible but needs a Fireworks key to use AI.
- **Publishing approvals:** source push is complete. Public deployment, video upload, and Devpost submission still require explicit approval.
