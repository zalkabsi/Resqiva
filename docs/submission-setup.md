# Submission setup

**Status:** Source is public on GitHub at [`work`](https://github.com/zalkabsi/Resqiva/tree/work); GitHub detects the MIT license. No Render URL exists; no deployment, video upload, or Devpost submission has been made.

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
- **Hosted demo:** None. No Render URL exists; Render remains a proposal only.
- **Video:** None recorded or uploaded.
- **Testing evidence:** [`testing.md`](testing.md).
- **Model:** `accounts/fireworks/models/deepseek-v4p1-flash-1017`; app-level parser and planner usage passed with the real provider.
- **PayPal:** Client ID and secret bindings report ready, but the last actual Sandbox OAuth test on November 3 returned `invalid_client`; no buyer approval or capture is verified. `PAYPAL_WEBHOOK_ID` is absent from the current environment bindings.
- **Network policy:** As observed November 4, the environment is connected/running and policy is enforced. The API host is allowed, but `www.paypal.com` and `www.sandbox.paypal.com` remain absent from the host allowlist.

## Judge access blocker

Local instructions are reproducible and Docker-based. A working plan requires a Fireworks API key; public docs contain only placeholders. The managed environment's key is not for redistribution. To give judges a free, unrestricted working demo, configure a hosted server-side key or another owner-approved access arrangement, and verify access throughout judging. The current account setup does not satisfy this yet.

## Publication gate

The owner authorized and the source push is complete. Public deployment, uploading a video, and submitting to Devpost still need separate explicit approval. No deployment, video upload, or Devpost submission has been made. Do not put API keys, PayPal secrets, buyer passwords, tokens, or webhook secrets in public files or submission text.
