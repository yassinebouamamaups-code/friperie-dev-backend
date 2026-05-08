import { config } from "../config.mjs";
import { httpError } from "./http.mjs";

const PROMOTION_CACHE_TTL_MS = 60 * 1000;
let promotionsCache = {
  expiresAt: 0,
  items: []
};

export async function validatePromotionCode(promoCode, items) {
  const normalizedCode = clean(promoCode).toUpperCase();
  if (!normalizedCode) {
    return null;
  }

  const promotions = await loadPromotions();
  const promotion = promotions.find((entry) => entry.code === normalizedCode && isPromotionCurrentlyActive(entry));
  if (!promotion) {
    throw httpError(400, "Code promo erroné.");
  }

  const normalizedItems = Array.isArray(items) ? items : [];
  const originalSubtotalAmount = roundCurrency(
    normalizedItems.reduce((sum, item) => sum + (Number(item?.unitAmount || 0) * Math.max(Number(item?.quantity || 0), 0)), 0)
  );

  if (promotion.minimumOrderAmount > 0 && originalSubtotalAmount < promotion.minimumOrderAmount) {
    throw httpError(400, `Code promo disponible dès ${formatPromoAmount(promotion.minimumOrderAmount)} d'achat.`);
  }

  const discountAmount = computeDiscountAmount(promotion, originalSubtotalAmount);

  return {
    code: promotion.code,
    type: promotion.type,
    percentOff: promotion.type === "percent" ? promotion.value : null,
    fixedOff: promotion.type === "fixed" ? promotion.value : null,
    discountAmount,
    originalSubtotalAmount,
    discountedSubtotalAmount: roundCurrency(Math.max(originalSubtotalAmount - discountAmount, 0))
  };
}

export async function getActivePromotionBanner() {
  const promotions = await loadPromotions();
  const activePromotion = promotions.find((entry) => isPromotionCurrentlyActive(entry));
  if (!activePromotion) {
    return null;
  }

  return {
    code: activePromotion.code,
    type: activePromotion.type,
    value: activePromotion.value,
    minimumOrderAmount: activePromotion.minimumOrderAmount,
    message: buildPromotionBannerMessage(activePromotion)
  };
}

export function applyPromotionToItems(items, promotion) {
  if (!promotion) {
    return Array.isArray(items) ? items : [];
  }

  const normalizedItems = Array.isArray(items) ? items : [];
  const lineItems = normalizedItems.map((item, index) => ({
    item,
    index,
    quantity: Math.max(Number.parseInt(String(item?.quantity || 0), 10) || 0, 0),
    unitAmountCents: toMinorUnits(item?.unitAmount),
    lineTotalCents: toMinorUnits(item?.unitAmount) * Math.max(Number.parseInt(String(item?.quantity || 0), 10) || 0, 0)
  }));

  const subtotalCents = lineItems.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const discountCents = toMinorUnits(promotion.discountAmount);
  if (subtotalCents <= 0 || discountCents <= 0) {
    return normalizedItems;
  }

  let remainingDiscountCents = Math.min(discountCents, subtotalCents);
  const discountableIndexes = lineItems
    .map((line, index) => (line.quantity > 0 && line.lineTotalCents > 0 ? index : -1))
    .filter((index) => index >= 0);
  const lastDiscountableIndex = discountableIndexes[discountableIndexes.length - 1] ?? -1;
  const discountedLines = lineItems.map((line, lineIndex) => {
    if (line.quantity <= 0 || line.lineTotalCents <= 0) {
      return {
        ...line,
        discountedLineTotalCents: line.lineTotalCents
      };
    }

    const proportionalDiscount = lineIndex === lastDiscountableIndex
      ? remainingDiscountCents
      : Math.min(
          remainingDiscountCents,
          Math.round((discountCents * line.lineTotalCents) / subtotalCents)
        );
    const lineDiscountCents = Math.min(proportionalDiscount, line.lineTotalCents);
    remainingDiscountCents -= lineDiscountCents;

    return {
      ...line,
      discountedLineTotalCents: line.lineTotalCents - lineDiscountCents
    };
  });

  return discountedLines.map((line) => {
    if (line.quantity <= 0) {
      return line.item;
    }

    return {
      ...line.item,
      originalUnitAmount: roundCurrency(line.unitAmountCents / 100),
      unitAmount: roundCurrency((line.discountedLineTotalCents / line.quantity) / 100)
    };
  });
}

