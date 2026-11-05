"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import type { PlannedBundle, PlannerPreferences } from "@/lib/contracts";
import { quantityOnHandFromAvailable } from "@/lib/quantity-on-hand";

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
  quantityReserved?: number;
  quantitySold?: number;
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

type PickupWindow = {
  id: string;
  storeId: string;
  storeName?: string;
  timezone?: string;
  startsAt: string;
  endsAt: string;
  lastReservationAt: string;
  capacityUnits: number;
  reservedUnits: number;
  active: boolean;
};

type PickupWindowDraft = Pick<PickupWindow, "startsAt" | "endsAt" | "lastReservationAt" | "capacityUnits">;

type MerchantStore = {
  id: string;
  name: string;
  city: string;
  timezone: string;
  pickupAddress: string;
  isDemo?: boolean;
  inventoryListings?: number;
  pickupWindowCount?: number;
  orderCount?: number;
  updatedAt?: string;
};

type MerchantStoreDraft = Pick<MerchantStore, "name" | "city" | "timezone" | "pickupAddress">;

type ActiveCheckout = {
  bundle: PlannedBundle;
  reservationId: string | null;
};

type ReservationReconcileResult = {
  status: string;
  paymentStatus?: string;
  held?: boolean;
  released?: boolean;
  orderId?: string;
  pickupReference?: string;
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

function formatAtTimeZone(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function toDateTimeInput(value: string, timeZone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (timeZone) {
    try {
      return formatAtTimeZone(date, timeZone);
    } catch {
      // Fall through to the browser timezone if a store timezone is unavailable.
    }
  }
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function fromDateTimeInput(value: string, timeZone?: string) {
  if (timeZone) {
    const [datePart, timePart] = value.split("T");
    const [year, month, day] = (datePart ?? "").split("-").map(Number);
    const [hour, minute] = (timePart ?? "").split(":").map(Number);
    if (![year, month, day, hour, minute].every(Number.isFinite)) throw new Error("Enter a valid pickup date and time.");
    const wallClock = Date.UTC(year, month - 1, day, hour, minute);
    let candidate = wallClock;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const formatted = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(candidate));
      const part = (name: string) => Number(formatted.find((item) => item.type === name)?.value);
      const representedWallClock = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
      const next = wallClock - (representedWallClock - candidate);
      if (next === candidate) break;
      candidate = next;
    }
    if (formatAtTimeZone(new Date(candidate), timeZone) !== value) {
      throw new Error(`That local time does not exist in ${timeZone} because of a clock change.`);
    }
    return new Date(candidate).toISOString();
  }
  return new Date(value).toISOString();
}

function dateLabelInTimeZone(value: string, timeZone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
  } catch {
    return dateLabel(value);
  }
}

function timeLabelInTimeZone(value: string, timeZone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return timeLabel(value);
  }
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
    <div className="bundle-heading"><div><h3>{bundle.meals.length > 1 ? `${bundle.meals.length} meal plan` : bundle.meals[0]?.title ?? "A practical rescued-food meal"}</h3><p className="store-name"><Icon name="shop" size={15} /> {bundle.storeName}</p></div><div className="price-stack"><strong>{money(bundle.totalCents)}</strong><span>{money(bundle.originalTotalCents)} usual value</span></div></div>
    <div className="bundle-recipe"><span className="recipe-mark"><Icon name="plate" size={19} /></span><div><strong>{bundle.meals.length} meal{bundle.meals.length === 1 ? "" : "s"} · {bundle.meals[0]?.servings ?? ""} servings</strong><p>{bundle.meals.length > 1 ? bundle.meals.map((meal, index) => `${index + 1}. ${meal.title}`).join(" · ") : bundle.meals[0]?.instructions?.[0] ?? bundle.explanation}</p></div></div>
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
  reconcileBusy,
  reconcileError,
  reconcileResult,
  onCreateOrder,
  onApprove,
  onCancel,
  onReconcile,
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
  reconcileBusy: boolean;
  reconcileError: string;
  reconcileResult: ReservationReconcileResult | null;
  onCreateOrder: () => Promise<string>;
  onApprove: (paypalOrderId: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onReconcile: () => Promise<void>;
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
            : uncertain ? <div>
              <StatusNotice kind="error">PayPal reported an error and the payment state may be uncertain. Inventory remains reserved; no cancellation was sent. Do not start another checkout.</StatusNotice>
              {reconcileError && <div style={{ marginTop: 9 }}><StatusNotice kind="error">{reconcileError}</StatusNotice></div>}
              {reconcileResult && <div style={{ marginTop: 9 }}>
                {reconcileResult.status === "PAID" && <StatusNotice kind="success">Payment was confirmed and finalized. Opening your receipt{reconcileResult.pickupReference ? ` · pickup reference ${reconcileResult.pickupReference}` : ""}.</StatusNotice>}
                {(reconcileResult.status === "CANCELLED" || reconcileResult.status === "EXPIRED") && reconcileResult.released === true && <StatusNotice kind="info">Reservation status {reconcileResult.status}; release confirmed. No payment was recorded.</StatusNotice>}
                {!(reconcileResult.status === "PAID" || ((reconcileResult.status === "CANCELLED" || reconcileResult.status === "EXPIRED") && reconcileResult.released === true)) && <StatusNotice kind="info">PayPal status: {reconcileResult.status}{reconcileResult.paymentStatus ? ` · payment ${reconcileResult.paymentStatus}` : ""}. Inventory {reconcileResult.held === true ? "remains held" : "release has not been confirmed"}. Check again later; this checkout remains open.</StatusNotice>}
              </div>}
              <button className="small-action" type="button" disabled={busy || reconcileBusy || !checkout.reservationId} onClick={() => void onReconcile()} style={{ marginTop: 10 }}>{reconcileBusy ? "Checking payment status…" : "Check payment status"}</button>
              {reconcileBusy && <p role="status" aria-live="polite" style={{ margin: "7px 0 0", color: "#617d4f", fontSize: 10 }}>Checking the saved reservation with PayPal Sandbox. Inventory stays held during the check.</p>}
            </div>
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

function InventoryEditor({ item, busy, onSave }: { item: InventoryRow; busy: boolean; onSave: (lotId: string, quantityAvailable: number, priceCents: number, quantityReserved: number, quantitySold: number) => void }) {
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
    onSave(lotId, quantity, Math.round(price * 100), item.quantityReserved ?? 0, item.quantitySold ?? 0);
  }

  return <tr key={`${lotId}-${item.quantityAvailable}-${item.priceCents}`}>
    <td><strong>{item.name}</strong><small>{item.expiresAt ? `Best before ${dateLabel(item.expiresAt)}` : "Date information not provided"}</small></td>
    <td><input aria-label={`Available quantity for ${item.name}`} className="merchant-edit-input quantity-edit" type="number" min="0" step="1" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} style={{ width: 58, padding: "5px 6px", border: "1px solid #d8dfd5", borderRadius: 4 }} /></td>
    <td><div className="merchant-price-input" style={{ display: "flex", alignItems: "center", border: "1px solid #d8dfd5", borderRadius: 4, paddingLeft: 6 }}><span>$</span><input aria-label={`Resqiva price in dollars for ${item.name}`} className="merchant-edit-input" type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(Number(event.target.value))} style={{ width: 68, padding: "5px 4px", border: 0, background: "transparent" }} /></div><small className="was-price">Was {money(item.originalPriceCents)}</small>{validationError && <small className="row-error" role="alert">{validationError}</small>}</td>
    <td><button className="small-action inventory-save" type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button></td>
  </tr>;
}

