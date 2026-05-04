import { config } from "../config.mjs";
import { httpError } from "./http.mjs";

export async function loadCatalog() {
  if (!config.catalogSourceUrl) {
    throw httpError(500, "CATALOG_SOURCE_URL manquant.");
  }

  const response = await fetch(buildCatalogSourceUrl(config.catalogSourceUrl), {
    headers: { "Cache-Control": "no-cache" }
  });

  if (!response.ok) {
    throw httpError(502, "Impossible de charger le catalogue source.");
  }

  const text = await response.text();
  return parseCsv(text)
    .map(normalizeProduct)
    .filter((product) => product.id && product.name && product.unitAmount > 0);
}

function buildCatalogSourceUrl(sourceUrl) {
  const value = clean(sourceUrl);
  if (!value.includes("docs.google.com")) {
    return value;
  }

  const separator = value.includes("?") ? "&" : "?";
  return `${value}${separator}_=${Date.now()}`;
}

export function findCatalogItems(catalog, cartItems) {
  return cartItems.map((cartItem) => {
    const found = catalog.find((product) => product.id === String(cartItem.id));
    if (!found) {
      if (config.paypal.environment === "sandbox" && cartItem.name && cartItem.unitAmount > 0) {
        return {
          id: String(cartItem.id),
          name: cartItem.name,
          category: cartItem.category || "",
          size: cartItem.size || "",
          quantity: normalizeQuantity(cartItem.quantity, cartItem.id),
          unitAmount: cartItem.unitAmount,
          image: cartItem.image || ""
        };
      }

      throw httpError(400, `Produit introuvable dans le catalogue: ${cartItem.id}`);
    }

    const quantity = normalizeQuantity(cartItem.quantity, cartItem.id);

    return {
      id: found.id,
      name: found.name,
      category: found.category,
      size: found.size,
      quantity,
      unitAmount: found.unitAmount,
      image: found.image
    };
  });
}

function normalizeQuantity(value, productId) {
  const quantity = Number.parseInt(String(value || 1), 10);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw httpError(400, `Quantité invalide pour le produit ${productId}`);
  }
  return quantity;
}

function normalizeProduct(raw) {
  return {
    id: clean(raw.id),
    name: clean(raw.nom),
    category: clean(raw.categorie),
    size: clean(raw.taille),
    reactivate: isTruthy(raw.reactiver),
    image: clean((raw.photos || "").split(/[|;]/)[0]),
    unitAmount: parsePrice(raw.promo || raw.prix)
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (current === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (current === '"') {
      quoted = !quoted;
      continue;
    }

    if (current === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((current === "\n" || current === "\r") && !quoted) {
      if (current === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += current;
  }

  row.push(cell);
  if (row.some(Boolean)) rows.push(row);

  const headers = (rows.shift() || []).map((value) => clean(value));
  return rows.map((values) => {
    const entry = {};
    headers.forEach((header, index) => {
      entry[header] = clean(values[index] || "");
    });
    return entry;
  });
}

function parsePrice(value) {
  const normalized = clean(value)
    .replace(/\s/g, "")
    .replace("EUR", "")
    .replace(/\u20ac/g, "")
    .replace(",", ".");
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function clean(value) {
  return String(value || "").trim();
}

function isTruthy(value) {
  return ["oui", "yes", "true", "1", "x"].includes(clean(value).toLowerCase());
}
