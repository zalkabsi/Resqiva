# Architecture

**Status:** Implemented local demo architecture; live PayPal completion remains unverified.

## Components

- **Next.js and TypeScript application:** customer marketplace, meal planning, merchant inventory/order screens, and server routes.
- **Customer receipts:** `/api/orders` returns the signed-in demo shopper's safe order summary; `/orders/[orderId]` displays the matching receipt after server capture.
- **PostgreSQL and Prisma:** fictional demo merchants, products and stock, pickup windows, plan runs, reservations, orders, payment references, webhook events, audit records, and impact counters.
- **Preference parser:** supports a Fireworks-backed mode using `accounts/fireworks/models/deepseek-v4p1-flash-1017` and a bounded deterministic local mode for the free hosted demo. Both produce validated preference objects; neither can select inventory or authorize financial actions.
- **Deterministic optimizer:** matches recipes to real inventory and enforces hard constraints before scoring preferences. It is the authority for product selection and math.
- **Reservation/order service:** transactionally reserves stock, computes order totals from database records, and tracks status transitions.
- **PayPal adapter:** server-side Sandbox OAuth, Orders v2 creation/capture/query, idempotency, and webhook verification.

## Request flow

1. Client submits natural-language preferences.
2. Parser returns a Zod-validated preference object; it cannot return inventory IDs, prices, payment decisions, or stock changes.
3. Server loads eligible products and pickup windows from the selected store.
4. Optimizer rejects candidates violating budget, stock, selected store, pickup, serving, expiry, allergen, or explicit exclusion constraints.
5. Client selects a returned bundle ID. The server recomputes it and atomically reserves the exact stock.
6. Server derives the PayPal order amount from reserved database line items and creates a Sandbox order with an idempotency key.
7. Buyer approves in PayPal; server captures and checks PayPal's result before marking the order paid and inventory committed.
8. A verified webhook can reconcile delayed or uncertain events idempotently. Redirects are not payment evidence.

## Invariants

- Money is stored and calculated as integer minor units; no floating-point payment math.
- Stock reservation uses database concurrency controls so two buyers cannot reserve the same final unit.
- Browser-provided amounts and AI-generated values never authorize a payment.
- Webhook event IDs and PayPal operation request IDs are unique/idempotent.
- Unknown allergen data stays unknown; the system does not certify allergy safety.
- There is no escrow or automatic multi-merchant split. Each checkout is for one merchant/store.

## Reservation and order states

The target state vocabulary is `PENDING`, `RESERVED`, `PAYMENT_APPROVED`, `PAID`, `CANCELLED`, `EXPIRED`, `FULFILLED`, and `PAYMENT_EXCEPTION`. Transitions must be enforced server-side and reconciled to PayPal capture status. A late capture after reservation expiry is a payment exception requiring reconciliation, not a normal paid transition.

## Verification status

The November 3 local API smoke and Playwright browser test exercised the actual Fireworks parser route and planner with `accounts/fireworks/models/deepseek-v4p1-flash-1017`. The free Render demo uses the local parser; its health, shopper session, seeded stores, and sample planner flow were browser-verified. GitHub Actions passed on the final code update with 165 tests and a production build. PayPal OAuth returned `invalid_client`, so buyer approval, capture, sold-stock finalization, webhook delivery, and payment recovery remain unverified. See [testing.md](testing.md).
