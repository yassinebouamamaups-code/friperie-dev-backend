import crypto from "node:crypto";
import { config } from "../config.mjs";
import { orderStore } from "./json-store.mjs";
import { findCatalogItems, loadCatalog } from "./catalog.mjs";
import { httpError } from "./http.mjs";
import { isProductUnavailable, markItemsUnavailable } from "./inventory.mjs";
import { sendOrderEmails, sendShippingStatusEmail } from "./mailer.mjs";
import { writeInvoice } from "./invoice.mjs";
import { applyShipmentTrackingUpdate, createShipmentForOrder, resolveShippingSelection } from "./sendcloud.mjs";

export async function buildDraftOrder(payload) {
  const customer = normalizeCustomer(payload.customer);
  const cart = normalizeCart(payload.cart);
  if (!cart.length) {
    throw httpError(400, "Le panier est vide.");
  }

  const catalog = await loadCatalog();
  const items = findCatalogItems(catalog, cart);
  const soldItem = items.find((item) => isProductUnavailable(item.id, catalog));
  if (soldItem) {
    throw httpError(409, `L'article ${soldItem.name} n'est plus disponible.`);
  }
  const itemsSubtotalAmount = items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
  const shipping = buildShippingSelection(payload.shipping, {
    orderAmount: itemsSubtotalAmount,
    country: customer.country || "FR",
    items
  });
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const totalAmount = itemsSubtotalAmount + (shipping.shippingAmount || 0);
  const order = {
    id: crypto.randomUUID(),
    orderNumber: `CMD-${stamp}-${Math.floor(Math.random() * 900 + 100)}`,
    invoiceNumber: `${config.invoicePrefix}-${stamp}`,
    createdAt: now.toISOString(),
    createdAtLabel: now.toLocaleString("fr-FR"),
    status: "draft",
    paymentProvider: clean(payload.paymentProvider || "paypal") || "paypal",
    customer,
    items,
    shipping,
    itemsSubtotalAmount,
    totalAmount,
    seller: config.seller,
    paypal: {
      orderId: null,
      captureId: null,
      status: "created"
    },
    stripe: {
      sessionId: null,
      paymentIntentId: null,
      status: "created",
      checkoutUrl: null
    },
    invoice: null,
    notifications: {
      emailedAt: null,
      shippingStatusEmails: []
    }
  };

  orderStore.save(order);
  return order;
}

export function attachPayPalOrder(order, paypalOrder) {
  const approvalLink = (paypalOrder.links || []).find((link) => ["approve", "payer-action"].includes(link.rel))?.href || "";
  const next = {
    ...order,
    status: "paypal_created",
    paypal: {
      ...order.paypal,
      orderId: paypalOrder.id,
      status: paypalOrder.status || "CREATED",
      approvalUrl: approvalLink
    }
  };

  orderStore.save(next);
  return next;
}

export function attachStripeSession(order, stripeSession) {
  const next = {
    ...order,
    status: "stripe_created",
    stripe: {
      ...order.stripe,
      sessionId: stripeSession.id,
      paymentIntentId: stripeSession.payment_intent || null,
      checkoutUrl: stripeSession.url || null,
      status: stripeSession.status || "open",
      rawSession: stripeSession
    }
  };

  orderStore.save(next);
  return next;
}

export async function markOrderPaidFromCapture(paypalOrderId, capturePayload) {
  const existing = orderStore.findByPayPalOrderId(paypalOrderId);
  if (!existing) {
    throw httpError(404, "Commande locale introuvable pour cet ordre PayPal.");
  }

  const capture = capturePayload?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture?.id) {
    throw httpError(502, "Réponse de capture PayPal incomplète.", capturePayload);
  }

  const next = {
    ...existing,
    status: "paid",
    paidAt: new Date().toISOString(),
    paypal: {
      ...existing.paypal,
      status: capturePayload.status || "COMPLETED",
      captureId: capture.id,
      captureStatus: capture.status || "COMPLETED",
      payer: capturePayload.payer || null,
      rawCapture: capturePayload
    }
  };
  next.shipping = await attachShipment(next);

  const invoice = writeInvoice(next);
  next.invoice = {
    fileName: invoice.fileName,
    absolutePath: invoice.absolutePath
  };
  next.inventoryUpdate = markItemsUnavailable(next.items);
  orderStore.save(next);

  if (!next.notifications.emailedAt) {
    await sendOrderEmails(next, invoice);
    next.notifications = {
      ...next.notifications,
      emailedAt: new Date().toISOString()
    };
    orderStore.save(next);
  }

  return next;
}

