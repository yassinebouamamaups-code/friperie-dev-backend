import fs from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";

export function formatPrice(value) {
  return Number(value || 0).toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR"
  });
}

export function buildInvoiceHtml(order, options = {}) {
  const footerLinkHtml = buildInvoiceFooterLinkHtml(order, options);
  const shippingAmount = Number(order.shipping?.shippingAmount || 0);
  const itemRows = order.items.map((item) => `
    <tr>
      <td>${escapeHtml(item.name)}${item.size ? `<br><small>Taille : ${escapeHtml(item.size)}</small>` : ""}</td>
      <td>${item.quantity}</td>
      <td>${escapeHtml(formatPrice(item.unitAmount))}</td>
      <td>${escapeHtml(formatPrice(item.unitAmount * item.quantity))}</td>
    </tr>
  `).join("");
  const shippingRow = order.shipping?.selectedOption
    ? `
    <tr>
      <td>Livraison${order.shipping.selectedOption.carrier ? `<br><small>${escapeHtml(order.shipping.selectedOption.carrier)}</small>` : ""}</td>
      <td>1</td>
      <td>${escapeHtml(formatPrice(shippingAmount))}</td>
      <td>${escapeHtml(formatPrice(shippingAmount))}</td>
    </tr>
  `
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(order.invoiceNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f1e7; color: #1f1b15; font-family: Georgia, serif; }
    body, p, td, th, div, span, a, strong, small { max-width: 100%; }
    main { max-width: 900px; margin: 0 auto; background: #fffdf8; padding: 48px 32px 56px; overflow: hidden; }
    header, .meta, footer { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
    header > div, .meta > div { flex: 1 1 280px; min-width: 0; }
    header { border-bottom: 2px solid #d1b27a; padding-bottom: 24px; }
    h1, h2 { margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .box { flex: 1; border: 1px solid #eadcc2; padding: 18px; background: #ffffff; }
    .meta { margin-top: 28px; }
    .table-wrap { width: 100%; max-width: 100%; overflow-x: auto; overflow-y: hidden; margin-top: 28px; }
    table { width: 100%; border-collapse: collapse; min-width: 640px; }
    th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid #eee3cf; }
    th:last-child, td:last-child { text-align: right; }
    .totals { width: min(360px, 100%); margin-left: auto; margin-top: 22px; }
    .totals div { display: flex; justify-content: space-between; padding: 8px 0; }
    footer { margin-top: 40px; border-top: 1px solid #eadcc2; padding-top: 20px; color: #6e6048; align-items: flex-start; flex-wrap: wrap; }
    footer p { margin: 0; flex: 1 1 240px; min-width: 0; }
    .footer-link { overflow-wrap: anywhere; word-break: break-word; }
    @media (max-width: 700px) {
      body { font-size: 15px; }
      main { padding: 24px 16px 32px; }
      header, .meta, footer { gap: 16px; }
      header > div, .meta > div, footer p { flex-basis: 100%; }
      .box { padding: 14px; }
      .table-wrap { margin-top: 20px; }
      table { min-width: 520px; }
      th, td { padding: 10px 8px; }
      .totals { width: 100%; }
    }
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
        <p>Telephone : ${escapeHtml(config.seller.phone)}</p>
        ${config.seller.siret ? `<p>SIRET : ${escapeHtml(config.seller.siret)}</p>` : ""}
        ${config.seller.vatNumber ? `<p>TVA : ${escapeHtml(config.seller.vatNumber)}</p>` : ""}
      </div>
    </section>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Article</th>
            <th>Qte</th>
            <th>Prix unitaire</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}${shippingRow}</tbody>
      </table>
    </div>

    <div class="totals">
      <div><span>Sous-total articles</span><span>${escapeHtml(formatPrice(order.itemsSubtotalAmount || order.totalAmount))}</span></div>
      <div><span>Livraison</span><span>${escapeHtml(formatPrice(shippingAmount))}</span></div>
      <div><strong>Total</strong><strong>${escapeHtml(formatPrice(order.totalAmount))}</strong></div>
    </div>

    <footer>
      <p>Transaction PayPal : ${escapeHtml(order.paypal.captureId || order.paypal.orderId || "")}</p>
      ${footerLinkHtml}
      <p>Facture generee automatiquement apres confirmation du paiement.</p>
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

function buildInvoiceFooterLinkHtml(order, options) {
  const audience = String(options.audience || "client").trim().toLowerCase();
  const shipment = order.shipping?.shipment;
  const trackingUrl = cleanLink(
    shipment?.trackingUrl
    || shipment?.sendcloudTrackingUrl
  );
  const shippingLabelUrl = cleanLink(
    shipment?.label?.normal_printer
    || shipment?.label?.printer
    || shipment?.label?.label_printer
    || shipment?.rawParcel?.label?.normal_printer
    || shipment?.rawParcel?.label?.printer
    || shipment?.rawParcel?.label?.label_printer
    || shipment?.rawParcel?.label
  );

  if (audience === "seller" && shippingLabelUrl) {
    return `<p class="footer-link">Etiquette d'envoi : <a href="${escapeHtml(shippingLabelUrl)}">Telecharger l'etiquette</a></p>`;
  }

  if (trackingUrl) {
    return `<p class="footer-link">Suivi livraison : <a href="${escapeHtml(trackingUrl)}">Suivre la livraison</a></p>`;
  }

  return "";
}

function cleanLink(value) {
  const link = String(value || "").trim();
  return /^https?:\/\//i.test(link) ? link : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