function PickupWindowEditor({ window, saving, disabled, onSave }: { window: PickupWindow; saving: boolean; disabled: boolean; onSave: (id: string, values: Omit<PickupWindow, "id" | "storeId" | "storeName" | "reservedUnits">) => Promise<void> }) {
  const [startsAt, setStartsAt] = useState(() => toDateTimeInput(window.startsAt, window.timezone));
  const [endsAt, setEndsAt] = useState(() => toDateTimeInput(window.endsAt, window.timezone));
  const [lastReservationAt, setLastReservationAt] = useState(() => toDateTimeInput(window.lastReservationAt, window.timezone));
  const [capacityUnits, setCapacityUnits] = useState(window.capacityUnits);
  const [active, setActive] = useState(window.active);
  const [validationError, setValidationError] = useState("");
  const remainingUnits = Math.max(0, window.capacityUnits - window.reservedUnits);
  const inputStyle = { width: "100%", minHeight: 38, padding: "8px 9px", color: "#33483a", background: "#fff", border: "1px solid #d8dfd5", borderRadius: 5, fontSize: 11 };

  async function submit(event: FormEvent) {
    event.preventDefault();
    let startsAtIso: string;
    let endsAtIso: string;
    let lastReservationAtIso: string;
    try {
      startsAtIso = fromDateTimeInput(startsAt, window.timezone);
      endsAtIso = fromDateTimeInput(endsAt, window.timezone);
      lastReservationAtIso = fromDateTimeInput(lastReservationAt, window.timezone);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : "Enter valid pickup times.");
      return;
    }
    const startMs = new Date(startsAtIso).getTime();
    const endMs = new Date(endsAtIso).getTime();
    const lastMs = new Date(lastReservationAtIso).getTime();
    if (startMs >= endMs) {
      setValidationError("Pickup must end after it starts.");
      return;
    }
    if (lastMs > startMs) {
      setValidationError("The last reservation time must be at or before pickup starts.");
      return;
    }
    if (!Number.isInteger(capacityUnits) || capacityUnits < 1) {
      setValidationError("Capacity must be a whole number greater than zero.");
      return;
    }
    if (capacityUnits < window.reservedUnits) {
      setValidationError(`Capacity cannot be lower than the ${window.reservedUnits} units already reserved.`);
      return;
    }
    setValidationError("");
    await onSave(window.id, {
      startsAt: startsAtIso,
      endsAt: endsAtIso,
      lastReservationAt: lastReservationAtIso,
      capacityUnits,
      active,
    });
  }

  return <article className="panel-card" aria-busy={saving} style={{ padding: 16, marginBottom: 10, borderColor: window.active ? "#dce8d8" : "#e5e7e2" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, marginBottom: 13 }}>
      <div><strong style={{ display: "block", color: "#344a3b", fontSize: 12 }}>{window.storeName ?? "Demo store"} pickup</strong><span style={{ display: "block", marginTop: 3, color: "#7a887d", fontSize: 9 }}>{dateLabelInTimeZone(window.startsAt, window.timezone)} · {timeLabelInTimeZone(window.startsAt, window.timezone)}–{timeLabelInTimeZone(window.endsAt, window.timezone)}{window.timezone ? ` · ${window.timezone}` : ""}</span></div>
      <span className={`status-tag ${window.active ? "status-paid" : "status-expired"}`}>{window.active ? "Active" : "Inactive"}</span>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", marginBottom: 14, color: "#657468", fontSize: 9 }}><span><strong>Capacity:</strong> {window.capacityUnits} units</span><span><strong>Reserved:</strong> {window.reservedUnits} units</span><span><strong>Available:</strong> {remainingUnits} units</span></div>
    <form onSubmit={submit}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 10 }}>
        <label className="field-label">Pickup starts<input aria-label={`Pickup start for ${window.storeName ?? "demo store"}`} type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} style={inputStyle} required /></label>
        <label className="field-label">Pickup ends<input aria-label={`Pickup end for ${window.storeName ?? "demo store"}`} type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} style={inputStyle} required /></label>
        <label className="field-label">Last reservation time<input aria-label={`Last reservation time for ${window.storeName ?? "demo store"}`} type="datetime-local" value={lastReservationAt} onChange={(event) => setLastReservationAt(event.target.value)} style={inputStyle} required /></label>
        <label className="field-label">Capacity (inventory units)<input aria-label={`Capacity in inventory units for ${window.storeName ?? "demo store"}`} type="number" min={Math.max(1, window.reservedUnits)} step="1" value={capacityUnits} onChange={(event) => setCapacityUnits(Number(event.target.value))} style={inputStyle} required /></label>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "#536458", fontSize: 10, fontWeight: 650 }}><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} aria-label={`Pickup window active for ${window.storeName ?? "demo store"}`} /> Accept reservations for this window</label>
        <button className="small-action" type="submit" disabled={disabled || saving}>{saving ? "Saving window…" : "Save pickup window"}</button>
      </div>
      {validationError && <p role="alert" style={{ color: "#a34c3e", margin: "8px 0 0", fontSize: 9 }}>{validationError}</p>}
      {saving && <p role="status" aria-live="polite" style={{ color: "#617d4f", margin: "8px 0 0", fontSize: 9 }}>Saving pickup window to the server…</p>}
    </form>
  </article>;
}