export async function markOrderPaidFromStripeSession(sessionId, sessionPayload) {
  const existing = orderStore.findByStripeSessionId(sessionId);
  if (!existing) {
    throw httpError(404, "Commande locale introuvable pour cette session Stripe.");
  }

  const next = {
    ...existing,
    status: "paid",
    paidAt: new Date().toISOString(),
    stripe: {
      ...existing.stripe,
      sessionId: sessionPayload.id || existing.stripe.sessionId,
      paymentIntentId: sessionPayload.payment_intent || existing.stripe.paymentIntentId,
      status: sessionPayload.payment_status || sessionPayload.status || "paid",
      rawSession: sessionPayload
    }
  };
  next.shipping = await attachShipment(next);

  const invoice = writeInvoice(next);
  next.invoice = {
    fileName: invoice.fileName,
    absolutePath: invoice.absolutePath
  };
  next.inventoryUpdate = markItemsUnavailable(next.items);
  orderStore.save(next);

  if (!next.notifications.emailedAt) {
    await sendOrderEmails(next, invoice);
    next.notifications = {
      ...next.notifications,
      emailedAt: new Date().toISOString()
    };
    orderStore.save(next);
  }

  return next;
}

export function getOrder(orderNumber) {
  const order = orderStore.findByOrderNumber(orderNumber);
  if (!order) {
    throw httpError(404, "Commande introuvable.");
  }
  return order;
}

export function getOrderByPayPalOrderId(paypalOrderId) {
  const order = orderStore.findByPayPalOrderId(paypalOrderId);
  if (!order) {
    throw httpError(404, "Commande PayPal introuvable.");
  }
  return order;
}

export function getOrderByStripeSessionId(sessionId) {
  const order = orderStore.findByStripeSessionId(sessionId);
  if (!order) {
    throw httpError(404, "Commande Stripe introuvable.");
  }
  return order;
}

export function getOrderBySendcloudParcelId(parcelId) {
  const order = orderStore.findBySendcloudParcelId(parcelId);
  if (!order) {
    throw httpError(404, "Commande Sendcloud introuvable.");
  }
  return order;
}

export async function updateOrderShippingFromWebhook(parcelId, webhookPayload) {
  const existing = getOrderBySendcloudParcelId(parcelId);
  const next = applyShipmentTrackingUpdate(existing, webhookPayload);
  orderStore.save(next);

  const notificationKey = buildShipmentNotificationKey(next.shipping?.shipment);
  const sentKeys = Array.isArray(next.notifications?.shippingStatusEmails)
    ? next.notifications.shippingStatusEmails
    : [];

  if (
    notificationKey
    && notificationKey !== buildShipmentNotificationKey(existing.shipping?.shipment)
    && !sentKeys.includes(notificationKey)
    && shouldNotifyCustomerForShipment(next.shipping?.shipment)
  ) {
    await sendShippingStatusEmail(next);
    next.notifications = {
      ...next.notifications,
      shippingStatusEmails: [...sentKeys, notificationKey]
    };
    orderStore.save(next);
  }

  return next;
}

function normalizeCart(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => ({
    id: String(item?.id || "").trim(),
    quantity: Number.parseInt(String(item?.quantity || 1), 10),
    name: clean(item?.name),
    category: clean(item?.category),
    size: clean(item?.size),
    image: clean(item?.image),
    unitAmount: parseClientAmount(item?.unitAmount ?? item?.price)
  })).filter((item) => item.id);
}