async function loadPromotions() {
  const now = Date.now();
  if (promotionsCache.expiresAt > now) {
    return promotionsCache.items;
  }

  let promotions = [];
  const sourceUrl = clean(config.promotions?.sourceUrl);
  if (sourceUrl) {
    promotions = await loadPromotionsFromCsv(sourceUrl);
  } else {
    promotions = loadPromotionsFromEnvFallback();
  }

  promotionsCache = {
    expiresAt: now + PROMOTION_CACHE_TTL_MS,
    items: promotions
  };

  return promotions;
}

async function loadPromotionsFromCsv(sourceUrl) {
  const response = await fetch(buildSourceUrl(sourceUrl), {
    headers: { "Cache-Control": "no-cache" }
  });

  if (!response.ok) {
    throw httpError(502, "Impossible de charger les codes promo.");
  }

  const text = await response.text();
  return parseCsv(text)
    .map(normalizePromotion)
    .filter((entry) => entry.code && entry.value > 0);
}

function loadPromotionsFromEnvFallback() {
  const configured = config.promotions?.codes;
  if (Array.isArray(configured)) {
    return configured
      .map((entry) => normalizePromotion(entry))
      .filter((entry) => entry.code && entry.value > 0);
  }

  if (configured && typeof configured === "object") {
    return Object.entries(configured)
      .map(([code, value]) => normalizePromotion({ code, valeur: value, type: "percent", actif: "oui" }))
      .filter((entry) => entry.code && entry.value > 0);
  }

  return [];
}

function normalizePromotion(raw) {
  const type = normalizePromotionType(raw?.type);
  const value = parseAmount(raw?.valeur ?? raw?.value ?? raw?.percentOff ?? raw?.fixedOff ?? raw?.rate);
  return {
    code: clean(raw?.code).toUpperCase(),
    type,
    value,
    active: isTruthy(raw?.actif ?? raw?.active ?? "oui"),
    startsAt: parseDateBoundary(raw?.date_debut ?? raw?.startsAt, "start"),
    endsAt: parseDateBoundary(raw?.date_fin ?? raw?.endsAt, "end"),
    minimumOrderAmount: parseAmount(raw?.minimum_commande ?? raw?.minimumOrderAmount)
  };
}

function normalizePromotionType(value) {
  return clean(value).toLowerCase() === "fixed" ? "fixed" : "percent";
}

function computeDiscountAmount(promotion, subtotalAmount) {
  if (promotion.type === "fixed") {
    return roundCurrency(Math.min(promotion.value, subtotalAmount));
  }

  return roundCurrency(subtotalAmount * (promotion.value / 100));
}

function buildPromotionBannerMessage(promotion) {
  const reduction = promotion.type === "fixed"
    ? `-${formatPromoAmount(promotion.value)}`
    : `-${promotion.value}%`;
  const minimum = promotion.minimumOrderAmount > 0
    ? ` dès ${formatPromoAmount(promotion.minimumOrderAmount)} d'achat`
    : "";
  return `Code ${promotion.code} actif : ${reduction}${minimum}`;
}

function isPromotionCurrentlyActive(promotion) {
  if (!promotion?.active) {
    return false;
  }

  const now = Date.now();
  if (promotion.startsAt && now < promotion.startsAt.getTime()) {
    return false;
  }
  if (promotion.endsAt && now > promotion.endsAt.getTime()) {
    return false;
  }
  return true;
}

function buildSourceUrl(sourceUrl) {
  const value = clean(sourceUrl);
  if (!value.includes("docs.google.com")) {
    return value;
  }

  const separator = value.includes("?") ? "&" : "?";
  return `${value}${separator}_=${Date.now()}`;
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

function parseDateBoundary(value, boundary) {
  const normalized = clean(value);
  if (!normalized) return null;

  const date = boundary === "end"
    ? new Date(`${normalized}T23:59:59.999Z`)
    : new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseAmount(value) {
  const amount = Number.parseFloat(clean(value).replace(",", "."));
  return Number.isFinite(amount) ? Math.max(amount, 0) : 0;
}

function formatPromoAmount(value) {
  return Number(value || 0).toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR"
  });
}

function toMinorUnits(value) {
  return Math.round(Number(value || 0) * 100);
}

function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function clean(value) {
  return String(value || "").trim();
}

function isTruthy(value) {
  return ["oui", "yes", "true", "1", "x"].includes(clean(value).toLowerCase());
}
