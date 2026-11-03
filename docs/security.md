# Security notes

**Status:** Core demo controls are implemented and partially tested. This is not a comprehensive security audit.

## Required controls

- Keep Fireworks and PayPal credentials server-side in environment bindings. Commit placeholders only; never log keys, tokens, or secret-bearing request headers.
- Pin AI configuration to `AI_PROVIDER=fireworks` and `AI_MODEL=accounts/fireworks/models/deepseek-v4p1-flash-1017`. Misconfiguration must fail explicitly; no alternate model or silent fallback.
- Parse model output with a strict schema, impose input/output limits and timeouts, and treat user/product text as untrusted data. The model has no tool or database-write access.
- Recompute every selected item, quantity, price, discount, and payment total from database records on the server.
- Validate request bodies, authorize merchant ownership, rate-limit public routes, and sanitize errors/logs.
- Use transactions, unique constraints, compare-and-decrement stock updates, idempotency keys, and webhook event deduplication to prevent replay and overselling.
- Verify PayPal webhook signatures with the registered webhook ID before acting on events.
- Keep unknown allergen metadata unknown; do not make safety certifications from model output.
- Restrict the demo to PayPal Sandbox. Never switch to production silently.
- Run dedicated secret scanning, resolve or document dependency findings, and complete a security review before public release.

## Threat cases to test

- Client modifies price/total or submits another bundle/reservation ID.
- Concurrent attempts to buy the final unit.
- Malicious instructions in product text or natural-language preferences.
- Model outputs a nonexistent product, quantity, allergen claim, or payment instruction.
- Duplicate create/capture calls, replayed webhook IDs, forged webhook signatures.
- Capture succeeds while the database request times out or reservation expires.
- Merchant user changes another merchant's inventory/order.

## Evidence

The current Vitest suite includes AI output/prompt-injection checks, payment amount and capture validation, and customer order-history authorization tests. API smoke checked normal customer and merchant reads but did not exercise hostile authorization cases end to end. `npm audit --omit=dev` reported zero production dependency vulnerabilities. Full `npm audit` reported 17 moderate findings in the development ESLint dependency chain rooted in `minimatch`; npm reported no fix available. A dedicated secret scanner, comprehensive security review, database concurrency security test, and penetration test have not been run. See [testing.md](testing.md) and [limitations.md](limitations.md).
