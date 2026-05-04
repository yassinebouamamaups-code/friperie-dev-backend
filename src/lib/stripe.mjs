import crypto from "node:crypto";
import { config, hasStripeConfig } from "../config.mjs";
import { httpError } from "./http.mjs";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2025-03-31.basil";

export async function createStripeCheckoutSession(order) {
  ensureStripeConfig();

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("ui_mode", "custom");
  params.set("return_url", `${config.appBaseUrl}${config.stripe.successPath}?session_id={CHECKOUT_SESSION_ID}&order=${encodeURIComponent(order.orderNumber)}`);
  params.set("customer_email", order.customer.email);
  params.set("customer_creation", "if_required");
  params.set("client_reference_id", order.orderNumber);
  params.set("metadata[order_number]", order.orderNumber);
  params.set("metadata[invoice_number]", order.invoiceNumber);
  params.set("metadata[payment_provider]", "stripe");
  params.set("payment_intent_data[metadata][order_number]", order.orderNumber);
  params.set("payment_intent_data[metadata][invoice_number]", order.invoiceNumber);

  order.items.forEach((item, index) => {
    params.set(`line_items[${index}][quantity]`, String(item.quantity));
    params.set(`line_items[${index}][price_data][currency]`, config.stripe.currency);
    params.set(`line_items[${index}][price_data][unit_amount]`, String(toMinorUnits(item.unitAmount)));
    params.set(`line_items[${index}][price_data][product_data][name]`, item.name);
    const descriptionParts = [item.category, item.size ? `Taille ${item.size}` : ""].filter(Boolean);
    if (descriptionParts.length) {
      params.set(`line_items[${index}][price_data][product_data][description]`, descriptionParts.join(" - "));
    }
  });

  return stripeRequest("/checkout/sessions", {
    method: "POST",
    body: params
  });
}

export async function retrieveStripeCheckoutSession(sessionId) {
  ensureStripeConfig();
  return stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET"
  });
}

export function verifyStripeWebhookSignature(rawBody, signatureHeader) {
  ensureStripeWebhookSecret();

  const header = String(signatureHeader || "");
  const elements = header.split(",").map((part) => part.trim());
  const timestamp = elements.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = elements.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));

  if (!timestamp || !signatures.length) {
    throw httpError(400, "Signature Stripe invalide.");
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", config.stripe.webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  const isMatch = signatures.some((signature) => safeEqual(signature, expected));
  if (!isMatch) {
    throw httpError(400, "Echec de verification du webhook Stripe.");
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function stripeRequest(resourcePath, options) {
  ensureStripeConfig();

  const response = await fetch(`${STRIPE_API_BASE}${resourcePath}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${config.stripe.secretKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
      "Content-Type": options.body instanceof URLSearchParams
        ? "application/x-www-form-urlencoded"
        : "application/json",
      "User-Agent": "la-goutte-de-mer-payments/1.0"
    },
    body: options.body
      ? options.body instanceof URLSearchParams
        ? options.body.toString()
        : JSON.stringify(options.body)
      : undefined
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw httpError(response.status, "Stripe a refuse la requete.", payload);
  }

  return payload;
}

function toMinorUnits(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function ensureStripeConfig() {
  if (!hasStripeConfig()) {
    throw httpError(501, "Stripe n'est pas encore configure.");
  }
}

function ensureStripeWebhookSecret() {
  if (!config.stripe.webhookSecret) {
    throw httpError(500, "STRIPE_WEBHOOK_SECRET manquant.");
  }
}
