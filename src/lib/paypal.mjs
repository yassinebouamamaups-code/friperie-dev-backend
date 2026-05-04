import crypto from "node:crypto";
import { config, paypalApiBase } from "../config.mjs";
import { httpError } from "./http.mjs";

export async function createPayPalOrder(order) {
  const body = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: order.orderNumber,
        custom_id: order.orderNumber,
        invoice_id: order.invoiceNumber,
        description: `Commande ${order.orderNumber}`,
        amount: {
          currency_code: "EUR",
          value: order.totalAmount.toFixed(2),
          breakdown: {
            item_total: {
              currency_code: "EUR",
              value: order.totalAmount.toFixed(2)
            }
          }
        },
        items: order.items.map((item) => ({
          name: item.name.slice(0, 127),
          unit_amount: {
            currency_code: "EUR",
            value: item.unitAmount.toFixed(2)
          },
          quantity: String(item.quantity),
          category: "PHYSICAL_GOODS"
        })),
        shipping: {
          name: {
            full_name: `${order.customer.firstName} ${order.customer.lastName}`.trim()
          },
          address: {
            address_line_1: order.customer.addressLine1,
            admin_area_2: order.customer.city,
            postal_code: order.customer.postalCode,
            country_code: "FR"
          }
        }
      }
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: config.paypal.brandName,
          locale: config.paypal.locale,
          shipping_preference: config.paypal.shippingPreference,
          user_action: "PAY_NOW",
          return_url: `${config.appBaseUrl}/payment/success?order=${encodeURIComponent(order.orderNumber)}`,
          cancel_url: `${config.appBaseUrl}/payment/cancel?order=${encodeURIComponent(order.orderNumber)}`
        }
      }
    }
  };

  return paypalRequest("/v2/checkout/orders", {
    method: "POST",
    body
  });
}

export async function capturePayPalOrder(paypalOrderId) {
  return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: "POST",
    body: {}
  });
}

export async function verifyWebhook(headers, webhookEvent) {
  if (!config.paypal.webhookId) {
    throw httpError(500, "PAYPAL_WEBHOOK_ID manquant.");
  }

  const response = await paypalRequest("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      transmission_id: headerValue(headers["paypal-transmission-id"]),
      transmission_time: headerValue(headers["paypal-transmission-time"]),
      cert_url: headerValue(headers["paypal-cert-url"]),
      auth_algo: headerValue(headers["paypal-auth-algo"]),
      transmission_sig: headerValue(headers["paypal-transmission-sig"]),
      webhook_id: config.paypal.webhookId,
      webhook_event: webhookEvent
    }
  });

  return response.verification_status === "SUCCESS";
}

function headerValue(value) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

async function paypalRequest(resourcePath, options) {
  ensurePayPalConfig();
  const accessToken = await getAccessToken();
  const response = await fetch(`${paypalApiBase()}${resourcePath}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "PayPal-Request-Id": crypto.randomUUID()
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw httpError(response.status, "PayPal a refusé la requête.", payload);
  }

  return payload;
}

async function getAccessToken() {
  ensurePayPalConfig();
  const encoded = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64");
  const response = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encoded}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    const message = await response.text();
    throw httpError(response.status, "Impossible d'obtenir le token PayPal.", message);
  }

  const payload = await response.json();
  return payload.access_token;
}

function ensurePayPalConfig() {
  if (!config.paypal.clientId || !config.paypal.clientSecret) {
    throw httpError(500, "PAYPAL_CLIENT_ID ou PAYPAL_CLIENT_SECRET manquant.");
  }
}