function parseClientAmount(value) {
  const normalized = clean(value)
    .replace(/\s/g, "")
    .replace("EUR", "")
    .replace(/\u20ac/g, "")
    .replace(",", ".");
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeCustomer(customer) {
  const normalized = {
    firstName: clean(customer?.firstName),
    lastName: clean(customer?.lastName),
    email: clean(customer?.email),
    phone: clean(customer?.phone),
    addressLine1: clean(customer?.addressLine1),
    postalCode: clean(customer?.postalCode),
    city: clean(customer?.city),
    country: clean(customer?.country || "FR"),
    customerNote: clean(customer?.customerNote)
  };

  const requiredFields = [
    "firstName",
    "lastName",
    "email",
    "phone",
    "addressLine1",
    "postalCode",
    "city"
  ];

  for (const field of requiredFields) {
    if (!normalized[field]) {
      throw httpError(400, `Champ client obligatoire manquant: ${field}`);
    }
  }

  return normalized;
}

function clean(value) {
  return String(value || "").trim();
}

function buildShippingSelection(shippingPayload, context) {
  const optionId = clean(shippingPayload?.optionId);
  if (!optionId) {
    throw httpError(400, "Choisissez un mode de livraison.");
  }

  const selectedOption = resolveShippingSelection(optionId, context);
  const selectedServicePoint = selectedOption.requiresServicePoint
    ? normalizeSelectedServicePoint(shippingPayload?.servicePoint, selectedOption)
    : null;
  const itemCount = context.items.reduce((sum, item) => sum + item.quantity, 0);
  const packageWeightKg = Number((config.shipping.defaultWeightKg * Math.max(itemCount, 1)).toFixed(3));

  return {
    country: clean(context.country || config.shipping.defaultCountry).toUpperCase(),
    selectedOption,
    selectedServicePoint,
    shippingAmount: selectedOption.shippingAmount,
    package: {
      weightKg: packageWeightKg,
      lengthCm: config.shipping.defaultLengthCm,
      widthCm: config.shipping.defaultWidthCm,
      heightCm: config.shipping.defaultHeightCm,
      itemsCount: itemCount
    },
    shipment: null
  };
}

async function attachShipment(order) {
  try {
    return {
      ...order.shipping,
      shipment: await createShipmentForOrder(order)
    };
  } catch (error) {
    return {
      ...order.shipping,
      shipment: {
        enabled: true,
        provider: "sendcloud",
        status: "error",
        message: error?.message || "La creation du colis a echoue.",
        details: error?.details || null
      }
    };
  }
}

function shouldNotifyCustomerForShipment(shipment) {
  const normalizedMessage = clean(shipment?.statusMessage).toLowerCase();
  if (!normalizedMessage) {
    return false;
  }

  return [
    "ready to send",
    "parcel en route",
    "awaiting customer pickup",
    "delivered",
    "delivery attempt failed",
    "unable to deliver",
    "returned to sender"
  ].includes(normalizedMessage);
}

function buildShipmentNotificationKey(shipment) {
  const statusCode = shipment?.statusCode == null ? "" : String(shipment.statusCode);
  const statusMessage = clean(shipment?.statusMessage).toLowerCase();
  if (!statusCode && !statusMessage) {
    return "";
  }
  return `${statusCode}:${statusMessage}`;
}

function normalizeSelectedServicePoint(servicePoint, selectedOption) {
  const servicePointId = Number.parseInt(clean(servicePoint?.servicePointId ?? servicePoint?.service_point_id ?? servicePoint?.id), 10);
  if (!Number.isFinite(servicePointId) || servicePointId <= 0) {
    throw httpError(400, `Choisissez un point relais pour ${selectedOption.label}.`);
  }

  return {
    servicePointId,
    postNumber: clean(servicePoint?.postNumber ?? servicePoint?.post_number),
    carrier: clean(servicePoint?.carrier),
    name: clean(servicePoint?.name),
    street: clean(servicePoint?.street),
    houseNumber: clean(servicePoint?.houseNumber ?? servicePoint?.house_number),
    postalCode: clean(servicePoint?.postalCode ?? servicePoint?.postal_code),
    city: clean(servicePoint?.city),
    country: clean(servicePoint?.country || config.shipping.defaultCountry).toUpperCase()
  };
}
