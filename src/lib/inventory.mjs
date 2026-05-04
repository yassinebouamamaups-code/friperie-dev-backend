import fs from "node:fs";
import { config } from "../config.mjs";
import { orderStore } from "./json-store.mjs";

export function markItemsUnavailable(items) {
  if (!config.catalogWriteFile) {
    return { updated: false, reason: "CATALOG_WRITE_FILE non configure." };
  }

  if (!fs.existsSync(config.catalogWriteFile)) {
    return { updated: false, reason: "Fichier catalogue introuvable." };
  }

  const ids = new Set((Array.isArray(items) ? items : [])
    .map((item) => clean(item?.id))
    .filter(Boolean));

  if (!ids.size) {
    return { updated: false, reason: "Aucun article a mettre a jour." };
  }

  const source = fs.readFileSync(config.catalogWriteFile, "utf8");
  const rows = parseCsv(source);
  if (!rows.length) {
    return { updated: false, reason: "Catalogue vide." };
  }

  const headers = rows[0];
  const statusIndex = headers.findIndex((header) => clean(header).toLowerCase() === "statut");
  const idIndex = headers.findIndex((header) => clean(header).toLowerCase() === "id");

  if (idIndex < 0) {
    return { updated: false, reason: "Colonne id introuvable." };
  }

  if (statusIndex < 0) {
    headers.push("statut");
  }

  let changed = 0;
  const effectiveStatusIndex = statusIndex >= 0 ? statusIndex : headers.length - 1;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    while (row.length < headers.length) row.push("");

    if (!ids.has(clean(row[idIndex]))) continue;
    if (clean(row[effectiveStatusIndex]).toLowerCase() === "indisponible") continue;

    row[effectiveStatusIndex] = "indisponible";
    changed += 1;
  }

  if (!changed) {
    return { updated: false, reason: "Aucun statut modifie." };
  }

  fs.writeFileSync(config.catalogWriteFile, stringifyCsv(rows), "utf8");
  return { updated: true, changed };
}

export function getUnavailableProductIds(catalog = []) {
  const reactivatedIds = new Set(
    (Array.isArray(catalog) ? catalog : [])
      .filter((product) => product?.reactivate)
      .map((product) => clean(product?.id))
      .filter(Boolean)
  );
  const ids = new Set();

  orderStore.list().forEach((order) => {
    if (clean(order?.status).toLowerCase() !== "paid") return;
    (Array.isArray(order.items) ? order.items : []).forEach((item) => {
      const id = clean(item?.id);
      if (reactivatedIds.has(id)) return;
      if (id) ids.add(id);
    });
  });

  return Array.from(ids);
}

export function isProductUnavailable(productId, catalog = []) {
  const id = clean(productId);
  if (!id) return false;
  return getUnavailableProductIds(catalog).includes(id);
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
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += current;
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== "") {
    rows.push(row);
  }

  return rows;
}

function stringifyCsv(rows) {
  return rows
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n");
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function clean(value) {
  return String(value || "").trim();
}
