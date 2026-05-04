import http from "node:http";
import { URL } from "node:url";
import { config } from "./config.mjs";
import { loadCatalog } from "./lib/catalog.mjs";
import { getUnavailableProductIds } from "./lib/inventory.mjs";
import { capturePayPalOrder, createPayPalOrder, verifyWebhook } from "./lib/paypal.mjs";
import { createStripeCheckoutSession, retrieveStripeCheckoutSession, verifyStripeWebhookSignature } from "./lib/stripe.mjs";
import { attachPayPalOrder, attachStripeSession, buildDraftOrder, getOrder, getOrderByPayPalOrderId, getOrderByStripeSessionId, markOrderPaidFromCapture, markOrderPaidFromStripeSession } from "./lib/order-service.mjs";
import { handleError, noContent, readJsonBody, readRawBody, sendJson, redirect } from "./lib/http.mjs";

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url || !request.method) {
      sendJson(response, 400, { error: "Requête invalide." });
      return;
    }

    if (request.method === "OPTIONS") {
      noContent(response);
      return;
    }

    const url = new URL(request.url, config.appBaseUrl);

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        service: "payments-backend",
        environment: config.nodeEnv,
        paypalEnvironment: config.paypal.environment,
        stripeEnvironment: config.stripe.environment
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/stripe/config") {
      sendJson(response, 200, {
        ok: true,
        publishableKey: config.stripe.publishableKey || "",
        enabled: Boolean(config.stripe.publishableKey && config.stripe.secretKey)
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/availability") {
      const catalog = await loadCatalog();
      sendJson(response, 200, {
        ok: true,
        unavailableIds: getUnavailableProductIds(catalog)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/checkout/paypal/order") {
      const payload = await readJsonBody(request);
      payload.paymentProvider = "paypal";
      const order = await buildDraftOrder(payload);
      const paypalOrder = await createPayPalOrder(order);
      const savedOrder = attachPayPalOrder(order, paypalOrder);

      sendJson(response, 201, {
        orderNumber: savedOrder.orderNumber,
        invoiceNumber: savedOrder.invoiceNumber,
        paypalOrderId: savedOrder.paypal.orderId,
        approvalUrl: savedOrder.paypal.approvalUrl,
        totalAmount: savedOrder.totalAmount
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/checkout/stripe/session") {
      const payload = await readJsonBody(request);
      payload.paymentProvider = "stripe";
      const order = await buildDraftOrder(payload);
      const stripeSession = await createStripeCheckoutSession(order);
      const savedOrder = attachStripeSession(order, stripeSession);

      sendJson(response, 201, {
        orderNumber: savedOrder.orderNumber,
        invoiceNumber: savedOrder.invoiceNumber,
        stripeSessionId: savedOrder.stripe.sessionId,
        clientSecret: stripeSession.client_secret || "",
        totalAmount: savedOrder.totalAmount
      });
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/checkout/paypal/order/") && url.pathname.endsWith("/capture")) {
      const parts = url.pathname.split("/");
      const paypalOrderId = decodeURIComponent(parts[5] || "");
      let order = null;

      try {
        const capturePayload = await capturePayPalOrder(paypalOrderId);
        order = await markOrderPaidFromCapture(paypalOrderId, capturePayload);
      } catch (error) {
        if (error?.statusCode === 409 || error?.statusCode === 422) {
          order = getOrderByPayPalOrderId(paypalOrderId);
        } else {
          throw error;
        }
      }

      sendJson(response, 200, {
        ok: true,
        orderNumber: order.orderNumber,
        invoiceNumber: order.invoiceNumber,
        status: order.status,
        captureId: order.paypal.captureId,
        invoicePath: order.invoice?.absolutePath || null
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/paypal/webhooks") {
      const event = await readJsonBody(request);
      const verified = await verifyWebhook(request.headers, event);

      if (!verified) {
        sendJson(response, 400, { error: "Webhook PayPal non vérifié." });
        return;
      }

      if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
        const paypalOrderId = event.resource?.supplementary_data?.related_ids?.order_id;
        if (paypalOrderId) {
          try {
            await markOrderPaidFromCapture(paypalOrderId, {
              status: "COMPLETED",
              payer: event.resource?.payer || null,
              purchase_units: [
                {
                  payments: {
                    captures: [
                      {
                        id: event.resource?.id,
                        status: event.resource?.status || "COMPLETED"
                      }
                    ]
                  }
                }
              ]
            });
          } catch (error) {
            console.error("[webhook] capture sync failed", error);
          }
        }
      }

      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/stripe/webhooks") {
      const rawBody = await readRawBody(request);
      verifyStripeWebhookSignature(rawBody, request.headers["stripe-signature"]);
      const event = rawBody ? JSON.parse(rawBody) : {};

      if (event.type === "checkout.session.completed") {
        const session = event.data?.object;
        if (session?.id) {
          try {
            await markOrderPaidFromStripeSession(session.id, session);
          } catch (error) {
            console.error("[webhook] stripe checkout sync failed", error);
          }
        }
      }

      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/orders/")) {
      const orderNumber = decodeURIComponent(url.pathname.split("/")[3] || "");
      const order = getOrder(orderNumber);
      sendJson(response, 200, { order });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/checkout/stripe/session/")) {
      const sessionId = decodeURIComponent(url.pathname.split("/")[5] || "");
      const remoteSession = await retrieveStripeCheckoutSession(sessionId);
      const localOrder = getOrderByStripeSessionId(sessionId);

      sendJson(response, 200, {
        ok: true,
        orderNumber: localOrder.orderNumber,
        sessionId: remoteSession.id,
        status: remoteSession.status,
        paymentStatus: remoteSession.payment_status
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/payment/success") {
      const targetUrl = new URL(`${config.siteBaseUrl}/`);
      url.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
      });
      targetUrl.searchParams.set("payment", "success");
      redirect(response, targetUrl.toString());
      return;
    }

    if (request.method === "GET" && url.pathname === "/payment/cancel") {
      const targetUrl = new URL(`${config.siteBaseUrl}/`);
      url.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
      });
      targetUrl.searchParams.set("payment", "cancel");
      redirect(response, targetUrl.toString());
      return;
    }

    if (request.method === "GET" && url.pathname === config.stripe.successPath) {
      const targetUrl = new URL(`${config.siteBaseUrl}/`);
      url.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
      });
      targetUrl.searchParams.set("payment", "success");
      targetUrl.searchParams.set("provider", "stripe");
      redirect(response, targetUrl.toString());
      return;
    }

    if (request.method === "GET" && url.pathname === config.stripe.cancelPath) {
      const targetUrl = new URL(`${config.siteBaseUrl}/`);
      url.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
      });
      targetUrl.searchParams.set("payment", "cancel");
      targetUrl.searchParams.set("provider", "stripe");
      redirect(response, targetUrl.toString());
      return;
    }

    sendJson(response, 404, { error: "Route introuvable." });
  } catch (error) {
    handleError(response, error);
  }
});

server.listen(config.port, () => {
  console.log(`Payments backend listening on ${config.appBaseUrl}`);
});
