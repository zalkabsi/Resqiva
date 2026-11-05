# PayPal AI Hackathon 2026 submission package draft

**Review state:** Submission copy is drafted. The public repository and hosted free demo are available, and the free demo was browser-verified. The video is not recorded, PayPal Sandbox checkout is not verified, and the free database expires before the judging period ends. Recheck [official rules](https://paypalaihackathon.devpost.com/rules) before submission.

## Title

**Resqiva — Rescue food. Build meals. Pay intelligently.**

## Elevator pitch

**Rescue surplus groceries. Build meals that fit your budget.**

Resqiva turns a shopper's meal request into practical bundles built from available surplus inventory. A Fireworks-backed parser is available for natural-language preferences; the free hosted demo uses a deterministic local parser. Server-side rules validate stock, price, budget, store, pickup window, expiry, and dietary constraints. PayPal Sandbox checkout code is included, but a successful payment has not been verified.

## Project description draft

**Inspiration.** Surplus-food apps often begin with a discounted product list, while households still have to decide whether those items can make a meal for a real budget, group size, and pickup time. Resqiva explores whether a marketplace can turn those constraints into a transparent meal bundle.

**What it does.** Shoppers choose a fictional store, describe meals in natural language, set serving and budget limits, and compare bundles grounded in the seeded inventory. They can reserve a selected bundle. The merchant view shows demo inventory, orders, stock and price editing, CSV import, and paid-order pickup controls. A customer order-history API and receipt page are included.

**How it works.** In Fireworks mode, `accounts/fireworks/models/deepseek-v4p1-flash-1017` parses preferences into a strict schema. In the free hosted mode, a bounded deterministic parser handles supported requests without external AI calls. Neither parser has authority over product IDs, prices, stock, or payments. A deterministic optimizer checks inventory and hard constraints, calculates totals from integer-cent records, and returns explanations. The server reserves stock transactionally. The PayPal adapter includes Sandbox Orders API calls, idempotency keys, status queries, and webhook verification.

**Current evidence.** The Fireworks-backed parser and planner passed a real local API smoke and browser E2E run. The latest code workflow passed lint, typecheck, 165 tests, and the production build. The free Render deployment is live; the built-in browser verified the health endpoint, shopper session, all three fictional stores, and a sample plan with three feasible options under $25. PayPal Sandbox OAuth returned `invalid_client`; no buyer approval, capture, paid order, webhook delivery, or live payment reconciliation is verified. Do not describe checkout as completed.

**How it was built.** Next.js 16, React 19, TypeScript, PostgreSQL, Prisma 7, Zod, Fireworks AI, PayPal JavaScript SDK and Orders API Sandbox, Vitest, Playwright, and Docker Compose. Demo records are fictional and deterministic. The local starting checkout was empty; this implementation began on November 3, 2026.

**Challenges.** Designing the AI as a preference parser rather than a source of inventory or payment decisions; keeping reservations safe under concurrent updates; preserving unknown allergen metadata; and separating PayPal approval from a server-verified capture. The current blocker is a rejected Sandbox credential pair, plus missing buyer approval and webhook configuration.

**Accomplishments.** A real Fireworks-backed request flows through the app, returns validated preferences, and produces inventory-grounded meal plans. The API smoke verified exact reserved-unit release on cancellation and idempotent repeat handling. The shopper and merchant pages pass a browser test. The checkout failure is exposed truthfully rather than represented as a paid order.

The seeded optimizer benchmark compared 12 request/store scenarios with a greedy discount baseline: both were feasible in 11/12, the optimizer's emitted bundles had zero independently checked constraint violations, and median times were 5.201 ms and 4.990 ms respectively. This is a small in-process demo-data measurement and does not establish general superiority.

**Lessons learned.** AI can help translate preferences, while deterministic server rules should decide what is actually available and payable. A browser approval event is not proof of capture. Unknown food-safety metadata should remain unknown, and simulated records should not be turned into impact claims.

**Future work.** Resolve the Sandbox credentials and verify buyer approval, capture, inventory updates, pickup, and webhook delivery. Arrange demo access that lasts through the judging period. Record the actual application with truthful narration and submit before the deadline.

## Built-with tags

Next.js, React, TypeScript, Node.js, PostgreSQL, Prisma, Zod, Fireworks AI, PayPal Developer Platform, PayPal Sandbox, Render, Docker Compose, Vitest, Playwright, AI, FoodTech, Meal Planning, Food Waste.

## Submission links (not ready)

- Repository: [`zalkabsi/Resqiva` on `work`](https://github.com/zalkabsi/Resqiva/tree/work) — public; GitHub detects the MIT license.
- Hosted demo: [resqiva.onrender.com](https://resqiva.onrender.com), verified in the built-in browser. The free database expires December 5, before judging ends December 15.
- Public YouTube demo under three minutes: none recorded or uploaded.
- Local setup: [README.md](../README.md).
- Test evidence and blockers: [testing.md](testing.md) and [limitations.md](limitations.md).

## Video narration and editing prompt

The [narration script](../submission-assets/resqiva-demo-narration.md) targets about 2 minutes 20 seconds. The [production prompt](../submission-assets/resqiva-video-prompt.md) asks for real app footage, Microsoft Bing/Azure Speech narration, readable subtitles, and clear disclosure of the hosted parser and unverified PayPal flow. The video has not been recorded or uploaded.

## Thumbnail

Upload the generated [3:2 Resqiva thumbnail](../submission-assets/resqiva-devpost-thumbnail.jpg). It uses an illustrated basket and meal-planning card, with no embedded text or third-party marks.

## Sponsor-prize eligibility checklist

| Sponsor / item | Current evidence | Claim status |
|---|---|---|
| PayPal Developer Platform | Orders API and JavaScript SDK Sandbox code exists; current Sandbox credentials are rejected and no transaction is verified. | Core integration intended; do not claim a working payment until live Sandbox capture passes. |
| AI tool | Real Fireworks parser call and browser planning passed with the required model. | Implemented and tested. |
| AG Grid | Merchant inventory uses a standard HTML table. | Not integrated; no AG Grid prize claim. |
| Channel3 | No product-catalog enrichment call exists. | Not integrated; no claim. |
| Render | The free web service is live with the free Postgres database. | Hosted demo is verified; the database expires December 5, before judging ends December 15. |
| Postman | No Postman collection or public workspace has been prepared. | Not integrated; no claim. |

## Final access checklist

- [ ] Confirm owner/team eligibility.
- [ ] Configure a matching Sandbox app credential pair before retesting checkout; keep the values private.
- [ ] Use a Sandbox buyer to approve and verify order creation, capture, paid order, inventory update, merchant view, pickup confirmation, retry, and cancellation.
- [ ] Configure Sandbox `PAYPAL_WEBHOOK_ID` and verify delivery to a reachable HTTPS endpoint, including duplicate events.
- [ ] Provide judges free, unrestricted access through the December 1–15 judging period; the current free database expires December 5.
- [x] Push the repository publicly and verify the MIT license is detectable on GitHub.
- [ ] Recheck rules, public URLs, license visibility, test evidence, and video duration immediately before submission.

