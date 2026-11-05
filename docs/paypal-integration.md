# PayPal integration

**Status:** Sandbox integration is implemented, but an end-to-end Sandbox payment is unverified. Production payments are out of scope.

## Official flow

The intended flow follows PayPal's [Checkout integration guide](https://developer.paypal.com/checkout/integrate) and [Orders v2 guide](https://developer.paypal.com/api/rest/integration/orders-api): server creates an order, buyer approves it, and server captures it. A browser redirect or `onApprove` callback alone is not proof of payment. The backend checks PayPal's capture result before finalizing an order.

The browser sends a reservation identifier. The server reloads trusted inventory lines, verifies reservation state/expiry, and derives the integer-cents amount. Never accept a client-supplied total. Use [`PayPal-Request-Id`](https://developer.paypal.com/api/make-api-requests) for safe retries of create/capture operations.

## Target transaction flow

1. Transactionally reserve stock for one store and create a pending local order.
2. Create a PayPal Sandbox order from the trusted local total; persist the PayPal order ID and idempotency key.
3. Return only the buyer-approval URL and order metadata needed by the client.
4. On return, ask the server to capture; query/verify PayPal status and amount/currency.
5. Mark paid and commit stock only after verified successful capture.
6. On cancellation, decline, or reservation expiry, release stock safely.
7. Persist webhooks by unique event ID, verify signatures, and make duplicate processing idempotent.
8. If capture may have succeeded but local persistence failed, query PayPal and reconcile to `PAYMENT_EXCEPTION` or `PAID`; never guess.

Webhook registration requires an HTTPS listener and webhook ID. PayPal's [webhook guide](https://developer.paypal.com/api/rest/webhooks/rest/) describes signature verification and retry delivery. A simulator event is synthetic and does not prove a real webhook delivery.

## Current verification and blockers

- The real app order-create route reached Sandbox OAuth and received `invalid_client`. Matching Sandbox app credentials from the same app are required before a real order can be tested.
- Customer and merchant manual reconciliation controls are implemented and have mocked route/transition tests. No buyer-approved checkout, capture, recorded transaction ID, or live reconciliation has been verified.
- A webhook ID has not been configured and real webhook delivery is unverified.
- Tests that stub `fetch` may verify code paths, but must be labeled mocked and must not be presented as PayPal integration evidence.
- The application must not log credentials, OAuth tokens, or buyer secrets. Do not publish privileged test-account credentials.

This integration does not create escrow and does not split a single checkout across multiple merchants.
