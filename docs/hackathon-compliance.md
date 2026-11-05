# PayPal AI Hackathon 2026 compliance and traceability

**Status checked:** November 5, 2026. The public source repository and free hosted demo are available. The public video and Devpost entry are not complete.

| Requirement | Official source | Implementation / evidence | Status |
|---|---|---|---|
| Submit by November 12, 2026 at 12:00 p.m. Pacific Time | [Official rules](https://paypalaihackathon.devpost.com/rules) | Submission has not been filed. Recheck the current rules and deadline before filing. | Pending |
| Meet age, residency, and team eligibility | [Official rules](https://paypalaihackathon.devpost.com/rules), [FAQ](https://paypalaihackathon.devpost.com/details/faqs) | Eligibility must be confirmed by the entrant. | Entrant confirmation needed |
| Integrate PayPal Developer Platform and an AI tool, with PayPal central | [Overview](https://paypalaihackathon.devpost.com/), [official rules](https://paypalaihackathon.devpost.com/rules) | PayPal Sandbox checkout and Fireworks preference-parsing code are implemented. Fireworks mode was exercised locally; Sandbox OAuth returned `invalid_client`. | Partial; payment path unverified |
| Explain AI model and usage | [Overview](https://paypalaihackathon.devpost.com/) | Fireworks mode uses `accounts/fireworks/models/deepseek-v4p1-flash-1017` to parse preferences; deterministic server logic validates stock, price, budget, and other constraints. The free hosted demo uses a local deterministic parser. | Implemented; hosted demo does not make AI calls |
| Explain project creation or significant changes during the submission period | [Official rules](https://paypalaihackathon.devpost.com/rules) | The implementation began from an empty checkout on November 3, 2026. Describe its origin accurately in the submission. | Information ready |
| Provide public source, assets, setup instructions, and a visible open-source license | [Official rules](https://paypalaihackathon.devpost.com/rules) | [Public `work` branch](https://github.com/zalkabsi/Resqiva/tree/work) includes project source and the MIT license. | Verified |
| Provide a functional demo | [Official rules](https://paypalaihackathon.devpost.com/rules) | [Hosted demo](https://resqiva.onrender.com) is live. Browser verification covered health, demo shopper session, three fictional stores, and a sample meal plan. | Verified now; continuity needs a plan |
| Provide a public or unlisted YouTube video under three minutes | [Official rules](https://paypalaihackathon.devpost.com/rules) | Narration and an editing prompt are in [submission-assets](../submission-assets/). No video has been recorded or uploaded. | Pending |
| Provide free, unrestricted access through judging (December 1–15) | [Official rules](https://paypalaihackathon.devpost.com/rules) | The free Render database expires December 5; the Fireworks-backed path also requires a valid key. | Continuity plan needed |
| Address technology, design, impact, innovation, and presentation | [Official rules](https://paypalaihackathon.devpost.com/rules) | Tests, local integration evidence, and a seeded optimizer benchmark are documented. All food inventory is fictional and no real impact is claimed. | Partially evidenced |

## Current verified evidence

- GitHub Actions run #13 passed on the final code update: clean install, Prisma generation, lint, typecheck, 165 tests, and production build. Documentation update run #14 also passed.
- The built-in browser verified the hosted `/api/health` response, shopper session, three fictional stores, and a sample plan with three feasible options under $25.
- A local Fireworks-backed API smoke and browser E2E used the actual preference route and `accounts/fireworks/models/deepseek-v4p1-flash-1017`.
- Database-backed planning, a three-unit stock reservation and exact cancellation release, repeated requests, customer order history, and merchant dashboard data were exercised in the November 3 local smoke run.
- Mocked tests cover route and state transitions for PayPal, webhook signatures, reservation races, stock rules, and reconciliation. They are not live payment evidence.
- PayPal Sandbox OAuth returned `invalid_client`. No buyer approval, capture, paid status, sold-stock update, or webhook delivery is verified.
- The optimizer benchmark compared 12 seeded scenarios with a greedy baseline: feasibility matched at 11/12, with zero independently checked violations in the optimizer output. It does not establish general superiority.

See [testing.md](testing.md), [deployment.md](deployment.md), and [limitations.md](limitations.md) for detailed evidence and known limits. Do not publish secrets or claim a completed payment or measured food-waste reduction.
