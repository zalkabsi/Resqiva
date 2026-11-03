# Limitations and known blockers

**Status checked:** November 3, 2026. This is a local hackathon demonstration, not a production marketplace.

## Live integration and submission blockers

- **PayPal Sandbox:** The app's order-create route reaches the Sandbox API, but OAuth rejects the current bound credentials with `invalid_client`. The UI cannot progress to buyer approval, capture, order confirmation, or the sold-stock update until a matching Sandbox client ID and secret from the same app are configured. Do not send credential values in chat.
- **Buyer approval:** A Sandbox buyer account must approve checkout after merchant OAuth works. No order has been buyer-approved or captured.
- **PayPal browser network access:** managed egress is restricted and enforced. `api-m.sandbox.paypal.com` is allowed; `www.paypal.com` (SDK) and `www.sandbox.paypal.com` (approval page) are not in the current effective allowlist. Browser checkout may fail until both are added by the environment owner through the supported policy workflow. No network bypass was attempted.
- **Webhook:** `PAYPAL_WEBHOOK_ID` is missing, and the local app does not have a public HTTPS address registered for PayPal delivery. The endpoint correctly returns an unconfigured response. Signature verification tests are mocked, not delivery evidence.
- **Fireworks:** The configured model and Fireworks key are ready, and the real app preference route succeeded in both API smoke and Playwright UI checks using only `accounts/fireworks/models/deepseek-v4p1-flash-1017`.
- **Judges:** There is no hosted demo. The local setup is reproducible, but successful AI planning requires a Fireworks key; the project does not currently provide judges a free, unrestricted working deployment.
- **Publication:** the existing GitHub slug was empty when this fresh local build began. The local source and MIT license are prepared, but nothing has been pushed. A public repository, video upload, public deployment, and Devpost submission each need explicit owner approval.
- **Trademark:** the Resqiva name has not been cleared through a complete trademark search.

## Product limitations

- All merchants, products, stores, pickup points, recipes, and orders in the local seed are fictional. They do not represent real listings, partnerships, or available food.
- The merchant demo has a shared seeded merchant identity. It supports demo-store and pickup-window creation/editing, inventory edits/import, and manual customer/merchant reconciliation. It does not provide real merchant signup, individual accounts, tenant isolation, store deletion, scheduled reconciliation, or refunds.
- Reconciliation controls only query PayPal and finalize a locally valid capture or safely release a reservation after verified void status. The paths have mocked tests but could not be exercised against the live Sandbox because OAuth fails; ambiguous states remain held for later checks.
- Rate limiting uses process-local memory. It is not shared across app instances and is not suitable for scaling.
- `npm audit --omit=dev` reports zero production dependency findings. Full `npm audit` reports 17 moderate development-tool findings rooted in `minimatch`, with no fix available from npm. A dedicated secret scan and comprehensive security review remain outstanding.
- Demo sessions are signed, short-lived cookies for fixed shopper/merchant demo identities. The same shopper or merchant identity is shared by local demo users; this is not real account authentication or tenant isolation.
- A completed capture is required before pickup can be confirmed. That path could not be exercised while Sandbox OAuth is rejected.
- Current smoke/E2E evidence does not cover concurrent buyers competing for the final unit, reservation expiry under database load, webhook replay through the route, or recovery after an actual PayPal capture and local database failure.

## Food, AI, and impact boundaries

- Allergen information is only as complete as the fictional merchant record. Unknown or partial metadata stays unknown; Resqiva does not guarantee safety for allergies.
- Expiry fields distinguish known types in the database, but merchant-provided dates are not independently verified. Items past the selected pickup eligibility cutoff are excluded by deterministic rules.
- AI parses shopper preferences only. It does not choose actual stock, invent products, certify food safety, price a basket, authorize payments, or change inventory.
- Displayed savings and surplus units are calculations over recorded fictional prices and quantities. They are not evidence of real food-waste diversion or environmental benefit.
- Each payment is for one selected store. Resqiva provides no escrow and no automatic multi-merchant payment split.
- Production PayPal payments are unsupported; checkout must remain in Sandbox.
