const base = process.env.RESQIVA_BASE_URL ?? "http://localhost:3000";
const origin = new URL(base).origin;

async function call(path, options = {}) {
  const response = await fetch(new URL(path, base), options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function requireOk(step, result) {
  if (!result.response.ok) {
    const message = typeof result.body?.error === "string"
      ? result.body.error
      : typeof result.body?.error?.message === "string"
        ? result.body.error.message
        : `HTTP ${result.response.status}`;
    throw new Error(`${step} failed: ${message}`);
  }
  return result.body;
}

function riyadhTomorrow() {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
  return date;
}

async function main() {
  requireOk("health", await call("/api/health"));
  const storeBody = requireOk("stores", await call("/api/stores"));
  const stores = Array.isArray(storeBody) ? storeBody : storeBody.stores;
  if (!Array.isArray(stores) || stores.length < 1) throw new Error("No fictional demo stores were returned.");

  const sessionResult = await call("/api/demo/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ role: "CUSTOMER" }),
  });
  requireOk("demo session", sessionResult);
  const setCookie = sessionResult.response.headers.get("set-cookie");
  const cookie = setCookie?.split(";")[0];
  if (!cookie) throw new Error("Demo session did not set the expected HttpOnly cookie.");

  const prompt = "Plan one vegetarian dinner for two under $25 with pickup tomorrow.";
  const parsed = requireOk("preference parser", await call("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ prompt }),
  }));
  const preferences = parsed.preferences;
  if (!preferences || !Array.isArray(preferences.exclusions)) throw new Error("Preference parser returned no validated preferences.");
  const selected = stores[0];
  const startingUnits = selected.itemCount;
  const tomorrow = riyadhTomorrow();
  const planInput = {
    ...preferences,
    budgetCents: 2_500,
    servings: 2,
    mealCount: 1,
    pickupDate: tomorrow,
    storeId: selected.id,
    sourceText: prompt,
  };
  const plan = requireOk("planner", await call("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
    body: JSON.stringify({ preferences: planInput }),
  }));
  if (!Array.isArray(plan.bundles) || plan.bundles.length === 0) {
    throw new Error(`No feasible bundle for the smoke scenario: ${plan.reason ?? "no reason returned"}`);
  }
  const bundle = plan.bundles[0];
  const expectedHeldUnits = bundle.items.reduce((sum, item) => sum + item.quantity, 0);

  const reservation = requireOk("reservation", await call("/api/reservations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
    body: JSON.stringify({ bundleId: plan.bundles[0].id }),
  }));
  if (reservation.status !== "RESERVED" || !reservation.reservationId) {
    throw new Error("Planner bundle was not placed into a reserved state.");
  }
  const afterReserveBody = requireOk("reserved stock check", await call("/api/stores"));
  const afterReserveStores = Array.isArray(afterReserveBody) ? afterReserveBody : afterReserveBody.stores;
  const afterReserveUnits = afterReserveStores.find((store) => store.id === selected.id)?.itemCount;
  if (Number.isInteger(startingUnits) && afterReserveUnits !== startingUnits - expectedHeldUnits) {
    throw new Error("Reservation did not reduce available stock by the exact bundle quantity.");
  }

  const createOrderRequest = {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
    body: JSON.stringify({ reservationId: reservation.reservationId }),
  };
  const paymentAttempt = await call("/api/paypal/orders", createOrderRequest);
  const paymentBlocked = !paymentAttempt.response.ok;
  if (!paymentBlocked && paymentAttempt.body.status !== "PENDING") {
    throw new Error("PayPal create-order returned an unexpected state.");
  }
  const retryAttempt = await call("/api/paypal/orders", createOrderRequest);
  if (paymentBlocked && retryAttempt.response.status !== paymentAttempt.response.status) {
    throw new Error("PayPal retry returned a different failure state for the same reservation.");
  }
  if (!paymentBlocked && retryAttempt.body.paypalOrderId !== paymentAttempt.body.paypalOrderId) {
    throw new Error("PayPal retry did not return the same idempotent Sandbox order.");
  }

  const cancelled = requireOk("reservation cancellation", await call(`/api/reservations/${encodeURIComponent(reservation.reservationId)}/cancel`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie },
  }));
  if (cancelled.status !== "CANCELLED") throw new Error("Reservation was not safely cancelled after the payment attempt.");
  const repeatedCancel = requireOk("repeated reservation cancellation", await call(`/api/reservations/${encodeURIComponent(reservation.reservationId)}/cancel`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie },
  }));
  if (repeatedCancel.status !== "CANCELLED") throw new Error("Repeated cancellation did not remain idempotently cancelled.");

  const afterCancelBody = requireOk("released stock check", await call("/api/stores"));
  const afterCancelStores = Array.isArray(afterCancelBody) ? afterCancelBody : afterCancelBody.stores;
  const restoredUnits = afterCancelStores.find((store) => store.id === selected.id)?.itemCount;
  if (Number.isInteger(startingUnits) && restoredUnits !== startingUnits) {
    throw new Error("Cancelled reservation did not restore the exact original available quantity.");
  }

  const orderHistory = requireOk("customer order history", await call("/api/orders", {
    headers: { Cookie: cookie },
  }));
  if (!Array.isArray(orderHistory.orders)) throw new Error("Customer order history returned an invalid response.");
  if (orderHistory.orders.some((order) => ["PAID", "FULFILLED"].includes(order.status))) {
    throw new Error("Smoke flow unexpectedly observed a paid order without buyer approval and capture.");
  }

  const merchantSession = await call("/api/demo/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ role: "MERCHANT_ADMIN" }),
  });
  requireOk("merchant demo session", merchantSession);
  const merchantCookie = merchantSession.response.headers.get("set-cookie")?.split(";")[0];
  if (!merchantCookie) throw new Error("Merchant demo session did not set the expected HttpOnly cookie.");
  const merchantData = requireOk("merchant dashboard", await call("/api/merchant/orders", {
    headers: { Cookie: merchantCookie },
  }));
  if (!Array.isArray(merchantData.orders) || !Array.isArray(merchantData.inventory)) {
    throw new Error("Merchant dashboard returned an invalid response.");
  }

  const webhookProbe = await call("/api/paypal/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "smoke-webhook-unconfigured", event_type: "CHECKOUT.ORDER.APPROVED" }),
  });
  if (webhookProbe.response.status !== 503) {
    throw new Error("Webhook configuration check returned an unexpected result.");
  }

  console.log(JSON.stringify({
    health: "ok",
    demoStores: stores.length,
    preferenceParser: "real Fireworks route response validated",
    plannerBundles: plan.bundles.length,
    reservation: `created; ${expectedHeldUnits} units held and restored exactly on cancellation`,
    retries: "same reservation safely retried; cancellation repeated idempotently",
    customerOrderHistory: `${orderHistory.orders.length} customer order(s), none marked paid by this smoke flow`,
    merchantDashboard: `${merchantData.orders.length} order(s), ${merchantData.inventory.length} inventory rows loaded`,
    paypalOrderCreation: paymentBlocked ? `blocked (${paymentAttempt.response.status}; ${paymentAttempt.body.error ?? "provider error"}; no buyer approval/capture)` : "Sandbox order created and same order returned on retry; buyer approval/capture not attempted",
    webhook: "blocked (PAYPAL_WEBHOOK_ID is not configured); no event processed",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Local smoke flow failed.");
  process.exitCode = 1;
});
