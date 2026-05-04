import fs from "node:fs";
import { config } from "../config.mjs";

function readOrders() {
  if (!fs.existsSync(config.ordersFile)) {
    return [];
  }

  const content = fs.readFileSync(config.ordersFile, "utf8").trim();
  if (!content) return [];

  try {
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  const tempFile = `${config.ordersFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(orders, null, 2), "utf8");
  fs.renameSync(tempFile, config.ordersFile);
}

export const orderStore = {
  list() {
    return readOrders();
  },
  findByOrderNumber(orderNumber) {
    return readOrders().find((entry) => entry.orderNumber === orderNumber) || null;
  },
  findByPayPalOrderId(paypalOrderId) {
    return readOrders().find((entry) => entry.paypal?.orderId === paypalOrderId) || null;
  },
  findByPayPalCaptureId(captureId) {
    return readOrders().find((entry) => entry.paypal?.captureId === captureId) || null;
  },
  findByStripeSessionId(sessionId) {
    return readOrders().find((entry) => entry.stripe?.sessionId === sessionId) || null;
  },
  findByStripePaymentIntentId(paymentIntentId) {
    return readOrders().find((entry) => entry.stripe?.paymentIntentId === paymentIntentId) || null;
  },
  save(order) {
    const orders = readOrders();
    const index = orders.findIndex((entry) => entry.orderNumber === order.orderNumber);
    if (index >= 0) {
      orders[index] = order;
    } else {
      orders.push(order);
    }
    writeOrders(orders);
    return order;
  }
};
