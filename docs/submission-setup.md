# Submission setup

**Status:** Source is public on GitHub at [`work`](https://github.com/zalkabsi/Resqiva/tree/work); GitHub detects the MIT license. The free Render Postgres database is available in Frankfurt and expires on December 5, 2026. The web service is not deployed yet, so no Render URL exists. No video upload or Devpost submission has been made.

## Official requirements checked November 4, 2026

- Deadline: **November 12, 2026 at 12:00 p.m. Pacific Time / 11:00 p.m. Riyadh**.
- Submit a public repository containing source, assets, full setup/run instructions, and an OSI-approved open-source license.
- Provide a functional demo, either hosted or runnable by judges from complete setup instructions. Public hosting is optional under the rules.
- Provide a public YouTube video under three minutes showing the actual application.
- Judges must have free, unrestricted access from December 1, 2026 at 2:00 p.m. through December 15, 2026 at 8:00 a.m. Pacific. A key-requiring local setup alone does not yet meet that need for Resqiva.
- The open-source license must be detectable in the public repository's About section.
- Explain the meaningful PayPal Developer Platform and AI use, provide requested test account details through an appropriate secure method, and address the judging criteria.

Sources: [Official rules](https://paypalaihackathon.devpost.com/rules), [overview](https://paypalaihackathon.devpost.com/), and [FAQ](https://paypalaihackathon.devpost.com/details/faqs). Recheck them before submission. Lint, typecheck, unit tests, and production build passed November 4; API smoke and browser E2E evidence remains dated November 3.

## Prepared materials

See [submission-package.md](submission-package.md) for draft title, pitch, project description, technical facts, video storyboard, thumbnail concept, built-with tags, and sponsor eligibility notes. That draft deliberately separates tested AI behavior from the unverified PayPal payment flow.

## Current submission links

- **Repository:** [`zalkabsi/Resqiva`](https://github.com/zalkabsi/Resqiva/tree/work) is public on branch `work`. The root page serves the pushed branch and detects the MIT license.
- **Hosted demo:** Not deployed. The free database is provisioned; the web service still needs the Blueprint applied through the signed-in Render Dashboard. It will be publicly reachable with demo login enabled once deployed.
- **Video:** None recorded or uploaded.
- **Testing evidence:** [`testing.md`](testing.md).
- **Model:** `accounts/fireworks/models/deepseek-v4p1-flash-1017`; app-level parser and planner usage passed with the real provider.
- **PayPal:** Client ID and secret bindings report ready, but the last actual Sandbox OAuth test on November 3 returned `invalid_client`; no buyer approval or capture is verified. `PAYPAL_WEBHOOK_ID` is absent from the current environment bindings.
- **Network policy:** As observed November 4, the environment is connected/running and policy is enforced. The API host is allowed, but `www.paypal.com` and `www.sandbox.paypal.com` remain absent from the host allowlist.

## Judge access blocker

Local instructions are reproducible and Docker-based. The hosted Fireworks key is not configured, so the AI preference parser will not work until a valid key is entered securely in Render. The free Postgres database expires December 5, before the judging window ends December 15; arrange a replacement or upgrade before then to keep the hosted demo available.

## Publication gate

The owner authorized free Render deployment and the source push is complete. The free database is provisioned, but the web service is not deployed yet. Public video upload and Devpost submission still need separate explicit approval. Do not put API keys, PayPal secrets, buyer passwords, tokens, or webhook secrets in public files or submission text.