function CreatePickupWindowForm({ store, existingWindows, saving, disabled, onCreate, onCancel }: { store: MerchantStore; existingWindows: PickupWindow[]; saving: boolean; disabled: boolean; onCreate: (storeId: string, values: PickupWindowDraft) => Promise<void>; onCancel: () => void }) {
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [lastReservationAt, setLastReservationAt] = useState("");
  const [capacityUnits, setCapacityUnits] = useState(1);
  const [validationError, setValidationError] = useState("");
  const inputStyle = { width: "100%", minHeight: 38, padding: "8px 9px", color: "#33483a", background: "#fff", border: "1px solid #d8dfd5", borderRadius: 5, fontSize: 11 };

  async function submit(event: FormEvent) {
    event.preventDefault();
    let startsAtIso: string;
    let endsAtIso: string;
    let lastReservationAtIso: string;
    try {
      startsAtIso = fromDateTimeInput(startsAt, store.timezone);
      endsAtIso = fromDateTimeInput(endsAt, store.timezone);
      lastReservationAtIso = fromDateTimeInput(lastReservationAt, store.timezone);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : "Enter valid pickup times in the store timezone.");
      return;
    }
    const startMs = Date.parse(startsAtIso);
    const endMs = Date.parse(endsAtIso);
    const cutoffMs = Date.parse(lastReservationAtIso);
    const now = Date.now();
    if (startMs <= now) return setValidationError("Pickup must start in the future.");
    if (endMs <= startMs) return setValidationError("Pickup must end after it starts.");
    if (cutoffMs <= now) return setValidationError("The reservation cutoff must be in the future.");
    if (cutoffMs > startMs) return setValidationError("The reservation cutoff cannot be later than pickup start.");
    if (!Number.isInteger(capacityUnits) || capacityUnits < 1 || capacityUnits > 10_000) return setValidationError("Capacity must be a whole number from 1 to 10,000.");
    const overlaps = existingWindows.some((window) => window.storeId === store.id && window.active
      && startMs < Date.parse(window.endsAt) && endMs > Date.parse(window.startsAt));
    if (overlaps) return setValidationError("This time overlaps another active pickup window at this store.");
    setValidationError("");
    await onCreate(store.id, { startsAt: startsAtIso, endsAt: endsAtIso, lastReservationAt: lastReservationAtIso, capacityUnits });
  }

  return <form onSubmit={(event) => void submit(event)} aria-busy={saving} style={{ padding: 13, background: "#fbfcf8", border: "1px solid #e2e9df", borderRadius: 7, marginTop: 10 }}>
    <fieldset disabled={disabled || saving} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="eyebrow" style={{ marginBottom: 5 }}>New pickup window · {store.name}</legend>
      <p style={{ margin: "0 0 10px", color: "#728076", fontSize: 9 }}>Times use {store.timezone}. Resqiva converts them to explicit-offset ISO timestamps for the server.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 9 }}>
        <label className="field-label">Pickup starts<input aria-label={`New pickup start for ${store.name}`} type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} style={inputStyle} required /></label>
        <label className="field-label">Pickup ends<input aria-label={`New pickup end for ${store.name}`} type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} style={inputStyle} required /></label>
        <label className="field-label">Last reservation time<input aria-label={`New reservation cutoff for ${store.name}`} type="datetime-local" value={lastReservationAt} onChange={(event) => setLastReservationAt(event.target.value)} style={inputStyle} required /></label>
        <label className="field-label">Capacity (inventory units)<input aria-label={`New pickup capacity for ${store.name}`} type="number" min="1" max="10000" step="1" value={capacityUnits} onChange={(event) => setCapacityUnits(Number(event.target.value))} style={inputStyle} required /></label>
      </div>
      {validationError && <p role="alert" style={{ color: "#a34c3e", margin: "8px 0 0", fontSize: 9 }}>{validationError}</p>}
      {saving && <p role="status" aria-live="polite" style={{ color: "#617d4f", margin: "8px 0 0", fontSize: 9 }}>Creating pickup window on the server…</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
        <button className="quiet-button" type="button" onClick={onCancel}>Cancel</button>
        <button className="small-action" type="submit" disabled={disabled || saving}>{saving ? "Creating window…" : "Create pickup window"}</button>
      </div>
    </fieldset>
  </form>;
}

function MerchantStoreForm({ store, saving, disabled, onSave, onCancel }: { store?: MerchantStore; saving: boolean; disabled: boolean; onSave: (values: MerchantStoreDraft) => Promise<void>; onCancel?: () => void }) {
  const [name, setName] = useState(store?.name ?? "");
  const [city, setCity] = useState(store?.city ?? "");
  const [timezone, setTimezone] = useState(store?.timezone ?? "");
  const [pickupAddress, setPickupAddress] = useState(store?.pickupAddress ?? "");
  const [validationError, setValidationError] = useState("");
  const inputStyle = { width: "100%", minHeight: 40, padding: "8px 10px", color: "#33483a", background: "#fff", border: "1px solid #d8dfd5", borderRadius: 5, fontSize: 12 };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const draft = { name: name.trim(), city: city.trim(), timezone: timezone.trim(), pickupAddress: pickupAddress.trim() };
    if (draft.name.length < 2 || draft.name.length > 80) return setValidationError("Store name must be between 2 and 80 characters.");
    if (draft.city.length < 2 || draft.city.length > 80) return setValidationError("City must be between 2 and 80 characters.");
    if (draft.pickupAddress.length < 5 || draft.pickupAddress.length > 240) return setValidationError("Pickup address must be between 5 and 240 characters.");
    if (!draft.timezone || draft.timezone.length > 80) return setValidationError("Enter a valid IANA timezone, such as Asia/Riyadh.");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: draft.timezone });
    } catch {
      return setValidationError("Enter a valid IANA timezone, such as Asia/Riyadh.");
    }
    setValidationError("");
    await onSave(draft);
  }

  return <form onSubmit={(event) => void submit(event)} aria-busy={saving} style={{ padding: 15, background: "#fbfcf8", border: "1px solid #e2e9df", borderRadius: 7, marginTop: 10 }}>
    <fieldset disabled={disabled || saving} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="eyebrow" style={{ marginBottom: 11 }}>{store ? `Edit ${store.name}` : "New demo store details"}</legend>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 11 }}>
        <label className="field-label">Store name<input autoComplete="organization" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} style={inputStyle} required /></label>
        <label className="field-label">City<input autoComplete="address-level2" maxLength={80} value={city} onChange={(event) => setCity(event.target.value)} style={inputStyle} required /></label>
        <label className="field-label">Timezone<input autoComplete="off" placeholder="Asia/Riyadh" maxLength={80} value={timezone} onChange={(event) => setTimezone(event.target.value)} style={inputStyle} required aria-describedby="merchant-store-timezone-help" /><small id="merchant-store-timezone-help" style={{ display: "block", marginTop: 4, fontSize: 9, color: "#728076" }}>Use an IANA timezone name.</small></label>
        <label className="field-label">Pickup address<input autoComplete="street-address" maxLength={240} value={pickupAddress} onChange={(event) => setPickupAddress(event.target.value)} style={inputStyle} required /></label>
      </div>
      {validationError && <p role="alert" style={{ color: "#a34c3e", margin: "9px 0 0", fontSize: 10 }}>{validationError}</p>}
      {saving && <p role="status" aria-live="polite" style={{ color: "#617d4f", margin: "9px 0 0", fontSize: 10 }}>Waiting for the server to confirm this store change…</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
        {onCancel && <button className="quiet-button" type="button" onClick={onCancel}>Cancel</button>}
        <button className="small-action" type="submit" disabled={disabled || saving}>{saving ? "Saving store…" : store ? "Save store details" : "Create demo store"}</button>
      </div>
    </fieldset>
  </form>;
}

