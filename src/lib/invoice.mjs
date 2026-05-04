import fs from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";

export function formatPrice(value) {
  return Number(value || 0).toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR"
  });
}

export function buildInvoiceHtml(order) {
  const itemRows = order.items.map((item) => `
    <tr>
      <td>${escapeHtml(item.name)}${item.size ? `<br><small>Taille : ${escapeHtml(item.size)}</small>` : ""}</td>
      <td>${item.quantity}</td>
      <td>${escapeHtml(formatPrice(item.unitAmount))}</td>
      <td>${escapeHtml(formatPrice(item.unitAmount * item.quantity))}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(order.invoiceNumber)}</title>
  <style>
    body { margin: 0; background: #f6f1e7; color: #1f1b15; font-family: Georgia, serif; }
    main { max-width: 900px; margin: 0 auto; background: #fffdf8; padding: 48px 32px 56px; }
    header, .meta, footer { display: flex; justify-content: space-between; gap: 24px; }
    header { border-bottom: 2px solid #d1b27a; padding-bottom: 24px; }
    h1, h2 { margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .box { flex: 1; border: 1px solid #eadcc2; padding: 18px; background: #ffffff; }
    .meta { margin-top: 28px; }
    table { width: 100%; border-collapse: collapse; margin-top: 28px; }
    th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid #eee3cf; }
    th:last-child, td:last-child { text-align: right; }
    .totals { width: min(360px, 100%); margin-left: auto; margin-top: 22px; }
    .totals div { display: flex; justify-content: space-between; padding: 8px 0; }
    footer { margin-top: 40px; border-top: 1px solid #eadcc2; padding-top: 20px; color: #6e6048; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Facture</h1>
        <p><strong>${escapeHtml(config.seller.brandName)}</strong></p>
        <p>${escapeHtml(config.seller.addressLine1)}</p>
        <p>${escapeHtml(`${config.seller.postalCode} ${config.seller.city}`.trim())}</p>
        <p>${escapeHtml(config.seller.country)}</p>
      </div>
      <div>
        <p><strong>Facture</strong> ${escapeHtml(order.invoiceNumber)}</p>
        <p><strong>Commande</strong> ${escapeHtml(order.orderNumber)}</p>
        <p><strong>Date</strong> ${escapeHtml(order.createdAtLabel)}</p>
        <p><strong>Paiement</strong> ${escapeHtml(order.paymentProvider)}</p>
      </div>
    </header>

    <section class="meta">
      <div class="box">
        <h2>Client</h2>
        <p>${escapeHtml(order.customer.firstName)} ${escapeHtml(order.customer.lastName)}</p>
        <p>${escapeHtml(order.customer.addressLine1)}</p>
        <p>${escapeHtml(`${order.customer.postalCode} ${order.customer.city}`)}</p>
        <p>${escapeHtml(order.customer.email)}</p>
        <p>${escapeHtml(order.customer.phone)}</p>
      </div>
      <div class="box">
        <h2>Vendeur</h2>
        <p>Email : ${escapeHtml(config.seller.email)}</p>
        <p>Téléphone : ${escapeHtml(config.seller.phone)}</p>
        ${config.seller.siret ? `<p>SIRET : ${escapeHtml(config.seller.siret)}</p>` : ""}
        ${config.seller.vatNumber ? `<p>TVA : ${escapeHtml(config.seller.vatNumber)}</p>` : ""}
      </div>
    </section>

    <table>
      <thead>
        <tr>
          <th>Article</th>
          <th>Qté</th>
          <th>Prix unitaire</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <div class="totals">
      <div><span>Sous-total</span><span>${escapeHtml(formatPrice(order.totalAmount))}</span></div>
      <div><strong>Total</strong><strong>${escapeHtml(formatPrice(order.totalAmount))}</strong></div>
    </div>

    <footer>
      <p>Transaction PayPal : ${escapeHtml(order.paypal.captureId || order.paypal.orderId || "")}</p>
      <p>Facture générée automatiquement après confirmation du paiement.</p>
    </footer>
  </main>
</body>
</html>`;
}

export function writeInvoice(order) {
  const fileName = `${order.invoiceNumber}.html`;
  const absolutePath = path.join(config.invoicesDir, fileName);
  const html = buildInvoiceHtml(order);
  fs.writeFileSync(absolutePath, html, "utf8");
  return {
    fileName,
    absolutePath,
    html
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
