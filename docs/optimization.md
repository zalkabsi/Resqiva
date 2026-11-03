# Meal bundle optimization

## Hard constraints

Reject a bundle if any of these fail:

- Total price exceeds the shopper's integer-cent budget.
- Requested servings cannot be met by the recipe quantities.
- Requested inventory quantity is unavailable.
- Items are from more than the selected checkout store.
- Store pickup window is incompatible with requested pickup time.
- Explicit dietary exclusions or known allergens conflict with an item.
- Product fails the configured sell-by/best-before eligibility policy.
- Any recipe item lacks an inventory record or verified price.

Unknown allergen metadata is not proof of absence. The UI must disclose unknowns rather than label a meal allergy-safe.

## Soft preferences and objective

After hard feasibility checks, score eligible combinations using transparent, documented weights for preference match, ingredient completeness, recipe feasibility, savings, surplus expiry urgency, and number of meals/servings. Hard constraints always dominate this score. Savings are calculated as `sum(original unit cents × quantity) − sum(discounted unit cents × quantity)` from inventory records. Pantry staples are disclosed and are not charged as stocked items.

## Seeded inventory benchmark

**Executed:** November 3, 2026 with `npm run benchmark:optimizer` against the fictional PostgreSQL seed.

The script loaded the next active pickup window and eligible inventory for each store: 15 Green Basket records, 15 Corner Harvest records, and 14 Market Lane records (44 eligible records total). It ran four requests per store: one vegetarian dinner, one vegan dinner, two vegetarian dinners with a peanut exclusion, and one unrestricted dinner. Each of the 12 store/request scenarios was repeated 25 times. The greedy discount-ranking baseline used the same generated recipe candidates and hard filters.

| Measure | Bounded optimizer | Greedy discount baseline |
|---|---:|---:|
| Feasible scenarios | 11 / 12 | 11 / 12 |
| Independently checked violations in returned bundles | 0 | Baseline returns only feasibility/status, not bundles |
| Median solver time | 4.721 ms | 4.628 ms |
| p95 solver time | 9.491 ms | 10.036 ms |
| First bundle lower total than feasible baseline | 10 / 11 | — |
| First bundle higher total than feasible baseline | 1 / 11 | — |

Both methods rejected the same two-meal vegetarian/peanut-exclusion request at Corner Harvest. The optimizer's first bundle was lower-priced in ten feasible comparisons and higher-priced in one. The optimizer does not claim to beat the baseline overall: median runtime was slightly slower in this run, feasibility was equal, and this small seeded sample does not establish general performance or superiority. The objective also weighs meal fit, savings, and inventory, rather than minimizing price alone.

The independent output check verifies bundle budget, meal/serving count, selected store, inventory IDs, item prices/quantities, expiry through pickup, explicit allergens/unknown allergen metadata, dietary tags, stock totals, and cents arithmetic. It found zero violations among returned bundles. The timing is an in-process microbenchmark, not end-to-end request latency or a production load test.

Reproduce with a prepared local database and `.env`:

```sh
npm run demo:prepare
npm run benchmark:optimizer
```

The benchmark uses only fictional records. It says nothing about real food availability or environmental impact.
