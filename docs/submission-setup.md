# Submission setup

**Status, checked November 5, 2026:** The source is public on GitHub at [`work`](https://github.com/zalkabsi/Resqiva/tree/work), and GitHub detects the MIT license. The free Render web service is live at [resqiva.onrender.com](https://resqiva.onrender.com). No video has been uploaded and no Devpost submission has been filed.

## Official requirements checked November 5, 2026

- Submission deadline: **November 12, 2026 at 12:00 p.m. Pacific Time / 11:00 p.m. Riyadh**.
- Submit a public repository containing source, required assets, complete setup/run instructions, and a visible open-source license.
- Provide a functional demo: either a hosted URL or complete setup instructions that let judges run the working project.
- Include a public or unlisted YouTube demonstration video under three minutes, with no password.
- Provide free, unrestricted access for judging from December 1 through December 15, 2026.
- Explain the use of PayPal Developer Platform and AI, and give judges any needed test instructions without publishing secrets.

Sources: [Official rules](https://paypalaihackathon.devpost.com/rules), [overview](https://paypalaihackathon.devpost.com/), and [FAQ](https://paypalaihackathon.devpost.com/details/faqs). Recheck the rules immediately before submitting.

## Current submission materials

- **Repository:** [`zalkabsi/Resqiva`, branch `work`](https://github.com/zalkabsi/Resqiva/tree/work); public with an MIT license.
- **Hosted demo:** [resqiva.onrender.com](https://resqiva.onrender.com). Browser verification confirmed health, demo shopper session, three fictional stores, and a sample plan with three feasible options under $25.
- **Video:** Not recorded or uploaded. See [demo narration](../submission-assets/resqiva-demo-narration.md) and [video production prompt](../submission-assets/resqiva-video-prompt.md). The video must be under three minutes and show the actual application.
- **Thumbnail:** [Devpost thumbnail](../submission-assets/resqiva-devpost-thumbnail.jpg), 3:2 JPG under 5 MB.
- **Testing evidence:** [testing.md](testing.md).
- **AI:** The Fireworks-backed parser and planner were exercised in a local run with `accounts/fireworks/models/deepseek-v4p1-flash-1017`. The free Render deployment uses `AI_PROVIDER=local` and makes no external AI calls.
- **PayPal:** Sandbox order/payment code is implemented, but the last OAuth attempt returned `invalid_client`. Buyer approval, capture, paid-order inventory update, and webhook delivery remain unverified. Do not describe checkout as a completed payment.

## Judge access to resolve

The current free PostgreSQL database expires **December 5, 2026**, before the judging period ends on December 15. The free web service can also sleep after 15 minutes without traffic. Arrange service/database continuity through judging or provide complete instructions for judges to run the project. The Fireworks-backed mode requires a valid key; the public free demo uses the keyless deterministic parser.

Keep API keys, PayPal secrets, buyer passwords, tokens, and webhook secrets out of public repository files and submission text. Use the official submission fields or another appropriate secure method for any required private test details.
