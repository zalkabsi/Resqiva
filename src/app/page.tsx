"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import type { PlannedBundle, PlannerPreferences } from "@/lib/contracts";

type Store = {
  id: string;
  name: string;
  merchantName?: string;
  neighborhood?: string;
  location?: string;
  pickupStart?: string;
  pickupEnd?: string;
  itemCount?: number;
};

type DemoRole = "CUSTOMER" | "MERCHANT_ADMIN";

type Order = {
  id: string;
  status: string;
  paymentStatus?: string;
  amountCents: number;
  createdAt?: string;
  pickupStart?: string;
  pickupEnd?: string;
  pickupReference?: string;
  buyerName?: string;
  storeName?: string;
  items?: Array<{ name?: string; productName?: string; quantity: number }>;
};

type InventoryRow = {
  id: string;
  lotId?: string;
  name: string;
  quantityAvailable: number;
  priceCents: number;
  originalPriceCents: number;
  expiresAt?: string | null;
};

type MerchantPayload = {
  orders?: Order[];
  inventory?: InventoryRow[];
  analytics?: {
    unitsRescued?: number;
    revenueCents?: number;
    activeListings?: number;
  };
};

type ActiveCheckout = {
  bundle: PlannedBundle;
  reservationId: string | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const multipart = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!multipart && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const nestedError = payload.error;
    const nestedMessage = typeof nestedError === "object" && nestedError !== null && "message" in nestedError
      ? (nestedError as { message?: unknown }).message
      : undefined;
    const message = typeof nestedError === "string"
      ? nestedError
      : typeof nestedMessage === "string"
        ? nestedMessage
      : typeof payload.message === "string"
        ? payload.message
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

function unwrapList<T>(payload: T[] | { stores?: T[]; orders?: T[] }): T[] {
  if (Array.isArray(payload)) return payload;
  if ("stores" in payload && Array.isArray(payload.stores)) return payload.stores;
  if ("orders" in payload && Array.isArray(payload.orders)) return payload.orders;
  return [];
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function dateLabel(value?: string | null) {
  if (!value) return "Today";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function timeLabel(value?: string | null) {
  if (!value) return "Pickup window shown after planning";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

function Icon({ name, size = 20 }: { name: "leaf" | "arrow" | "bag" | "pin" | "clock" | "spark" | "chevron" | "check" | "grid" | "shop" | "close" | "plate"; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths: Record<string, ReactNode> = {
    leaf: <><path d="M20.8 3.2c-7.1 0-13.8 2-15.9 7.3-1.3 3.2.4 6.4 3.8 6.4 5.7 0 9.9-6.3 12.1-13.7Z" /><path d="M3.4 21c2.4-5.1 6-8.5 11.1-11.4" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    bag: <><path d="M5 8h14l1 12H4L5 8Z" /><path d="M9 9V6a3 3 0 0 1 6 0v3" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></>,
    chevron: <path d="m7 10 5 5 5-5" />,
    check: <path d="m5 12 4 4L19 6" />,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    shop: <><path d="M3 10h18l-1.2-6H4.2L3 10Z" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    plate: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="5.5" /><path d="M3 4v5M1.5 6h3M21 4v6" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function Brand() {
  return <a className="brand" href="#top" aria-label="Resqiva home"><span className="brand-mark"><Icon name="leaf" size={23} /></span><span>resqiva<span className="brand-period">.</span></span></a>;
}

function DemoBadge() {
  return <span className="demo-badge"><span className="demo-dot" /> Fictional demo inventory</span>;
}

function EmptyMealState({ onExample }: { onExample: () => void }) {
  return <div className="empty-state">
    <div className="empty-art" aria-hidden="true"><div className="empty-art-ring" /><div className="empty-art-bowl"><Icon name="plate" size={48} /></div><span className="art-leaf art-leaf-one" /><span className="art-leaf art-leaf-two" /><span className="art-dot" /></div>
    <div className="empty-copy"><span className="eyebrow">Your next meal starts here</span><h3>Build a meal from food that needs a home.</h3><p>Tell us your budget and preferences. Resqiva checks listed stock and pickup windows for your selected pickup day.</p><button className="text-button" type="button" onClick={onExample}>Try a sample request <Icon name="arrow" size={16} /></button></div>
  </div>;
}

function BundleCard({ bundle, busy, disabled, onReserve }: { bundle: PlannedBundle; busy: boolean; disabled: boolean; onReserve: (bundle: PlannedBundle) => void }) {
  return <article className="bundle-card">
    <div className="bundle-topline"><span className="bundle-kicker"><Icon name="spark" size={15} /> Meal set</span><span className="savings-pill">Save {money(bundle.savingsCents)}</span></div>
    <div className="bundle-heading"><div><h3>{bundle.meals[0]?.title ?? "A practical rescued-food meal"}</h3><p className="store-name"><Icon name="shop" size={15} /> {bundle.storeName}</p></div><div className="price-stack"><strong>{money(bundle.totalCents)}</strong><span>{money(bundle.originalTotalCents)} usual value</span></div></div>
    <div className="bundle-recipe"><span className="recipe-mark"><Icon name="plate" size={19} /></span><div><strong>{bundle.meals.length} meal{bundle.meals.length === 1 ? "" : "s"} · {bundle.meals[0]?.servings ?? ""} servings</strong><p>{bundle.meals[0]?.instructions?.[0] ?? bundle.explanation}</p></div></div>
    <div className="item-list" aria-label="Items in this meal set">{bundle.items.map((item) => <div className="bundle-item" key={item.inventoryId}><span className="item-bullet"><Icon name="check" size={13} /></span><span className="item-name">{item.productName}<small>{item.quantity} × {money(item.unitPriceCents)}</small></span><strong>{money(item.quantity * item.unitPriceCents)}</strong></div>)}</div>
    <div className="bundle-meta"><span><Icon name="bag" size={15} /> {bundle.verifiedSurplusUnits} listed surplus units</span><span><Icon name="clock" size={15} /> {dateLabel(bundle.pickupStart)} · {timeLabel(bundle.pickupStart)}–{timeLabel(bundle.pickupEnd)}</span></div>
    {bundle.explanation && <p className="bundle-explanation">{bundle.explanation}</p>}
    <button className="button button-primary bundle-action" disabled={busy || disabled} onClick={() => onReserve(bundle)} type="button">{busy ? <><span className="spinner" /> Reserving stock…</> : disabled ? <>Finish current checkout first</> : <>Reserve this meal set <Icon name="arrow" size={17} /></>}</button>
  </article>;
}

function CheckoutPanel({
  checkout,
  clientId,
  configLoading,
  configError,
  busy,
  uncertain,
  onCreateOrder,
  onApprove,
  onCancel,
  onError,
  onClose,
  onReserve,
}: {
  checkout: ActiveCheckout;
  clientId: string | null;
  configLoading: boolean;
  configError: string;
  busy: boolean;
  uncertain: boolean;
  onCreateOrder: () => Promise<string>;
  onApprove: (paypalOrderId: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onError: () => void;
  onClose: () => void;
  onReserve: (bundle: PlannedBundle) => void;
}) {
  return <section className="bundle-card checkout-panel" aria-labelledby="checkout-title" style={{ marginTop: 16, padding: 20, borderColor: "#d8e4d4" }}>
    <div className="bundle-topline"><span className="bundle-kicker"><Icon name="bag" size={15} /> PayPal Sandbox checkout</span>{!checkout.reservationId && <button type="button" className="quiet-button" onClick={onClose}>Close</button>}</div>
    <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 16, margin: "12px 0 14px" }}><div><h3 id="checkout-title" style={{ margin: 0, fontSize: 19 }}>Review, then approve securely.</h3><p style={{ margin: "6px 0 0", color: "#718075", fontSize: 11 }}>Resqiva creates the order from the saved reservation. The browser never sends a checkout amount.</p></div><div className="price-stack"><span style={{ textDecoration: "none" }}>Server-validated total</span><strong>{money(checkout.bundle.totalCents)}</strong></div></div>
    <div className="bundle-recipe" style={{ marginBottom: 14 }}><span className="recipe-mark"><Icon name="plate" size={19} /></span><div><strong>{checkout.bundle.meals[0]?.title ?? "Meal bundle"}</strong><p>{checkout.bundle.storeName} · {checkout.bundle.items.reduce((sum, item) => sum + item.quantity, 0)} inventory units · amount will be recomputed from the reservation</p></div></div>
    {configLoading ? <div className="status-notice status-info"><span className="spinner" /> Checking PayPal Sandbox configuration…</div>
      : configError ? <StatusNotice kind="error">{configError} No payment order was started. Configure the public PayPal Sandbox client ID, then retry.</StatusNotice>
        : !clientId ? <StatusNotice kind="error">PayPal Sandbox is not configured: the public client ID is missing. No reservation or payment order was created. Set <code>NEXT_PUBLIC_PAYPAL_CLIENT_ID</code> for the Sandbox app; the private client secret stays on the server.</StatusNotice>
          : !checkout.reservationId ? <StatusNotice kind="info">No stock has been reserved yet. Start a fresh reservation before continuing to PayPal. <button type="button" className="inline-link" onClick={() => onReserve(checkout.bundle)}>Reserve this meal set</button></StatusNotice>
            : uncertain ? <StatusNotice kind="error">PayPal reported an error and the payment state may be uncertain. Inventory remains reserved for reconciliation; no cancellation was sent. Do not start another checkout.</StatusNotice>
              : <div className="panel-card" style={{ padding: 14, maxWidth: 380, margin: "0 auto" }}><PayPalScriptProvider options={{ clientId, currency: "USD", intent: "capture" }}><PayPalButtons
                disabled={busy}
                style={{ layout: "vertical", shape: "rect", label: "paypal", color: "gold", height: 42 }}
                createOrder={onCreateOrder}
                onApprove={(data) => onApprove(data.orderID)}
                onCancel={() => { if (!uncertain) void onCancel(); }}
                onError={onError}
              /></PayPalScriptProvider></div>}
    <div className="bundle-meta" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 12 }}><span><Icon name="check" size={15} /> Paid status appears only after server-verified capture.</span>{checkout.reservationId && !uncertain && <button className="small-action" type="button" disabled={busy} onClick={() => void onCancel()}>Cancel unpaid reservation</button>}</div>
  </section>;
}

function StatusNotice({ kind, children, onDismiss }: { kind: "success" | "error" | "info"; children: ReactNode; onDismiss?: () => void }) {
  return <div className={`status-notice status-${kind}`} role={kind === "error" ? "alert" : "status"}><span className="notice-icon">{kind === "success" ? <Icon name="check" size={17} /> : kind === "error" ? <Icon name="close" size={17} /> : <Icon name="spark" size={17} />}</span><div>{children}</div>{onDismiss && <button className="notice-close" type="button" aria-label="Dismiss message" onClick={onDismiss}><Icon name="close" size={16} /></button>}</div>;
}

function InventoryEditor({ item, busy, onSave }: { item: InventoryRow; busy: boolean; onSave: (lotId: string, quantityAvailable: number, priceCents: number) => void }) {
  const [quantity, setQuantity] = useState(item.quantityAvailable);
  const [price, setPrice] = useState(item.priceCents / 100);
  const [validationError, setValidationError] = useState("");
  const lotId = item.lotId ?? item.id;

  function save() {
    if (!Number.isInteger(quantity) || quantity < 0) {
      setValidationError("Enter a whole quantity of zero or more.");
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      setValidationError("Enter a price greater than zero.");
      return;
    }
    setValidationError("");
    onSave(lotId, quantity, Math.round(price * 100));
  }

  return <tr key={`${lotId}-${item.quantityAvailable}-${item.priceCents}`}>
    <td><strong>{item.name}</strong><small>{item.expiresAt ? `Best before ${dateLabel(item.expiresAt)}` : "Date information not provided"}</small></td>
    <td><input aria-label={`Available quantity for ${item.name}`} className="merchant-edit-input quantity-edit" type="number" min="0" step="1" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} style={{ width: 58, padding: "5px 6px", border: "1px solid #d8dfd5", borderRadius: 4 }} /></td>
    <td><div className="merchant-price-input" style={{ display: "flex", alignItems: "center", border: "1px solid #d8dfd5", borderRadius: 4, paddingLeft: 6 }}><span>$</span><input aria-label={`Resqiva price in dollars for ${item.name}`} className="merchant-edit-input" type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(Number(event.target.value))} style={{ width: 68, padding: "5px 4px", border: 0, background: "transparent" }} /></div><small className="was-price">Was {money(item.originalPriceCents)}</small>{validationError && <small className="row-error" role="alert">{validationError}</small>}</td>
    <td><button className="small-action inventory-save" type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button></td>
  </tr>;
}

function MerchantPanel() {
  const [payload, setPayload] = useState<MerchantPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyOrder, setBusyOrder] = useState("");
  const [busyInventory, setBusyInventory] = useState("");
  const [importing, setImporting] = useState(false);
  const csvInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (initial = false) => {
    if (!initial) {
      setLoading(true);
      setError("");
    }
    try {
      setPayload(await api<MerchantPayload>("/api/merchant/orders"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merchant data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(true); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function confirmPickup(orderId: string) {
    setBusyOrder(orderId);
    setError("");
    try {
      await api(`/api/merchant/orders/${encodeURIComponent(orderId)}/pickup`, { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pickup confirmation failed.");
    } finally {
      setBusyOrder("");
    }
  }

  async function updateInventory(lotId: string, quantityAvailable: number, priceCents: number) {
    setBusyInventory(lotId);
    setError("");
    setNotice("");
    try {
      await api(`/api/merchant/inventory/${encodeURIComponent(lotId)}`, { method: "PATCH", body: JSON.stringify({ quantityOnHand: quantityAvailable, discountedPriceCents: priceCents }) });
      setNotice("Inventory changes were saved to the demo merchant account.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inventory changes could not be saved.");
    } finally {
      setBusyInventory("");
    }
  }

  async function importCsv(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
      setError("Choose a CSV file to import inventory.");
      if (csvInput.current) csvInput.current.value = "";
      return;
    }
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ imported?: number; message?: string }>("/api/merchant/inventory/import", { method: "POST", headers: { "Content-Type": "text/csv" }, body: file });
      setNotice(result.message ?? `${result.imported ?? "CSV"} inventory rows were imported into the demo merchant account.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV import failed. No inventory changes were confirmed.");
    } finally {
      setImporting(false);
      if (csvInput.current) csvInput.current.value = "";
    }
  }

  const orders = payload?.orders ?? [];
  const inventory = payload?.inventory ?? [];
  const analytics = payload?.analytics;
  return <section className="merchant-view" aria-labelledby="merchant-title">
    <div className="section-heading merchant-heading"><div><span className="eyebrow">Merchant workspace</span><h2 id="merchant-title">Your store snapshot</h2><p>Manage listed surplus and follow orders through pickup.</p></div><DemoBadge /></div>
    {error && <StatusNotice kind="error">{error}</StatusNotice>}
    {notice && <StatusNotice kind="success" onDismiss={() => setNotice("")}>{notice}</StatusNotice>}
    <div className="merchant-kpis">
      <div className="kpi-card"><span>Active listings</span><strong>{loading ? "—" : analytics?.activeListings ?? inventory.length}</strong><small>Items currently listed</small></div>
      <div className="kpi-card"><span>Orders to prepare</span><strong>{loading ? "—" : orders.filter((order) => ["PAID", "RESERVED", "PAYMENT_APPROVED"].includes(order.status)).length}</strong><small>Sandbox orders only</small></div>
      <div className="kpi-card"><span>Surplus units rescued</span><strong>{loading ? "—" : analytics?.unitsRescued ?? "—"}</strong><small>Recorded from completed orders</small></div>
      <div className="kpi-card"><span>Recovered revenue</span><strong>{loading ? "—" : analytics?.revenueCents == null ? "—" : money(analytics.revenueCents)}</strong><small>Calculated from paid orders</small></div>
    </div>
    <div className="merchant-columns">
      <section className="panel-card order-panel"><div className="panel-title"><div><span className="eyebrow">Order queue</span><h3>Pickups to prepare</h3></div><button type="button" className="quiet-button" onClick={() => void load()} disabled={loading}>Refresh</button></div>
        {loading ? <div className="loading-line"><span className="spinner" /> Loading order data…</div> : orders.length ? <div className="order-list">{orders.map((order) => <article className="order-row" key={order.id}><div className="order-row-main"><div className="order-ident"><strong>#{order.pickupReference ?? order.id.slice(0, 8)}</strong><span className={`order-status status-tag status-${order.status.toLowerCase()}`}>{order.status.replaceAll("_", " ")}</span></div><p>{order.items?.map((item) => `${item.quantity} × ${item.productName ?? item.name ?? "listed item"}`).join(" · ") || "Item details unavailable"}</p><small>{order.storeName ?? "Demo store"} · {dateLabel(order.pickupStart ?? order.createdAt)} · {timeLabel(order.pickupStart)}{order.pickupEnd ? `–${timeLabel(order.pickupEnd)}` : ""}</small></div><div className="order-row-end"><strong>{money(order.amountCents)}</strong>{order.status === "PAID" && <button className="small-action" onClick={() => void confirmPickup(order.id)} disabled={busyOrder === order.id} type="button">{busyOrder === order.id ? "Saving…" : "Confirm pickup"}</button>}</div></article>)}</div> : <div className="panel-empty"><span className="panel-empty-icon"><Icon name="bag" size={23} /></span><strong>No orders yet</strong><p>Paid Sandbox orders will appear here after server-side capture.</p></div>}
      </section>
      <section className="panel-card inventory-panel"><div className="panel-title"><div><span className="eyebrow">Surplus stock</span><h3>Inventory snapshot</h3></div><div className="inventory-actions" style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="readonly-tag">Demo merchant records</span><input ref={csvInput} type="file" accept=".csv,text/csv" aria-label="Choose inventory CSV file" style={{ display: "none" }} onChange={(event) => void importCsv(event.currentTarget.files?.[0])} /><button type="button" className="quiet-button" onClick={() => csvInput.current?.click()} disabled={importing || loading}>{importing ? "Importing…" : "Import CSV"}</button></div></div>
        {loading ? <div className="loading-line"><span className="spinner" /> Loading inventory…</div> : inventory.length ? <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>Product</th><th>Available</th><th>Resqiva price</th><th>Actions</th></tr></thead><tbody>{inventory.map((item) => <InventoryEditor key={`${item.lotId ?? item.id}-${item.quantityAvailable}-${item.priceCents}`} item={item} busy={busyInventory === (item.lotId ?? item.id)} onSave={updateInventory} />)}</tbody></table></div> : <div className="panel-empty compact"><strong>No inventory data returned</strong><p>Import a CSV or connect the demo merchant inventory source.</p></div>}
        <p className="panel-footnote">Stock and prices shown here come from server records. Unknown expiry or allergen data stays unknown.</p>
      </section>
    </div>
    <div className="merchant-note"><span><Icon name="shop" size={17} /></span><p><strong>Fictional merchant account only.</strong> The demo session grants a seeded merchant role for this browser demonstration. It does not represent production merchant authentication or account access.</p></div>
  </section>;
}

function CustomerOrderHistory({ enabled, refreshKey }: { enabled: boolean; refreshKey: number }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ orders?: Order[] }>("/api/orders");
      setOrders(result.orders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order history could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [enabled, load, refreshKey]);

  return <section id="customer-orders" className="panel-card order-panel" aria-labelledby="customer-orders-title" style={{ marginTop: 20 }}>
    <div className="panel-title"><div><span className="eyebrow">Shopper account</span><h3 id="customer-orders-title">My orders</h3></div><button className="quiet-button" type="button" disabled={!enabled || loading} onClick={() => void load()}>Refresh</button></div>
    {!enabled ? <div className="panel-empty"><p>Start a shopper demo session to view your order history.</p></div>
      : loading ? <div className="loading-line"><span className="spinner" /> Loading your orders…</div>
        : error ? <div className="panel-empty"><p role="alert">{error}</p><button className="small-action" type="button" onClick={() => void load()}>Try again</button></div>
          : orders.length ? <div className="order-list">{orders.map((order) => <article className="order-row" key={order.id}>
            <div className="order-row-main"><div className="order-ident"><strong>#{order.pickupReference ?? order.id.slice(-8).toUpperCase()}</strong><span className={`order-status status-tag status-${order.status.toLowerCase()}`}>{order.status.replaceAll("_", " ")}</span></div>
              <p>{order.items?.map((item) => `${item.quantity} × ${item.productName ?? item.name ?? "listed item"}`).join(" · ") || "Item details unavailable"}</p>
              <small>{order.storeName ?? "Demo store"} · {dateLabel(order.pickupStart ?? order.createdAt)} · {timeLabel(order.pickupStart)}{order.pickupEnd ? `–${timeLabel(order.pickupEnd)}` : ""}</small>
            </div><div className="order-row-end"><strong>{money(order.amountCents)}</strong><Link className="small-action" href={`/orders/${encodeURIComponent(order.id)}`}>View receipt</Link></div>
          </article>)}</div>
            : <div className="panel-empty"><span className="panel-empty-icon"><Icon name="bag" size={23} /></span><strong>No orders yet</strong><p>After a real Sandbox capture, your receipt and pickup reference will appear here.</p></div>}
  </section>;
}

export default function HomePage() {
  const router = useRouter();
  const [activeView, setActiveView] = useState<"shopper" | "merchant">("shopper");
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState("");
  const [storesLoading, setStoresLoading] = useState(true);
  const [storeError, setStoreError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState(25);
  const [servings, setServings] = useState(3);
  const [mealCount, setMealCount] = useState(2);
  const [bundles, setBundles] = useState<PlannedBundle[]>([]);
  const [preferences, setPreferences] = useState<PlannerPreferences | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState("");
  const [notice, setNotice] = useState<{ kind: "success" | "error" | "info"; message: string } | null>(null);
  const [busyBundle, setBusyBundle] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [checkoutReservation, setCheckoutReservation] = useState<ActiveCheckout | null>(null);
  const [paypalClientId, setPaypalClientId] = useState<string | null>(null);
  const [paypalConfigLoading, setPaypalConfigLoading] = useState(true);
  const [paypalConfigError, setPaypalConfigError] = useState("");
  const [paymentUncertain, setPaymentUncertain] = useState(false);
  const [customerSessionReady, setCustomerSessionReady] = useState(false);
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0);

  const selectedStore = useMemo(() => stores.find((store) => store.id === storeId), [stores, storeId]);

  const ensureDemoSession = useCallback(async (role: DemoRole) => {
    await api("/api/demo/session", { method: "POST", body: JSON.stringify({ role }) });
  }, []);

  const loadStores = useCallback(async (initial = false, sessionReady = false) => {
    if (!initial) {
      setStoresLoading(true);
      setStoreError("");
    }
    try {
      if (!sessionReady) await ensureDemoSession("CUSTOMER");
      setCustomerSessionReady(true);
      const data = await api<Store[] | { stores?: Store[] }>("/api/stores");
      const nextStores = unwrapList(data);
      setStores(nextStores);
      setStoreId((current) => current && nextStores.some((store) => store.id === current) ? current : nextStores[0]?.id ?? "");
    } catch (err) {
      setStoreError(err instanceof Error ? err.message : "Store listings could not be loaded.");
    } finally {
      setStoresLoading(false);
    }
  }, [ensureDemoSession]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadStores(true); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadStores]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api<{ paypalClientId?: string | null }>("/api/config")
        .then((config) => setPaypalClientId(config.paypalClientId || null))
        .catch((err: unknown) => setPaypalConfigError(err instanceof Error ? err.message : "PayPal Sandbox configuration could not be loaded."))
        .finally(() => setPaypalConfigLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function switchWorkspace(view: "shopper" | "merchant") {
    setSwitchingWorkspace(true);
    setNotice(null);
    try {
      await ensureDemoSession(view === "merchant" ? "MERCHANT_ADMIN" : "CUSTOMER");
      if (view === "shopper") setCustomerSessionReady(true);
      if (view === "shopper") await loadStores(false, true);
      setActiveView(view);
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "The demo workspace could not be changed." });
    } finally {
      setSwitchingWorkspace(false);
    }
  }

  async function goToPlanner() {
    try {
      await ensureDemoSession("CUSTOMER");
      setCustomerSessionReady(true);
      setActiveView("shopper");
      if (!stores.length) await loadStores(false, true);
      document.getElementById("planner")?.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "The customer demo session could not be started." });
    }
  }

  async function goToOrders() {
    try {
      await ensureDemoSession("CUSTOMER");
      setCustomerSessionReady(true);
      setActiveView("shopper");
      if (!stores.length) await loadStores(false, true);
      window.setTimeout(() => document.getElementById("customer-orders")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Your shopper order history could not be opened." });
      setActiveView("shopper");
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returnedReservation = params.get("reservationId");
    const cancelled = params.get("cancel") === "1" || params.get("paypal") === "cancel";
    if (!cancelled) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        setCaptureBusy(true);
        setNotice({ kind: "info", message: "Releasing the unpaid reservation…" });
        try {
          await ensureDemoSession("CUSTOMER");
          if (returnedReservation) {
            await api(`/api/reservations/${encodeURIComponent(returnedReservation)}/cancel`, { method: "POST", body: JSON.stringify({}) });
            setNotice({ kind: "info", message: "Checkout was cancelled. The unpaid reservation was released; no payment was recorded." });
          } else {
            setNotice({ kind: "info", message: "Checkout was cancelled. No payment was recorded; the return link did not include a reservation reference." });
          }
          setCheckoutReservation(null);
          setPaymentUncertain(false);
          window.history.replaceState({}, "", "/#planner");
        } catch (err) {
          setNotice({ kind: "error", message: err instanceof Error ? `Checkout is cancelled, but the server could not confirm reservation release: ${err.message}` : "Checkout is cancelled, but the server could not confirm reservation release." });
        } finally {
          setCaptureBusy(false);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ensureDemoSession]);

  async function findMeals(event?: FormEvent) {
    event?.preventDefault();
    if (!prompt.trim()) {
      setPlanError("Describe a meal request so the AI can parse your preferences.");
      return;
    }
    if (!storeId) {
      setPlanError("No store is available yet. Refresh the listings or try again after inventory loads.");
      return;
    }
    setLoadingPlan(true);
    setPlanError("");
    setNotice(null);
    setBundles([]);
    try {
      await ensureDemoSession("CUSTOMER");
      setCustomerSessionReady(true);
      setActiveView("shopper");
      const parsedResult = await api<{ preferences?: PlannerPreferences } | PlannerPreferences>("/api/preferences", { method: "POST", body: JSON.stringify({ prompt: prompt.trim() }) });
      const parsed = "preferences" in parsedResult && parsedResult.preferences ? parsedResult.preferences : parsedResult as PlannerPreferences;
      const resolved: PlannerPreferences = {
        ...parsed,
        budgetCents: Math.round(Number(budget) * 100),
        servings: Number(servings),
        mealCount: Number(mealCount),
        storeId,
        sourceText: prompt.trim(),
      };
      setPreferences(resolved);
      const planned = await api<{ bundles?: PlannedBundle[]; reason?: string; message?: string }>("/api/plan", { method: "POST", body: JSON.stringify({ preferences: resolved }) });
      setBundles(planned.bundles ?? []);
      if (!planned.bundles?.length) setPlanError(planned.reason ?? planned.message ?? "No bundle met every constraint. Try a higher budget, fewer meals, or a different pickup store.");
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Meal planning failed. Your preferences were not used to change inventory or payment data.");
    } finally {
      setLoadingPlan(false);
    }
  }

  function useExample() {
    setPrompt("Plan two vegetarian dinners for three people under $25, no peanuts, with pickup tomorrow.");
    setBudget(25);
    setServings(3);
    setMealCount(2);
    void goToPlanner();
  }

  async function reserveAndCheckout(bundle: PlannedBundle) {
    setCheckoutReservation(null);
    setPaymentUncertain(false);
    setBusyBundle(bundle.id);
    setPlanError("");
    setNotice(null);
    if (paypalConfigLoading) {
      setCheckoutReservation({ bundle, reservationId: null });
      setBusyBundle("");
      return;
    }
    if (paypalConfigError || !paypalClientId) {
      setCheckoutReservation({ bundle, reservationId: null });
      setNotice({ kind: "error", message: paypalConfigError || "PayPal Sandbox client ID is not configured. No reservation or payment order was created." });
      setBusyBundle("");
      return;
    }
    try {
      await ensureDemoSession("CUSTOMER");
      setCustomerSessionReady(true);
      setActiveView("shopper");
      const reservation = await api<{ reservationId?: string; id?: string; status?: string }>("/api/reservations", { method: "POST", body: JSON.stringify({ bundleId: bundle.id }) });
      const id = reservation.reservationId ?? reservation.id;
      if (!id) throw new Error("The server did not return a reservation reference. No payment was started.");
      setCheckoutReservation({ bundle, reservationId: id });
      setNotice({ kind: "info", message: "Stock is temporarily reserved. PayPal Sandbox approval has not started and the order is not paid." });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "A reservation could not be created. No payment was started." });
    } finally {
      setBusyBundle("");
    }
  }

  async function createPaypalOrder() {
    const reservationId = checkoutReservation?.reservationId;
    if (!reservationId) throw new Error("This checkout has no active reservation.");
    await ensureDemoSession("CUSTOMER");
    const order = await api<{ paypalOrderId?: string }>("/api/paypal/orders", {
      method: "POST",
      body: JSON.stringify({ reservationId }),
    });
    if (!order.paypalOrderId) throw new Error("The server did not return a PayPal order ID. The payment state may need reconciliation.");
    return order.paypalOrderId;
  }

  async function approvePaypalOrder(paypalOrderId: string) {
    if (!checkoutReservation?.reservationId) return;
    setCaptureBusy(true);
    setNotice({ kind: "info", message: "PayPal approved the order. Resqiva is asking its server to capture and verify payment." });
    try {
      await ensureDemoSession("CUSTOMER");
      const result = await api<{ status?: string; orderId?: string; pickupReference?: string; message?: string }>(`/api/paypal/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
        method: "POST",
        body: JSON.stringify({ reservationId: checkoutReservation.reservationId }),
      });
      if (result.status !== "PAID") {
        setPaymentUncertain(true);
        setNotice({ kind: "error", message: result.message ?? "The server did not confirm a paid order. Inventory remains reserved for reconciliation." });
        return;
      }
      setPaymentUncertain(false);
      setCheckoutReservation(null);
      setOrdersRefreshKey((current) => current + 1);
      if (result.orderId) {
        router.push(`/orders/${encodeURIComponent(result.orderId)}`);
      } else {
        setNotice({ kind: "success", message: `Sandbox payment was captured and verified by the server. Pickup reference ${result.pickupReference ?? "is available in merchant orders"}.` });
      }
    } catch (err) {
      setPaymentUncertain(true);
      setNotice({ kind: "error", message: `Capture could not be confirmed. Payment state may be uncertain and inventory remains reserved; do not retry or cancel until it is reconciled.${err instanceof Error ? ` ${err.message}` : ""}` });
    } finally {
      setCaptureBusy(false);
    }
  }

  async function cancelPaypalReservation() {
    const reservationId = checkoutReservation?.reservationId;
    if (!reservationId) {
      setCheckoutReservation(null);
      return;
    }
    if (paymentUncertain) {
      setNotice({ kind: "error", message: "Payment state may be uncertain. The reservation remains held and was not released." });
      return;
    }
    setCaptureBusy(true);
    setNotice({ kind: "info", message: "Cancelling the unpaid reservation…" });
    try {
      await ensureDemoSession("CUSTOMER");
      await api(`/api/reservations/${encodeURIComponent(reservationId)}/cancel`, { method: "POST", body: JSON.stringify({}) });
      setCheckoutReservation(null);
      setPaymentUncertain(false);
      setNotice({ kind: "info", message: "Reservation cancelled and stock released. No payment was recorded." });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? `The reservation could not be confirmed as cancelled: ${err.message}` : "The reservation could not be confirmed as cancelled." });
    } finally {
      setCaptureBusy(false);
    }
  }

  function handlePaypalError() {
    setPaymentUncertain(true);
    setNotice({ kind: "error", message: "PayPal reported an error. Payment or order state may be uncertain. Inventory remains reserved for reconciliation; no cancellation was sent." });
  }

  const dailyStoreCount = stores.length;

  return <main id="top">
    <header className="site-header"><div className="header-inner"><Brand /><nav className="main-nav" aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#planner">Meal planner</a><button type="button" onClick={() => void goToOrders()}>My orders</button><button type="button" onClick={() => { void switchWorkspace("merchant"); document.getElementById("workspace")?.scrollIntoView({ behavior: "smooth" }); }}>For merchants</button></nav><div className="header-actions"><span className="sandbox-indicator"><span /> Sandbox demo</span><button className="button button-dark header-cta" onClick={() => void goToPlanner()} type="button">Plan a meal <Icon name="arrow" size={16} /></button></div><button className="mobile-cta" type="button" aria-label="Go to meal planner" onClick={() => void goToPlanner()}><Icon name="bag" /></button></div></header>

    <section className="hero-section" aria-labelledby="hero-title"><div className="hero-orb hero-orb-one" /><div className="hero-orb hero-orb-two" /><div className="hero-inner"><div className="hero-copy"><div className="hero-label"><span className="label-line" /> Better meals. Less waste.</div><h1 id="hero-title">Good food deserves <em>a second plate.</em></h1><p>Turn nearby surplus groceries into complete meals that fit your budget, your table, and the selected pickup window.</p><div className="hero-actions"><button className="button button-lime" type="button" onClick={() => void goToPlanner()}>Build my meal plan <Icon name="arrow" size={17} /></button><button className="hero-link" type="button" onClick={() => document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })}>See how it works <Icon name="arrow" size={16} /></button></div><div className="hero-proof"><div className="proof-leaf"><Icon name="leaf" size={16} /></div><p><strong>{storesLoading ? "Loading" : dailyStoreCount} demo stores</strong><span>Fictional inventory · real constraints</span></p></div></div><div className="hero-visual" aria-label="Illustration of a rescued grocery basket"><div className="visual-backdrop" /><div className="visual-card visual-card-top"><span className="visual-card-icon"><Icon name="leaf" size={17} /></span><div><strong>Picked for your table</strong><small>Stock-checked and budget-aware</small></div><span className="visual-check"><Icon name="check" size={14} /></span></div><div className="produce-scene"><div className="scene-sun" /><div className="produce produce-tomato"><span /></div><div className="produce produce-pear"><span /></div><div className="produce produce-leaf"><span /><i /><b /></div><div className="produce produce-carrot"><span /></div><div className="basket"><div className="basket-top" /><div className="basket-body"><span /><span /><span /></div><div className="basket-handle" /></div><div className="scene-shadow" /></div><div className="visual-card visual-card-bottom"><span className="tiny-chart"><i /><i /><i /><i /><i /></span><span><strong>Price, explained</strong><small>Compared with listed original prices</small></span></div><span className="visual-caption">A better kind of grocery run</span></div></div><div className="hero-bottomline"><span>Rescue food</span><i /> <span>Build practical meals</span><i /> <span>Pay securely with PayPal Sandbox</span></div></section>

    <section id="how-it-works" className="how-section"><div className="section-heading"><div><span className="eyebrow">Simple by design</span><h2>From surplus shelf to <span>something delicious.</span></h2></div><p>AI understands what you want. A deterministic planner checks the real stock, prices, and pickup details.</p></div><div className="steps-grid"><article className="step-card"><span className="step-number">01</span><span className="step-icon step-icon-soft"><Icon name="spark" size={22} /></span><h3>Say what works</h3><p>Share a budget, servings, dietary needs, and when you can pick up.</p></article><article className="step-card"><span className="step-number">02</span><span className="step-icon step-icon-green"><Icon name="grid" size={22} /></span><h3>Get a grounded plan</h3><p>Every suggested item and price traces back to store inventory. Hard constraints come first.</p></article><article className="step-card"><span className="step-number">03</span><span className="step-icon step-icon-gold"><Icon name="bag" size={22} /></span><h3>Reserve, approve, collect</h3><p>Your server reserves stock and creates a PayPal Sandbox order. Capture is verified before inventory is committed.</p></article></div></section>

    <section id="planner" className="planner-section"><div className="planner-heading"><div><span className="eyebrow">Resqiva meal studio</span><h2>Make a plan that <span>makes sense.</span></h2><p>Tell us what you need. We’ll match it to available surplus, not imagined ingredients.</p></div><DemoBadge /></div>
      {notice && <StatusNotice kind={notice.kind} onDismiss={() => setNotice(null)}>{notice.message}</StatusNotice>}
      {captureBusy && <StatusNotice kind="info">Resqiva is updating checkout status. The order appears as paid only after server-verified capture.</StatusNotice>}
      <div className="planner-layout"><form className="planner-form" onSubmit={findMeals}><div className="form-top"><div><span className="form-step">YOUR REQUEST <span>· STEP 1 OF 2</span></span><h3>What sounds good?</h3></div><span className="lock-note"><span className="lock-dot" /> AI suggests. Server verifies.</span></div>
        <label className="field-label" htmlFor="request">Describe your meals and preferences</label><textarea id="request" className="request-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="For example: two vegetarian dinners for three people, under $25, no peanuts, ready to pick up today." rows={4} required /><div className="prompt-help"><span><Icon name="spark" size={15} /> Natural language, your way</span><button type="button" className="text-button compact-link" onClick={useExample}>Use sample request</button></div>
        <div className="form-divider" /><div className="field-row"><div className="field-group"><label className="field-label" htmlFor="budget">Budget</label><div className="input-with-prefix"><span>$</span><input id="budget" type="number" min="1" max="300" step="0.50" value={budget} onChange={(event) => setBudget(Number(event.target.value))} /></div></div><div className="field-group"><label className="field-label" htmlFor="servings">Servings</label><div className="input-with-suffix"><input id="servings" type="number" min="1" max="12" value={servings} onChange={(event) => setServings(Number(event.target.value))} /><span>people</span></div></div><div className="field-group"><label className="field-label" htmlFor="meals">Meals</label><div className="input-with-suffix"><input id="meals" type="number" min="1" max="7" value={mealCount} onChange={(event) => setMealCount(Number(event.target.value))} /><span>meals</span></div></div></div>
        <div className="field-group store-field"><label className="field-label" htmlFor="store">Pickup store</label><div className="select-shell"><Icon name="pin" size={17} /><select id="store" value={storeId} onChange={(event) => setStoreId(event.target.value)} disabled={storesLoading || !stores.length}><option value="">{storesLoading ? "Loading demo stores…" : stores.length ? "Choose a store" : "No stores available"}</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}{store.neighborhood ? ` · ${store.neighborhood}` : store.location ? ` · ${store.location}` : ""}</option>)}</select><Icon name="chevron" size={16} /></div>{selectedStore && <small className="store-helper">{selectedStore.merchantName ?? "Fictional demo merchant"}{selectedStore.pickupStart && selectedStore.pickupEnd ? ` · pickup ${timeLabel(selectedStore.pickupStart)}–${timeLabel(selectedStore.pickupEnd)}` : " · pickup details checked with the plan"}</small>}</div>
        {storeError && <StatusNotice kind="error">{storeError} <button className="inline-link" type="button" onClick={() => void loadStores()}>Try again</button></StatusNotice>}
        {planError && <StatusNotice kind="error">{planError}</StatusNotice>}
        <div className="form-footer"><span className="private-note"><span className="lock-icon">⌑</span> Your request only guides planning. It can’t change stock or authorize payment.</span><button className="button button-primary plan-button" type="submit" disabled={loadingPlan || storesLoading || !stores.length}>{loadingPlan ? <><span className="spinner" /> Checking stock…</> : <>Find my meal plan <Icon name="arrow" size={17} /></>}</button></div>
      </form>
      <div className="results-panel"><div className="results-top"><div><span className="form-step">YOUR OPTIONS <span>· STEP 2 OF 2</span></span><h3>{bundles.length ? `${bundles.length} plan${bundles.length === 1 ? "" : "s"} to compare` : loadingPlan ? "Checking what’s available" : "Your meal plans will appear here"}</h3></div><span className="results-count"><Icon name="check" size={14} /> Verified against stock</span></div>
        {loadingPlan ? <div className="result-loading"><div className="loader-mark"><span /><span /><span /></div><strong>Finding a plan that fits</strong><p>Parsing preferences, checking listed inventory, and validating the hard constraints.</p><div className="skeleton-card"><i /><i /><i /></div></div> : bundles.length ? <div className="bundle-list">{bundles.map((bundle) => <BundleCard key={bundle.id} bundle={bundle} busy={busyBundle === bundle.id} disabled={Boolean(checkoutReservation)} onReserve={reserveAndCheckout} />)}</div> : <EmptyMealState onExample={useExample} />}
        {preferences && !loadingPlan && bundles.length > 0 && <div className="parsed-preferences"><span className="parsed-icon"><Icon name="check" size={15} /></span><span><strong>Request understood</strong><small>{preferences.mealCount} meals · {preferences.servings} servings · up to {money(preferences.budgetCents)}{preferences.exclusions.length ? ` · ${preferences.exclusions.join(", ")}` : ""}{preferences.allergies.length ? ` · allergy metadata checked for ${preferences.allergies.join(", ")}` : ""}</small></span></div>}
      </div></div>
      {checkoutReservation && <CheckoutPanel checkout={checkoutReservation} clientId={paypalClientId} configLoading={paypalConfigLoading} configError={paypalConfigError} busy={captureBusy} uncertain={paymentUncertain} onCreateOrder={createPaypalOrder} onApprove={approvePaypalOrder} onCancel={cancelPaypalReservation} onError={handlePaypalError} onClose={() => setCheckoutReservation(null)} onReserve={reserveAndCheckout} />}
      <div className="safety-strip"><div className="safety-icon"><Icon name="check" size={17} /></div><p><strong>Good food, honest information.</strong> Allergy data is only as complete as the merchant records. Unknown means unknown—Resqiva does not certify food as allergy-safe.</p><a href="#limits">Safety & limits <Icon name="arrow" size={14} /></a></div>
    </section>

    <section id="workspace" className="workspace-section"><div className="workspace-shell"><div className="workspace-top"><div><span className="eyebrow">One marketplace, two sides</span><h2>Good surplus works <span>for everyone.</span></h2><p>Customers find a meal. Merchants recover value and see what happens after checkout.</p></div><div className="view-switch" role="tablist" aria-label="Choose a workspace"><button className={activeView === "shopper" ? "active" : ""} role="tab" aria-selected={activeView === "shopper"} type="button" disabled={switchingWorkspace} onClick={() => void switchWorkspace("shopper")}><Icon name="bag" size={17} /> Shopper</button><button className={activeView === "merchant" ? "active" : ""} role="tab" aria-selected={activeView === "merchant"} type="button" disabled={switchingWorkspace} onClick={() => void switchWorkspace("merchant")}><Icon name="shop" size={17} /> Merchant</button></div></div>
        {activeView === "shopper" ? <div className="shopper-workspace"><div className="workspace-feature"><div className="feature-orbit" /><span className="feature-icon"><Icon name="leaf" size={23} /></span><div><strong>Shopper view</strong><p>Browse a fictional neighborhood market, build a practical bundle, and review every price before you reserve.</p><button className="text-button" type="button" onClick={() => document.getElementById("planner")?.scrollIntoView({ behavior: "smooth" })}>Start with the meal planner <Icon name="arrow" size={15} /></button></div></div><div className="workspace-steps"><div><span>01</span><p><strong>Set your limits</strong><small>Budget, servings, dietary needs</small></p></div><div><span>02</span><p><strong>Review the real list</strong><small>Every item maps to a store record</small></p></div><div><span>03</span><p><strong>Approve on PayPal</strong><small>Sandbox checkout, server verified</small></p></div></div><CustomerOrderHistory enabled={customerSessionReady} refreshKey={ordersRefreshKey} /></div> : <MerchantPanel />}
      </div></section>

    <section className="impact-section"><div className="impact-copy"><span className="eyebrow">Measured, never made up</span><h2>Better outcomes should be <em>counted honestly.</em></h2><p>We report only what the transaction and inventory records support: listed units purchased, recovered revenue, and the prices on file.</p><a href="#limits" className="text-button">How we measure impact <Icon name="arrow" size={15} /></a></div><div className="impact-card"><div className="impact-card-top"><span className="impact-symbol"><Icon name="grid" size={20} /></span><span className="live-tag"><span /> From records</span></div><div className="impact-bars" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="impact-card-bottom"><div><small>VERIFIED SIGNAL</small><strong>Paid order + stock change</strong></div><Icon name="arrow" size={17} /></div></div></section>

    <section id="limits" className="limits-section"><div className="limits-header"><span className="eyebrow">Clear limits</span><h2>Trust begins with <span>what we don’t assume.</span></h2></div><div className="limits-grid"><article><span className="limit-number">01</span><h3>Unknown stays unknown</h3><p>Allergen information is not complete for every product. Resqiva won’t promise allergy safety from missing data.</p></article><article><span className="limit-number">02</span><h3>AI does not touch checkout</h3><p>The model can parse preferences. Server rules validate stock and totals; PayPal confirmation is required before a paid state.</p></article><article><span className="limit-number">03</span><h3>Demo means fictional</h3><p>Sample merchants and inventory are fictional. Environmental impact is measured from recorded transactions, not estimated from sales.</p></article></div></section>

    <footer className="site-footer"><div className="footer-main"><div className="footer-brand"><Brand /><p>Rescue food. Build meals. Pay intelligently.</p><DemoBadge /></div><div className="footer-links"><div><strong>Explore</strong><button type="button" onClick={() => void goToPlanner()}>Meal planner</button><a href="#how-it-works">How it works</a><button type="button" onClick={() => { void switchWorkspace("merchant"); document.getElementById("workspace")?.scrollIntoView({ behavior: "smooth" }); }}>Merchant workspace</button></div><div><strong>Transparency</strong><a href="#limits">Safety & limits</a><span>Sandbox checkout</span><span>Fictional demonstration data</span></div></div></div><div className="footer-bottom"><span>© 2026 Resqiva · Hackathon demonstration</span><span>Real inventory rules. Clear payment status. No simulated success.</span></div></footer>
  </main>;
}