function MerchantPanel() {
  const [payload, setPayload] = useState<MerchantPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyOrder, setBusyOrder] = useState("");
  const [busyInventory, setBusyInventory] = useState("");
  const [importing, setImporting] = useState(false);
  const [pickupWindows, setPickupWindows] = useState<PickupWindow[]>([]);
  const [pickupWindowsLoading, setPickupWindowsLoading] = useState(true);
  const [pickupWindowError, setPickupWindowError] = useState("");
  const [pickupWindowNotice, setPickupWindowNotice] = useState("");
  const [busyPickupWindow, setBusyPickupWindow] = useState("");
  const [creatingPickupWindowStore, setCreatingPickupWindowStore] = useState("");
  const [pickupWindowCreateError, setPickupWindowCreateError] = useState("");
  const [pickupWindowCreateNotice, setPickupWindowCreateNotice] = useState("");
  const [merchantStores, setMerchantStores] = useState<MerchantStore[]>([]);
  const [merchantStoresLoading, setMerchantStoresLoading] = useState(true);
  const [csvStoreId, setCsvStoreId] = useState("");
  const [merchantStoresError, setMerchantStoresError] = useState("");
  const [merchantStoresNotice, setMerchantStoresNotice] = useState("");
  const [storeSaving, setStoreSaving] = useState("");
  const [editingStoreId, setEditingStoreId] = useState("");
  const [showNewStoreForm, setShowNewStoreForm] = useState(false);
  const [creatingWindowStoreId, setCreatingWindowStoreId] = useState("");
  const [reconcilingOrder, setReconcilingOrder] = useState("");
  const [reconcileError, setReconcileError] = useState<{ orderId: string; message: string } | null>(null);
  const [reconcileResult, setReconcileResult] = useState<{ orderId: string; status: string; paymentStatus?: string; finalized: boolean; released: boolean; pickupReference?: string } | null>(null);
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

  const loadPickupWindows = useCallback(async (initial = false) => {
    if (!initial) {
      setPickupWindowsLoading(true);
      setPickupWindowError("");
    }
    try {
      const result = await api<{ pickupWindows?: PickupWindow[]; windows?: PickupWindow[] }>("/api/merchant/pickup-windows");
      setPickupWindows(result.pickupWindows ?? result.windows ?? []);
    } catch (err) {
      setPickupWindowError(err instanceof Error ? err.message : "Pickup windows could not be loaded.");
    } finally {
      setPickupWindowsLoading(false);
    }
  }, []);

  const loadMerchantStores = useCallback(async (initial = false) => {
    if (!initial) {
      setMerchantStoresLoading(true);
      setMerchantStoresError("");
    }
    try {
      const result = await api<{ stores?: MerchantStore[] }>("/api/merchant/stores");
      const receivedStores = result.stores ?? [];
      setMerchantStores(receivedStores);
      setCsvStoreId((current) => receivedStores.some((store) => store.id === current) ? current : receivedStores[0]?.id ?? "");
    } catch (err) {
      setMerchantStoresError(err instanceof Error ? err.message : "Demo merchant stores could not be loaded.");
    } finally {
      setMerchantStoresLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(true);
      void loadPickupWindows(true);
      void loadMerchantStores(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadPickupWindows, loadMerchantStores]);

  async function createMerchantStore(values: MerchantStoreDraft) {
    setStoreSaving("create");
    setMerchantStoresError("");
    setMerchantStoresNotice("");
    try {
      const result = await api<{ store?: MerchantStore }>("/api/merchant/stores", { method: "POST", body: JSON.stringify(values) });
      const created = result.store;
      if (!created?.id || created.name !== values.name || created.city !== values.city || created.timezone !== values.timezone || created.pickupAddress !== values.pickupAddress) {
        throw new Error("The server did not confirm the submitted demo store details.");
      }
      setMerchantStores((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setCsvStoreId((current) => current || created.id);
      setShowNewStoreForm(false);
      setMerchantStoresNotice("The demo store was created and confirmed by the server.");
    } catch (err) {
      setMerchantStoresError(err instanceof Error ? err.message : "The demo store could not be created.");
    } finally {
      setStoreSaving("");
    }
  }

  async function updateMerchantStore(storeId: string, values: MerchantStoreDraft) {
    setStoreSaving(storeId);
    setMerchantStoresError("");
    setMerchantStoresNotice("");
    try {
      const result = await api<{ store?: MerchantStore }>(`/api/merchant/stores/${encodeURIComponent(storeId)}`, { method: "PATCH", body: JSON.stringify(values) });
      const updated = result.store;
      if (!updated?.id || updated.id !== storeId || updated.name !== values.name || updated.city !== values.city || updated.timezone !== values.timezone || updated.pickupAddress !== values.pickupAddress) {
        throw new Error("The server did not confirm the submitted demo store details.");
      }
      setMerchantStores((current) => current.map((store) => store.id === storeId ? updated : store).sort((a, b) => a.name.localeCompare(b.name)));
      setEditingStoreId("");
      setMerchantStoresNotice("Store details were updated and confirmed by the server.");
    } catch (err) {
      setMerchantStoresError(err instanceof Error ? err.message : "Store details could not be updated.");
    } finally {
      setStoreSaving("");
    }
  }

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

  async function reconcileOrder(orderId: string) {
    setReconcilingOrder(orderId);
    setReconcileError(null);
    setReconcileResult(null);
    try {
      const result = await api<{ status?: string; paymentStatus?: string; finalized?: boolean; released?: boolean; pickupReference?: string }>(`/api/merchant/orders/${encodeURIComponent(orderId)}/reconcile`, { method: "POST" });
      if (!result.status) throw new Error("The server did not return a PayPal reconciliation status.");
      const finalized = result.status === "PAID" || result.finalized === true;
      const released = result.released === true;
      setReconcileResult({ orderId, status: result.status, paymentStatus: result.paymentStatus, finalized, released, pickupReference: result.pickupReference });
      if (finalized || released) await load();
    } catch (err) {
      setReconcileError({ orderId, message: err instanceof Error ? err.message : "PayPal status could not be reconciled." });
    } finally {
      setReconcilingOrder("");
    }
  }

  async function updateInventory(lotId: string, quantityAvailable: number, priceCents: number, quantityReserved: number, quantitySold: number) {
    setBusyInventory(lotId);
    setError("");
    setNotice("");
    try {
      const quantityOnHand = quantityOnHandFromAvailable(quantityAvailable, quantityReserved, quantitySold);
      await api(`/api/merchant/inventory/${encodeURIComponent(lotId)}`, { method: "PATCH", body: JSON.stringify({ quantityOnHand, discountedPriceCents: priceCents }) });
      setNotice("Inventory changes were saved to the demo merchant account.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inventory changes could not be saved.");
    } finally {
      setBusyInventory("");
    }
  }

  async function updatePickupWindow(id: string, values: Omit<PickupWindow, "id" | "storeId" | "storeName" | "reservedUnits">) {
    setBusyPickupWindow(id);
    setPickupWindowError("");
    setPickupWindowNotice("");
    try {
      const response = await api<PickupWindow | { window?: PickupWindow; pickupWindow?: PickupWindow }>(`/api/merchant/pickup-windows/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(values) });
      const returned = "pickupWindow" in response ? response.pickupWindow : "window" in response ? response.window : response as PickupWindow;
      if (!returned || returned.id !== id) throw new Error("The server did not confirm the updated pickup window.");
      const existing = pickupWindows.find((item) => item.id === id);
      const updated = { ...existing, ...returned } as PickupWindow;
      setPickupWindows((current) => current.map((item) => item.id === id ? updated : item));
      setPickupWindowNotice("The server confirmed the pickup window update.");
    } catch (err) {
      setPickupWindowError(err instanceof Error ? err.message : "The pickup window update could not be confirmed.");
    } finally {
      setBusyPickupWindow("");
    }
  }

  async function createPickupWindow(storeId: string, values: PickupWindowDraft) {
    setCreatingPickupWindowStore(storeId);
    setPickupWindowCreateError("");
    setPickupWindowCreateNotice("");
    try {
      const result = await api<{ pickupWindow?: PickupWindow }>("/api/merchant/pickup-windows", { method: "POST", body: JSON.stringify({ storeId, ...values }) });
      const created = result.pickupWindow;
      if (!created?.id || created.storeId !== storeId || created.startsAt !== values.startsAt || created.endsAt !== values.endsAt || created.lastReservationAt !== values.lastReservationAt || created.capacityUnits !== values.capacityUnits || created.reservedUnits !== 0 || created.active !== true) {
        throw new Error("The server did not confirm the submitted pickup window.");
      }
      setPickupWindows((current) => current.some((window) => window.id === created.id)
        ? current
        : [...current, created].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      setMerchantStores((current) => current.map((store) => store.id === storeId
        ? { ...store, pickupWindowCount: (store.pickupWindowCount ?? 0) + 1 }
        : store));
      setCreatingWindowStoreId("");
      setPickupWindowCreateNotice(`Pickup window for ${created.storeName ?? "the demo store"} was created and confirmed by the server.`);
    } catch (err) {
      setPickupWindowCreateError(err instanceof Error ? err.message : "Pickup window could not be created. Check the schedule and try again.");
    } finally {
      setCreatingPickupWindowStore("");
    }
  }

  async function importCsv(file?: File) {
    if (!file) return;
    if (!csvStoreId || !merchantStores.some((store) => store.id === csvStoreId)) {
      setError("Choose an owned demo store as the CSV inventory destination.");
      if (csvInput.current) csvInput.current.value = "";
      return;
    }
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
      setError("Choose a CSV file to import inventory.");
      if (csvInput.current) csvInput.current.value = "";
      return;
    }
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ importedCount?: number; message?: string }>(`/api/merchant/inventory/import?storeId=${encodeURIComponent(csvStoreId)}`, { method: "POST", headers: { "Content-Type": "text/csv" }, body: file });
      await load();
      if (!Number.isInteger(result.importedCount) || (result.importedCount ?? -1) < 0 || typeof result.message !== "string" || !result.message.trim()) {
        throw new Error("The server did not confirm the CSV import result. Inventory was refreshed; review the destination store before retrying.");
      }
      setNotice(result.message);
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
    <section className="panel-card" aria-labelledby="merchant-stores-title" style={{ marginBottom: 13, padding: 15 }}>
      <div className="panel-title" style={{ padding: "0 0 12px", minHeight: "auto", marginBottom: 12 }}>
        <div><span className="eyebrow">Demo merchant settings</span><h3 id="merchant-stores-title">Your demo stores</h3></div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="readonly-tag">Fictional demo merchant only</span>
          <button className="quiet-button" type="button" disabled={merchantStoresLoading || Boolean(storeSaving)} onClick={() => void loadMerchantStores()}>{merchantStoresLoading ? "Loading…" : "Refresh stores"}</button>
          <button className="small-action" type="button" disabled={Boolean(storeSaving) || showNewStoreForm || Boolean(editingStoreId)} onClick={() => { setMerchantStoresError(""); setMerchantStoresNotice(""); setShowNewStoreForm(true); }}>Add demo store</button>
        </div>
      </div>
      {merchantStoresError && <StatusNotice kind="error">{merchantStoresError}</StatusNotice>}
      {merchantStoresNotice && <StatusNotice kind="success" onDismiss={() => setMerchantStoresNotice("")}>{merchantStoresNotice}</StatusNotice>}
      {pickupWindowCreateNotice && <StatusNotice kind="success" onDismiss={() => setPickupWindowCreateNotice("")}>{pickupWindowCreateNotice}</StatusNotice>}
      <p style={{ margin: "0 0 11px", color: "#718075", fontSize: 10, lineHeight: 1.5 }}>Manage store details for this seeded demo merchant. The server can reject pickup address or timezone changes while reservations or orders are active. This screen does not create merchant accounts.</p>
      {merchantStoresLoading ? <div className="loading-line" aria-live="polite"><span className="spinner" /> Loading demo merchant stores…</div>
        : merchantStores.length ? <div style={{ display: "grid", gap: 9 }}>{merchantStores.map((store) => <article key={`${store.id}-${store.updatedAt ?? ""}`} className="panel-card" aria-busy={storeSaving === store.id || creatingPickupWindowStore === store.id} style={{ padding: 13, borderColor: "#e4e9e1" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><strong style={{ color: "#344a3b", fontSize: 13 }}>{store.name}</strong><span className="readonly-tag">{store.city}</span></div>
              <address style={{ margin: "6px 0 0", color: "#69776b", fontSize: 10, fontStyle: "normal", lineHeight: 1.6 }}>{store.pickupAddress}</address>
              <p style={{ margin: "3px 0 0", color: "#69776b", fontSize: 10 }}>Timezone: <strong>{store.timezone}</strong></p>
              <small style={{ display: "block", color: "#8a948b", fontSize: 9, marginTop: 5 }}>{store.inventoryListings ?? 0} inventory listings · {store.pickupWindowCount ?? 0} pickup windows · {store.orderCount ?? 0} orders</small>
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              <button type="button" className="quiet-button" disabled={Boolean(storeSaving) || Boolean(creatingPickupWindowStore) || Boolean(busyPickupWindow) || showNewStoreForm || (Boolean(editingStoreId) && editingStoreId !== store.id)} onClick={() => { setPickupWindowCreateError(""); setPickupWindowCreateNotice(""); setCreatingWindowStoreId(creatingWindowStoreId === store.id ? "" : store.id); }}>{creatingWindowStoreId === store.id ? "Close window form" : "Add pickup window"}</button>
              <button type="button" className="quiet-button" disabled={Boolean(storeSaving) || Boolean(creatingPickupWindowStore) || Boolean(busyPickupWindow) || showNewStoreForm || creatingWindowStoreId === store.id || (Boolean(editingStoreId) && editingStoreId !== store.id)} onClick={() => { setMerchantStoresError(""); setMerchantStoresNotice(""); setEditingStoreId(editingStoreId === store.id ? "" : store.id); }}>{editingStoreId === store.id ? "Close editor" : "Edit store"}</button>
            </div>
          </div>
          {editingStoreId === store.id && <MerchantStoreForm key={`edit-${store.id}-${store.updatedAt ?? ""}`} store={store} saving={storeSaving === store.id} disabled={Boolean(storeSaving && storeSaving !== store.id)} onSave={(values) => updateMerchantStore(store.id, values)} onCancel={() => setEditingStoreId("")} />}
          {creatingWindowStoreId === store.id && <>
            {pickupWindowCreateError && <div style={{ marginTop: 9 }}><StatusNotice kind="error">{pickupWindowCreateError}</StatusNotice></div>}
            <CreatePickupWindowForm key={`new-window-${store.id}-${store.updatedAt ?? ""}`} store={store} existingWindows={pickupWindows} saving={creatingPickupWindowStore === store.id} disabled={Boolean(creatingPickupWindowStore && creatingPickupWindowStore !== store.id)} onCreate={createPickupWindow} onCancel={() => { setCreatingWindowStoreId(""); setPickupWindowCreateError(""); }} />
          </>}
        </article>)}</div>
          : <div className="panel-empty compact"><strong>No demo stores returned</strong><p>Create a store for the fictional demo merchant or refresh to retry.</p></div>}
      {showNewStoreForm && <MerchantStoreForm key="new-demo-store" saving={storeSaving === "create"} disabled={Boolean(storeSaving && storeSaving !== "create")} onSave={createMerchantStore} onCancel={() => setShowNewStoreForm(false)} />}
      {storeSaving && <p role="status" aria-live="polite" style={{ margin: "9px 0 0", color: "#617d4f", fontSize: 10 }}>Waiting for the server response. Store details are not changed in the list until the server confirms them.</p>}
    </section>
    <div className="merchant-columns">
      <section className="panel-card order-panel"><div className="panel-title"><div><span className="eyebrow">Order queue</span><h3>Pickups to prepare</h3></div><button type="button" className="quiet-button" onClick={() => void load()} disabled={loading}>Refresh</button></div>
        {loading ? <div className="loading-line"><span className="spinner" /> Loading order data…</div> : orders.length ? <div className="order-list">{orders.map((order) => <article className="order-row" key={order.id}>
          <div className="order-row-main"><div className="order-ident"><strong>#{order.pickupReference ?? order.id.slice(0, 8)}</strong><span className={`order-status status-tag status-${order.status.toLowerCase()}`}>{order.status.replaceAll("_", " ")}</span></div>
            <p>{order.items?.map((item) => `${item.quantity} × ${item.productName ?? item.name ?? "listed item"}`).join(" · ") || "Item details unavailable"}</p>
            <small>{order.storeName ?? "Demo store"} · {dateLabel(order.pickupStart ?? order.createdAt)} · {timeLabel(order.pickupStart)}{order.pickupEnd ? `–${timeLabel(order.pickupEnd)}` : ""}</small>
            {(order.status === "PAYMENT_EXCEPTION" || reconcileResult?.orderId === order.id || reconcileError?.orderId === order.id) && <div style={{ marginTop: 8 }}>
              {reconcileError?.orderId === order.id && <p role="alert" style={{ margin: "0 0 6px", color: "#a34c3e", fontSize: 9 }}>{reconcileError.message}</p>}
              {reconcileResult?.orderId === order.id && <p role="status" aria-live="polite" style={{ margin: "0 0 6px", color: reconcileResult.finalized ? "#37734b" : "#8a6237", fontSize: 9 }}>
                {reconcileResult.finalized
                  ? `Payment verified and finalized${reconcileResult.pickupReference ? ` · pickup reference ${reconcileResult.pickupReference}` : ""}.`
                  : reconcileResult.released
                    ? `PayPal confirmed this order was voided. Reservation ${reconcileResult.status.toLowerCase()} and inventory release confirmed; no payment was recorded.`
                    : `PayPal status: ${reconcileResult.status}${reconcileResult.paymentStatus ? ` · payment ${reconcileResult.paymentStatus}` : ""}. This order is still unpaid or unconfirmed, and its reserved inventory remains held.`}
              </p>}
              {order.status === "PAYMENT_EXCEPTION" && <>
                <button className="small-action" type="button" disabled={Boolean(reconcilingOrder) || loading} onClick={() => void reconcileOrder(order.id)}>{reconcilingOrder === order.id ? "Checking PayPal status…" : "Reconcile PayPal status"}</button>
                {reconcilingOrder === order.id && <p role="status" aria-live="polite" style={{ margin: "6px 0 0", color: "#617d4f", fontSize: 9 }}>Checking the saved order with PayPal Sandbox. Inventory remains reserved during this check.</p>}
              </>}
            </div>}
          </div>
          <div className="order-row-end"><strong>{money(order.amountCents)}</strong>{order.status === "PAID" && <button className="small-action" onClick={() => void confirmPickup(order.id)} disabled={busyOrder === order.id} type="button">{busyOrder === order.id ? "Saving…" : "Confirm pickup"}</button>}</div>
        </article>)}</div> : <div className="panel-empty"><span className="panel-empty-icon"><Icon name="bag" size={23} /></span><strong>No orders yet</strong><p>Paid Sandbox orders will appear here after server-side capture.</p></div>}
      </section>
      <section className="panel-card inventory-panel"><div className="panel-title"><div><span className="eyebrow">Surplus stock</span><h3>Inventory snapshot</h3></div><div className="inventory-actions" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label htmlFor="csv-destination-store" className="field-label" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>CSV destination
          <select id="csv-destination-store" aria-label="CSV inventory destination store" value={csvStoreId} onChange={(event) => setCsvStoreId(event.target.value)} disabled={merchantStoresLoading || importing || merchantStores.length === 0} style={{ minHeight: 31, maxWidth: 230, padding: "5px 7px", color: "#33483a", background: "#fff", border: "1px solid #d8dfd5", borderRadius: 5, fontSize: 10 }}>
            {merchantStores.length ? merchantStores.map((store) => <option key={store.id} value={store.id}>{store.name} · {store.city}</option>) : <option value="">No demo stores available</option>}
          </select>
        </label>
        <span className="readonly-tag">Destination: {merchantStores.find((store) => store.id === csvStoreId)?.name ?? (merchantStoresLoading ? "Loading stores…" : "No store selected")}</span>
        <input ref={csvInput} type="file" accept=".csv,text/csv" aria-label="Choose inventory CSV file" style={{ display: "none" }} onChange={(event) => void importCsv(event.currentTarget.files?.[0])} />
        <button type="button" className="quiet-button" onClick={() => csvInput.current?.click()} disabled={importing || loading || merchantStoresLoading || !csvStoreId}>{importing ? "Importing…" : "Import CSV"}</button>
      </div></div>
        {loading ? <div className="loading-line"><span className="spinner" /> Loading inventory…</div> : inventory.length ? <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>Product</th><th>Available</th><th>Resqiva price</th><th>Actions</th></tr></thead><tbody>{inventory.map((item) => <InventoryEditor key={`${item.lotId ?? item.id}-${item.quantityAvailable}-${item.priceCents}`} item={item} busy={busyInventory === (item.lotId ?? item.id)} onSave={updateInventory} />)}</tbody></table></div> : <div className="panel-empty compact"><strong>No inventory data returned</strong><p>Import a CSV or connect the demo merchant inventory source.</p></div>}
        <p className="panel-footnote">Stock and prices shown here come from server records. Unknown expiry or allergen data stays unknown.</p>
      </section>
    </div>
    <section className="panel-card" aria-labelledby="pickup-windows-title" style={{ marginTop: 13, padding: 15 }}>
      <div className="panel-title" style={{ padding: "0 0 12px", minHeight: "auto", marginBottom: 12 }}><div><span className="eyebrow">Store operations</span><h3 id="pickup-windows-title">Pickup windows</h3></div><button className="quiet-button" type="button" disabled={pickupWindowsLoading || Boolean(busyPickupWindow)} onClick={() => void loadPickupWindows()}>{pickupWindowsLoading ? "Loading…" : "Refresh windows"}</button></div>
      {pickupWindowError && <StatusNotice kind="error">{pickupWindowError}</StatusNotice>}
      {pickupWindowNotice && <StatusNotice kind="success" onDismiss={() => setPickupWindowNotice("")}>{pickupWindowNotice}</StatusNotice>}
      {pickupWindowsLoading ? <div className="loading-line" aria-live="polite"><span className="spinner" /> Loading pickup windows…</div>
        : pickupWindows.length ? <div>{pickupWindows.map((pickupWindow) => <PickupWindowEditor
          key={`${pickupWindow.id}-${pickupWindow.startsAt}-${pickupWindow.endsAt}-${pickupWindow.lastReservationAt}-${pickupWindow.capacityUnits}-${pickupWindow.active}-${pickupWindow.timezone ?? ""}`}
          window={pickupWindow}
          saving={busyPickupWindow === pickupWindow.id}
          disabled={Boolean(busyPickupWindow && busyPickupWindow !== pickupWindow.id)}
          onSave={updatePickupWindow}
        />)}</div>
          : <div className="panel-empty compact"><strong>No pickup windows returned</strong><p>This demo merchant has no pickup windows available to manage.</p></div>}
      <p className="panel-footnote">Capacity and reservations are displayed from server records. Updates are confirmed only after the server returns the changed window.</p>
    </section>
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
  const [reservationReconcileBusy, setReservationReconcileBusy] = useState(false);
  const [reservationReconcileError, setReservationReconcileError] = useState("");
  const [reservationReconcileResult, setReservationReconcileResult] = useState<ReservationReconcileResult | null>(null);
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
      setPlanError("Describe a meal request so we can read your preferences.");
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
      const parsedResult = await api<{ preferences?: PlannerPreferences } | PlannerPreferences>("/api/preferences", {
        method: "POST",
        body: JSON.stringify({
          prompt: prompt.trim(),
          selectedStoreId: storeId,
          budgetCents: Math.round(Number(budget) * 100),
          servings: Number(servings),
          mealCount: Number(mealCount),
        }),
      });
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
    setPrompt("Plan one vegetarian dinner for two people under $25, no peanuts, with pickup tomorrow.");
    setBudget(25);
    setServings(2);
    setMealCount(1);
    void goToPlanner();
  }

  async function reserveAndCheckout(bundle: PlannedBundle) {
    setCheckoutReservation(null);
    setPaymentUncertain(false);
    setReservationReconcileError("");
    setReservationReconcileResult(null);
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
        setReservationReconcileError("");
        setReservationReconcileResult(null);
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
      setReservationReconcileError("");
      setReservationReconcileResult(null);
      setNotice({ kind: "error", message: `Capture could not be confirmed. Payment state may be uncertain and inventory remains reserved; do not retry or cancel until it is reconciled.${err instanceof Error ? ` ${err.message}` : ""}` });
    } finally {
      setCaptureBusy(false);
    }
  }

  async function reconcilePaypalReservation() {
    const reservationId = checkoutReservation?.reservationId;
    if (!reservationId) {
      setReservationReconcileError("This checkout has no reservation reference to reconcile.");
      return;
    }
    setReservationReconcileBusy(true);
    setReservationReconcileError("");
    setReservationReconcileResult(null);
    try {
      await ensureDemoSession("CUSTOMER");
      const result = await api<ReservationReconcileResult>(`/api/reservations/${encodeURIComponent(reservationId)}/reconcile`, { method: "POST" });
      if (result.status === "PAID") {
        if (!result.orderId) {
          throw new Error("The server returned PAID without a receipt reference. Checkout remains open; no receipt redirect was attempted.");
        }
        setReservationReconcileResult(result);
        setPaymentUncertain(false);
        setCheckoutReservation(null);
        setOrdersRefreshKey((current) => current + 1);
        router.push(`/orders/${encodeURIComponent(result.orderId)}`);
        return;
      }
      if ((result.status === "CANCELLED" || result.status === "EXPIRED") && result.released === true) {
        setReservationReconcileResult(result);
        setPaymentUncertain(false);
        setCheckoutReservation(null);
        setNotice({ kind: "info", message: `Reservation status ${result.status}; the server confirmed inventory was released. No payment was recorded.` });
        return;
      }
      setReservationReconcileResult(result);
    } catch (err) {
      setReservationReconcileError(err instanceof Error
        ? `${err.message} Inventory remains held; you can check again later.`
        : "Payment status could not be checked. Inventory remains held; you can check again later.");
    } finally {
      setReservationReconcileBusy(false);
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
    setReservationReconcileError("");
    setReservationReconcileResult(null);
    setNotice({ kind: "error", message: "PayPal reported an error. Payment or order state may be uncertain. Inventory remains reserved for reconciliation; no cancellation was sent." });
  }

  const dailyStoreCount = stores.length;

  return <main id="top">
    <header className="site-header"><div className="header-inner"><Brand /><nav className="main-nav" aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#planner">Meal planner</a><button type="button" onClick={() => void goToOrders()}>My orders</button><button type="button" onClick={() => { void switchWorkspace("merchant"); document.getElementById("workspace")?.scrollIntoView({ behavior: "smooth" }); }}>For merchants</button></nav><div className="header-actions"><span className="sandbox-indicator"><span /> Sandbox demo</span><button className="button button-dark header-cta" onClick={() => void goToPlanner()} type="button">Plan a meal <Icon name="arrow" size={16} /></button></div><button className="mobile-cta" type="button" aria-label="Go to meal planner" onClick={() => void goToPlanner()}><Icon name="bag" /></button></div></header>

    <section className="hero-section" aria-labelledby="hero-title"><div className="hero-orb hero-orb-one" /><div className="hero-orb hero-orb-two" /><div className="hero-inner"><div className="hero-copy"><div className="hero-label"><span className="label-line" /> Better meals. Less waste.</div><h1 id="hero-title">Good food deserves <em>a second plate.</em></h1><p>Turn nearby surplus groceries into complete meals that fit your budget, your table, and the selected pickup window.</p><div className="hero-actions"><button className="button button-lime" type="button" onClick={() => void goToPlanner()}>Build my meal plan <Icon name="arrow" size={17} /></button><button className="hero-link" type="button" onClick={() => document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })}>See how it works <Icon name="arrow" size={16} /></button></div><div className="hero-proof"><div className="proof-leaf"><Icon name="leaf" size={16} /></div><p><strong>{storesLoading ? "Loading" : dailyStoreCount} demo stores</strong><span>Fictional inventory · real constraints</span></p></div></div><div className="hero-visual" aria-label="Illustration of a rescued grocery basket"><div className="visual-backdrop" /><div className="visual-card visual-card-top"><span className="visual-card-icon"><Icon name="leaf" size={17} /></span><div><strong>Picked for your table</strong><small>Stock-checked and budget-aware</small></div><span className="visual-check"><Icon name="check" size={14} /></span></div><div className="produce-scene"><div className="scene-sun" /><div className="produce produce-tomato"><span /></div><div className="produce produce-pear"><span /></div><div className="produce produce-leaf"><span /><i /><b /></div><div className="produce produce-carrot"><span /></div><div className="basket"><div className="basket-top" /><div className="basket-body"><span /><span /><span /></div><div className="basket-handle" /></div><div className="scene-shadow" /></div><div className="visual-card visual-card-bottom"><span className="tiny-chart"><i /><i /><i /><i /><i /></span><span><strong>Price, explained</strong><small>Compared with listed original prices</small></span></div><span className="visual-caption">A better kind of grocery run</span></div></div><div className="hero-bottomline"><span>Rescue food</span><i /> <span>Build practical meals</span><i /> <span>Pay securely with PayPal Sandbox</span></div></section>

    <section id="how-it-works" className="how-section"><div className="section-heading"><div><span className="eyebrow">Simple by design</span><h2>From surplus shelf to <span>something delicious.</span></h2></div><p>The free demo parser reads your request. A deterministic planner checks real stock, prices, and pickup details.</p></div><div className="steps-grid"><article className="step-card"><span className="step-number">01</span><span className="step-icon step-icon-soft"><Icon name="spark" size={22} /></span><h3>Say what works</h3><p>Share a budget, servings, dietary needs, and when you can pick up.</p></article><article className="step-card"><span className="step-number">02</span><span className="step-icon step-icon-green"><Icon name="grid" size={22} /></span><h3>Get a grounded plan</h3><p>Every suggested item and price traces back to store inventory. Hard constraints come first.</p></article><article className="step-card"><span className="step-number">03</span><span className="step-icon step-icon-gold"><Icon name="bag" size={22} /></span><h3>Reserve, approve, collect</h3><p>Your server reserves stock and creates a PayPal Sandbox order. Capture is verified before inventory is committed.</p></article></div></section>

    <section id="planner" className="planner-section"><div className="planner-heading"><div><span className="eyebrow">Resqiva meal studio</span><h2>Make a plan that <span>makes sense.</span></h2><p>Tell us what you need. We’ll match it to available surplus, not imagined ingredients.</p></div><DemoBadge /></div>
      {notice && <StatusNotice kind={notice.kind} onDismiss={() => setNotice(null)}>{notice.message}</StatusNotice>}
      {captureBusy && <StatusNotice kind="info">Resqiva is updating checkout status. The order appears as paid only after server-verified capture.</StatusNotice>}
      <div className="planner-layout"><form className="planner-form" onSubmit={findMeals}><div className="form-top"><div><span className="form-step">YOUR REQUEST <span>· STEP 1 OF 2</span></span><h3>What sounds good?</h3></div><span className="lock-note"><span className="lock-dot" /> Free parser. Server verifies.</span></div>
        <label className="field-label" htmlFor="request">Describe your meals and preferences</label><textarea id="request" className="request-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="For example: one vegetarian dinner for two people, under $25, no peanuts, ready to pick up tomorrow." rows={4} required /><div className="prompt-help"><span><Icon name="spark" size={15} /> State your budget, meals, servings, diet, items to avoid, and pickup date</span><button type="button" className="text-button compact-link" onClick={useExample}>Use sample request</button></div>
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
      {checkoutReservation && <CheckoutPanel checkout={checkoutReservation} clientId={paypalClientId} configLoading={paypalConfigLoading} configError={paypalConfigError} busy={captureBusy} uncertain={paymentUncertain} reconcileBusy={reservationReconcileBusy} reconcileError={reservationReconcileError} reconcileResult={reservationReconcileResult} onCreateOrder={createPaypalOrder} onApprove={approvePaypalOrder} onCancel={cancelPaypalReservation} onReconcile={reconcilePaypalReservation} onError={handlePaypalError} onClose={() => setCheckoutReservation(null)} onReserve={reserveAndCheckout} />}
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
