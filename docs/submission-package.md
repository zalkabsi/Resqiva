# PayPal AI Hackathon 2026 submission package draft

**Review state:** Local draft only. The source repository is public, but this is not ready to submit: PayPal Sandbox credentials are rejected, no buyer-approved capture is verified, there is no hosted judge demo, and the required public video is not recorded. Recheck [official rules](https://paypalaihackathon.devpost.com/rules) before use.

## Title

**Resqiva — Rescue food. Build meals. Pay intelligently.**

## Elevator pitch

Resqiva turns a shopper's meal preferences into practical bundles built from available surplus inventory. A pinned Fireworks model parses the request, then deterministic server-side rules validate stock, price, budget, store, pickup window, expiry, and dietary constraints before the shopper can reserve a bundle for PayPal Sandbox checkout.

## Project description draft

**Inspiration.** Surplus-food apps often begin with a discounted product list, while households still have to decide whether those items can make a meal for a real budget, group size, and pickup time. Resqiva explores whether a marketplace can turn those constraints into a transparent meal bundle.

**What it does.** Shoppers choose a fictional store, describe meals in natural language, set serving and budget limits, and compare bundles grounded in the seeded inventory. They can reserve a selected bundle. The merchant view shows demo inventory, orders, stock and price editing, CSV import, and paid-order pickup controls. A customer order-history API and receipt page are included.

**How it works.** `accounts/fireworks/models/deepseek-v4p1-flash-1017` parses preferences into a strict schema. It has no authority over product IDs, prices, stock, or payments. A deterministic optimizer checks inventory and hard constraints, calculates totals from integer-cent records, and returns explanations. The server reserves stock transactionally and the PayPal adapter uses Sandbox Orders API calls, idempotency keys, status queries, and webhook verification code.

**Current evidence.** The app's Fireworks-backed parser and planner passed a real local API smoke and browser E2E run. The suite passed 163 tests in 19 files; the updated E2E created a demo store and pickup window; local setup/migration/seed and the production build passed. PayPal Sandbox OAuth returned `invalid_client`; no buyer approval, capture, paid order, webhook delivery, or live payment reconciliation is verified. Do not describe checkout as completed until those steps pass with a matching Sandbox app and buyer.

**How it was built.** Next.js 16, React 19, TypeScript, PostgreSQL, Prisma 7, Zod, Fireworks AI, PayPal JavaScript SDK and Orders API Sandbox, Vitest, Playwright, and Docker Compose. Demo records are fictional and deterministic. The local starting checkout was empty; this implementation began on November 3, 2026.

**Challenges.** Designing the AI as a preference parser rather than a source of inventory or payment decisions; keeping reservations safe under concurrent updates; preserving unknown allergen metadata; and separating PayPal approval from a server-verified capture. The current blocker is a rejected Sandbox credential pair, plus missing buyer approval and webhook configuration.

**Accomplishments.** A real Fireworks-backed request flows through the app, returns validated preferences, and produces inventory-grounded meal plans. The API smoke verified exact reserved-unit release on cancellation and idempotent repeat handling. The shopper and merchant pages pass a browser test. The checkout failure is exposed truthfully rather than represented as a paid order.

The seeded optimizer benchmark compared 12 request/store scenarios with a greedy discount baseline: both were feasible in 11/12, the optimizer's emitted bundles had zero independently checked constraint violations, and median times were 5.201 ms and 4.990 ms respectively. This is a small in-process demo-data measurement and does not establish general superiority.

**Lessons learned.** AI can help translate preferences, while deterministic server rules should decide what is actually available and payable. A browser approval event is not proof of capture. Unknown food-safety metadata should remain unknown, and simulated records should not be turned into impact claims.

**Future work.** Verify the full Sandbox buyer approval/capture/inventory/pickup path, test actual webhook delivery and recovery, add scheduled reconciliation/refund handling, arrange free judge access, and only then record a truthful demonstration.

## Built-with tags

Next.js, React, TypeScript, PostgreSQL, Prisma, Fireworks AI, PayPal Sandbox, Zod, Vitest, Playwright, Docker Compose.

## Submission links (not ready)

- Repository: [`zalkabsi/Resqiva` on `work`](https://github.com/zalkabsi/Resqiva/tree/work) — public; GitHub detects the MIT license.
- Hosted demo: none. Render is unverified and is not required by the official rules if complete run instructions work.
- Public YouTube demo under three minutes: none recorded or uploaded.
- Local setup: [README.md](../README.md).
- Test evidence and blockers: [testing.md](testing.md) and [limitations.md](limitations.md).

## Video storyboard concept (165 seconds; record only after real capture works)

| Time | Scene | Evidence to show |
|---|---|---|
| 0–15 s | Introduce meal affordability and surplus problem | Describe the product without claiming measured real-world impact. |
| 15–35 s | Open the fictional merchant stock view | Show demo label, product quantity, discount price, and order/stock controls. |
| 35–65 s | Enter a natural-language request | Show the request and identify the exact Fireworks model in the narration or on-screen notes. |
| 65–95 s | Compare returned meal bundles | Show item-level inventory, quantities, recipe, pickup window, and calculated savings. |
| 95–125 s | Complete checkout | Only record after real Sandbox buyer approval, server capture, and saved paid status are verified. Never replace this with a mock or redirect. |
| 125–145 s | Show shopper receipt and merchant order | Verify the same paid order, pickup reference, inventory change, and later pickup status. |
| 145–165 s | Summarize actual prototype evidence | State real test counts and distinguish fictional demo units from real food diversion. |

If the payment blocker remains, do not present this as a completed-payment demo. Rework the story and get owner review before recording; the current project does not yet meet the intended successful-checkout narrative.

## Thumbnail concept (3:2)

Warm ivory background with a deep-green market basket at center, containing a short row of illustrated rescued ingredients. A clean recipe card overlaps the basket and shows a few inventory-backed ingredient rows and an honest total. Use a small PayPal Sandbox mark only if permitted; otherwise identify the integration in text. Main title: “Resqiva”; subtitle: “Surplus groceries → practical meals”. Keep the fictional-demo label visible and avoid impact numbers or merchant logos.

## Sponsor-prize eligibility checklist

| Sponsor / item | Current evidence | Claim status |
|---|---|---|
| PayPal Developer Platform | Orders API and JavaScript SDK Sandbox code exists; current Sandbox credentials are rejected and no transaction is verified. | Core integration intended; do not claim a working payment until live Sandbox capture passes. |
| AI tool | Real Fireworks parser call and browser planning passed with the required model. | Implemented and tested. |
| AG Grid | Merchant inventory uses a standard HTML table. | Not integrated; no AG Grid prize claim. |
| Channel3 | No product-catalog enrichment call exists. | Not integrated; no claim. |
| Render | A free Postgres database is provisioned; the app service is not. | No hosted demo URL has been verified; no deployment claim. |
| Postman | No Postman collection or public workspace has been prepared. | Not integrated; no claim. |

## Final access checklist

- [ ] Confirm owner/team eligibility.
- [ ] Replace the rejected credential pair through the secure managed environment with matching Sandbox app credentials.
- [ ] Use a Sandbox buyer to approve and verify order creation, capture, paid order, inventory update, merchant view, pickup confirmation, retry, and cancellation.
- [ ] Configure Sandbox `PAYPAL_WEBHOOK_ID` and verify delivery to a reachable HTTPS endpoint, including duplicate events.
- [ ] Ensure the managed network policy permits the PayPal browser SDK host through its approved configuration process.
- [ ] Provide judges free, unrestricted access through the December 1–15 judging period without asking them to supply a Fireworks key.
- [x] Push the repository publicly and verify the MIT license is detectable on GitHub.
- [ ] Obtain separate explicit owner approval for public hosting, video upload, and Devpost submission.
- [ ] Recheck rules, public URLs, license visibility, test evidence, and video duration immediately before submission.
