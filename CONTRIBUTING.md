# Contributing

Thanks for helping improve Resqiva. Keep changes focused and explain how you verified them.

## Local setup

1. Use Node.js 24 or later and Docker Compose.
2. Copy `.env.example` to `.env`, set a private `SESSION_SECRET`, and configure provider credentials only in your local environment.
3. Run `docker compose up -d db`, `npm install`, `npm run db:deploy`, and `npm run db:seed`.
4. Run `npm run lint`, `npm run typecheck`, and `npm test` before opening a pull request.

Never include `.env`, tokens, API keys, real payment details, or real customer data in a change.

## Product invariants

- AI may parse preferences and explain results; deterministic server code owns inventory, prices, reservations, payment totals, and order states.
- Keep money in integer minor units and use PayPal Sandbox only.
- Do not claim a provider call, payment, benchmark, or test succeeded unless it was actually run.
- Keep all demo merchants and products fictional and visibly labeled.
