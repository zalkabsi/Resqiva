# Resqiva

**Rescue food. Build meals. Pay intelligently.**

Resqiva is a local-first demonstration of a surplus-food marketplace. Shoppers describe meals and constraints in natural language; the app turns those preferences into meal bundles grounded in fictional store inventory. Deterministic server-side rules validate every item, quantity, price, store, pickup window, expiry date, dietary exclusion, and budget. A shopper can reserve one store's stock and continue to PayPal Sandbox checkout when valid Sandbox credentials are configured.

All merchants, stores, products, and pickup locations in the seed data are fictional. This is a hackathon project, not a live grocery marketplace.

## Current status

- Preference parsing has two explicit modes: the Fireworks integration uses `accounts/fireworks/models/deepseek-v4p1-flash-1017`, while `AI_PROVIDER=local` runs the deterministic, key-free demo parser. Neither mode selects inventory, sets prices, authorizes payment, or changes stock.
- The app has a deterministic meal optimizer, transactional stock reservations, merchant inventory editing and CSV import, demo-store and pickup-window management, order management, and customer/merchant payment-reconciliation controls. PayPal Sandbox routes and webhook verification are implemented.
- Customer order history and a receipt page are included; a receipt shows paid only after server-verified capture.
- A successful PayPal Sandbox order, buyer approval, and capture have **not** been verified. The currently configured Sandbox credentials were rejected by OAuth (`invalid_client`). A Sandbox buyer account is also needed for approval.
- The public source is on GitHub at [`work`](https://github.com/zalkabsi/Resqiva/tree/work), with the MIT license. The free Render demo is live at [resqiva.onrender.com](https://resqiva.onrender.com). Its Postgres database expires on December 5, 2026, before judging ends December 15; see [deployment status](docs/deployment.md).
- GitHub Actions passed on the final code update with lint, typecheck, 165 tests, and a production build. The built-in browser also verified the hosted health endpoint, shopper session, three demo stores, and sample meal plan. Detailed dates and scope are in [`docs/testing.md`](docs/testing.md).

## Local setup

### Prerequisites

- Node.js 24.x and npm (the exact Node version is in `.node-version`)
- Docker Compose
- A Fireworks API key for the Fireworks-backed preference parser (optional when using `AI_PROVIDER=local`)
- PayPal Sandbox client ID and secret for payment testing
- A PayPal Sandbox buyer account to approve checkout

The Fireworks key and PayPal credentials are optional for browsing the fictional stores and running local database setup, but their respective live integrations will not work without them. No production PayPal endpoint is supported.

### Configure and start

```sh
git clone <repository-url>
cd Resqiva
npm ci
cp .env.example .env
```

Edit `.env` locally. Set `SESSION_SECRET` to a random value with at least 32 bytes (for example, `openssl rand -hex 32`). For Fireworks-backed parsing, set `AI_PROVIDER=fireworks`, provide `FIREWORKS_API_KEY`, and use `AI_MODEL=accounts/fireworks/models/deepseek-v4p1-flash-1017`. For the free keyless parser, use `AI_PROVIDER=local`. For Sandbox checkout, set matching `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` values from the same PayPal Sandbox app. Add `PAYPAL_WEBHOOK_ID` only when testing against a webhook registered with PayPal. Never commit `.env`, API keys, client secrets, buyer credentials, access tokens, or webhook secrets.

Start the local database, apply migrations, load the deterministic demo catalog, and launch Next.js:

```sh
npm run demo:up
```

Open [http://localhost:3000](http://localhost:3000). The command starts PostgreSQL in Docker, generates the Prisma client, applies migrations, seeds the database, and starts the development server. Press `Ctrl-C` to stop Next.js; stop the database with `docker compose down`.

For a clean local database reset, run `npm run db:reset`. This deletes local database data, reapplies migrations, and runs the seed. To remove the Docker database volume as well, stop the app and run `docker compose down -v`; the next `npm run demo:up` recreates it.

## Using the demo

- The shopper workspace lets you choose one of three fictional stores, describe a meal request, set budget and servings, compare feasible bundles, and reserve inventory.
- The merchant workspace uses a fictional seeded merchant session. It shows inventory and orders, supports stock and price edits and CSV imports, demo-store and pickup-window management, and manual PayPal status reconciliation. It can confirm pickup for paid orders.
- Demo role sessions are intentionally simplified for judging and local use. They are not production authentication or real merchant account management.
- Resqiva must not display an order as paid based on a browser redirect or callback. Only a server-verified PayPal capture can mark an order paid. If payment status is uncertain, the reservation is held for reconciliation.

To import inventory, upload a CSV with these required headers: `sku,name,category,quantity,priceCents,originalPriceCents,expiresAt,expirationType`. The expiry date must be in the future, and expiration type must be known. Optional headers are `ingredients,allergens,allergenDataStatus,dietaryTags`. Choose the destination from the merchant's demo stores in the UI; the API also defaults to the first owned demo store when no `storeId` is supplied. Prices are integer cents, and submitted on-hand quantity cannot reduce units already reserved or sold. See the importer in `src/app/api/merchant/inventory/import/route.ts` for accepted values and validation.

## AI, inventory, and food safety

When `AI_PROVIDER=fireworks`, the Fireworks model extracts preferences such as budget, servings, dietary exclusions, allergies, pickup timing, and meal count. In `local` mode, a bounded deterministic parser handles supported requests without an external provider. In both modes, the server validates preferences, loads store inventory, and runs the deterministic optimizer. Product IDs, prices, stock, and checkout totals come from database records, not from the model or browser.

Unknown or incomplete allergen information stays unknown. Resqiva does not certify food as allergy-safe. Sample savings and surplus-unit counts are calculated from fictional demo records and do not establish real food-waste diversion or environmental impact. Each checkout is for one store; Resqiva does not provide escrow or automatic multi-merchant payment splitting.

## Verification commands

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e:local
npm run benchmark:optimizer
```

With the local app running, `npm run smoke:local` exercises the app API flow. It calls Fireworks when configured; the current live PayPal order attempt is rejected because the Sandbox credentials do not authenticate. Neither the smoke nor mocked provider tests prove buyer approval, capture, or a real transaction. See [`docs/testing.md`](docs/testing.md) for the latest run results and limitations.

## Project documentation

- [Architecture](docs/architecture.md)
- [Hackathon compliance and traceability](docs/hackathon-compliance.md)
- [Competitive analysis](docs/competitive-analysis.md)
- [PayPal integration](docs/paypal-integration.md)
- [Security notes](docs/security.md)
- [Optimization and benchmark method](docs/optimization.md)
- [Testing and verification](docs/testing.md)
- [Deployment status](docs/deployment.md)
- [Demo guide](docs/demo-guide.md)
- [Impact methodology](docs/impact-methodology.md)
- [Limitations](docs/limitations.md)
- [Submission setup](docs/submission-setup.md)

## License

Resqiva is released under the [MIT License](LICENSE).

