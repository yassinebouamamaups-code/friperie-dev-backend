import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const dataDir = path.join(backendRoot, "data");
const invoicesDir = path.join(dataDir, "invoices");
const ordersFile = path.join(dataDir, "orders.json");
const envFile = path.join(backendRoot, ".env");

loadDotEnv(envFile);
ensureDir(dataDir);
ensureDir(invoicesDir);

export const config = {
  backendRoot,
  dataDir,
  invoicesDir,
  ordersFile,
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number.parseInt(process.env.PORT || "3001", 10),
  appBaseUrl: requiredUrl(process.env.APP_BASE_URL || "http://localhost:3001"),
  siteBaseUrl: requiredUrl(process.env.SITE_BASE_URL || "http://127.0.0.1:5500"),
  catalogSourceUrl: process.env.CATALOG_SOURCE_URL || "",
  catalogWriteFile: resolveOptionalPath(process.env.CATALOG_WRITE_FILE || ""),
  invoicePrefix: process.env.INVOICE_PREFIX || "FAC",
  paypal: {
    environment: (process.env.PAYPAL_ENV || "sandbox").toLowerCase(),
    clientId: process.env.PAYPAL_CLIENT_ID || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
    webhookId: process.env.PAYPAL_WEBHOOK_ID || "",
    brandName: process.env.PAYPAL_BRAND_NAME || "La Goutte de Mer Shop",
    locale: process.env.PAYPAL_LOCALE || "fr-FR",
    shippingPreference: process.env.PAYPAL_SHIPPING_PREFERENCE || "SET_PROVIDED_ADDRESS"
  },
  stripe: {
    environment: (process.env.STRIPE_ENV || "test").toLowerCase(),
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    currency: (process.env.STRIPE_CURRENCY || "eur").toLowerCase(),
    successPath: process.env.STRIPE_SUCCESS_PATH || "/payment/stripe/success",
    cancelPath: process.env.STRIPE_CANCEL_PATH || "/payment/stripe/cancel"
  },
  seller: {
    brandName: process.env.SELLER_BRAND_NAME || "La Goutte de Mer Shop",
    email: process.env.SELLER_EMAIL || "",
    phone: process.env.SELLER_PHONE || "",
    addressLine1: process.env.SELLER_ADDRESS_LINE1 || "",
    city: process.env.SELLER_CITY || "",
    postalCode: process.env.SELLER_POSTAL_CODE || "",
    country: process.env.SELLER_COUNTRY || "France",
    siret: process.env.SELLER_SIRET || "",
    vatNumber: process.env.SELLER_VAT_NUMBER || ""
  },
  email: {
    mode: (process.env.EMAIL_MODE || "log").toLowerCase(),
    provider: (process.env.EMAIL_PROVIDER || "resend").toLowerCase(),
    from: process.env.EMAIL_FROM || "",
    resendApiKey: process.env.RESEND_API_KEY || "",
    clientNotificationEmail: process.env.CLIENT_NOTIFICATION_EMAIL || ""
  }
};

export function paypalApiBase() {
  return config.paypal.environment === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export function hasStripeConfig() {
  return Boolean(config.stripe.secretKey);
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function requiredUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveOptionalPath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(backendRoot, normalized);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    const normalized = rawValue.replace(/^['"]|['"]$/g, "");
    process.env[key] = normalized;
  }
}
