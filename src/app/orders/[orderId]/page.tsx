"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

type ReceiptOrder = {
  id: string;
  status: string;
  paymentStatus?: string;
  amountCents: number;
  createdAt?: string;
  pickupStart?: string;
  pickupEnd?: string;
  pickupReference?: string;
  storeName?: string;
  items?: Array<{ productName?: string; name?: string; quantity: number; unitPriceCents?: number }>;
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function dateTime(value?: string) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Riyadh" }).format(date);
}

export default function OrderConfirmationPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const [order, setOrder] = useState<ReceiptOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/orders", { cache: "no-store" })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            const message = typeof payload?.error === "string" ? payload.error : "Sign in to the shopper demo to view this receipt.";
            throw new Error(message);
          }
          const found = (payload.orders as ReceiptOrder[] | undefined)?.find((item) => item.id === orderId);
          if (!found) throw new Error("This order is not available in the current shopper demo account.");
          setOrder(found);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "The order receipt could not be loaded."))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [orderId]);

  const paid = order?.status === "PAID" || order?.status === "FULFILLED";

  return <main style={{ minHeight: "100vh", background: "#f7f7f1", color: "#193528", padding: "48px 20px" }}>
    <div style={{ width: "min(100%, 720px)", margin: "0 auto" }}>
      <Link href="/" style={{ color: "#315f45", fontWeight: 700, textDecoration: "none" }}>← Resqiva</Link>
      <section style={{ marginTop: 28, padding: "clamp(24px, 6vw, 48px)", background: "#fff", border: "1px solid #e4e8df", borderRadius: 18, boxShadow: "0 12px 40px #203b2410" }}>
        {loading ? <p role="status">Loading your order receipt…</p>
          : error ? <div role="alert"><h1 style={{ marginTop: 0 }}>Receipt unavailable</h1><p>{error}</p><Link href="/" style={{ color: "#315f45", fontWeight: 700 }}>Return to Resqiva</Link></div>
            : order ? <>
              <div style={{ color: paid ? "#257246" : "#a45d12", fontSize: 13, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>{paid ? "Payment verified" : `Order ${order.status.toLowerCase().replaceAll("_", " ")}`}</div>
              <h1 style={{ fontFamily: "Georgia, serif", fontSize: "clamp(32px, 7vw, 48px)", letterSpacing: "-.04em", lineHeight: 1.08, margin: "10px 0 12px" }}>{paid ? "Your meal is ready to pick up." : "Your order status"}</h1>
              <p style={{ color: "#67776b", lineHeight: 1.6 }}>{paid ? "PayPal Sandbox confirmed the capture and Resqiva matched it to this saved reservation." : "The order is not marked paid unless the server verified PayPal capture."}</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, margin: "24px 0" }}>
                <div style={{ padding: 16, background: "#f4f7f1", borderRadius: 10 }}><small style={{ color: "#6e7d70" }}>PICKUP REFERENCE</small><div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{order.pickupReference ?? order.id.slice(-8).toUpperCase()}</div></div>
                <div style={{ padding: 16, background: "#f4f7f1", borderRadius: 10 }}><small style={{ color: "#6e7d70" }}>TOTAL</small><div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{money(order.amountCents)}</div></div>
                <div style={{ padding: 16, background: "#f4f7f1", borderRadius: 10 }}><small style={{ color: "#6e7d70" }}>STORE</small><div style={{ fontWeight: 700, marginTop: 6 }}>{order.storeName ?? "Demo store"}</div></div>
                <div style={{ padding: 16, background: "#f4f7f1", borderRadius: 10 }}><small style={{ color: "#6e7d70" }}>PICKUP WINDOW · RIYADH</small><div style={{ fontWeight: 700, marginTop: 6 }}>{dateTime(order.pickupStart)}{order.pickupEnd ? ` – ${dateTime(order.pickupEnd)}` : ""}</div></div>
              </div>
              <h2 style={{ fontSize: 19 }}>Order items</h2>
              <ul style={{ padding: 0, listStyle: "none", borderTop: "1px solid #e6eae3" }}>{(order.items ?? []).map((item, index) => <li key={`${item.productName ?? item.name}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "13px 0", borderBottom: "1px solid #e6eae3" }}><span>{item.quantity} × {item.productName ?? item.name ?? "Listed item"}</span>{item.unitPriceCents != null && <strong>{money(item.unitPriceCents * item.quantity)}</strong>}</li>)}</ul>
              <div style={{ marginTop: 20, padding: 14, background: "#fbf7e9", borderRadius: 10, color: "#665b38", fontSize: 13, lineHeight: 1.5 }}>Fictional demo inventory. This receipt reflects a PayPal Sandbox order and is not a production payment.</div>
              <p style={{ marginTop: 24 }}><Link href="/" style={{ color: "#315f45", fontWeight: 700 }}>Plan another meal</Link></p>
            </> : null}
      </section>
    </div>
  </main>;
}
