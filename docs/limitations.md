# Limitations and known blockers

**Status and official rules checked:** November 5, 2026. The free Render demo is live and browser-verified. GitHub Actions passed on the final code update with 165 tests and a production build. This is a hackathon demonstration, not a production marketplace.

## Live integration and submission blockers

- **PayPal Sandbox:** The last OAuth test returned `invalid_client`. The app's order-create route cannot progress to buyer approval, capture, order confirmation, or the sold-stock update until matching Sandbox credentials from the same app authenticate. Keep credential values private.
- **Buyer approval:** A Sandbox buyer account must approve checkout after merchant OAuth works. No order has been buyer-approved or captured.
- **Webhook:** A Sandbox webhook ID is not configured for the service, and real webhook delivery is unverified. Signature verification tests are mocked, not delivery evidence.
- **AI:** The Fireworks-backed preference route and planner were exercised locally with `accounts/fireworks/models/deepseek-v4p1-flash-1017`. The free Render demo uses `AI_PROVIDER=local` and makes no external AI calls.
- **Judge access:** The hosted demo is live, but its free PostgreSQL database expires December 5, before the judging period ends December 15. The free web service can also sleep after 15 minutes without traffic. Arrange continued access or provide complete run instructions.
- **Publication:** source is public at [`work`](https://github.com/zalkabsi/Resqiva/tree/work), the MIT license is detectable, and the hosted demo is live. No YouTube video has been uploaded and no Devpost entry has been filed.
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
