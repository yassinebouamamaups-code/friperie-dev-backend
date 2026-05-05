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
  },
  shipping: {
    defaultCountry: cleanEnv(process.env.SHIPPING_DEFAULT_COUNTRY || "FR").toUpperCase(),
    freeThreshold: parsePositiveNumber(process.env.SHIPPING_FREE_THRESHOLD, 50),
    defaultWeightKg: parsePositiveNumber(process.env.SHIPPING_DEFAULT_WEIGHT_KG, 0.35),
    defaultLengthCm: parsePositiveNumber(process.env.SHIPPING_DEFAULT_LENGTH_CM, 35),
    defaultWidthCm: parsePositiveNumber(process.env.SHIPPING_DEFAULT_WIDTH_CM, 25),
    defaultHeightCm: parsePositiveNumber(process.env.SHIPPING_DEFAULT_HEIGHT_CM, 6)
  },
  sendcloud: {
    publicKey: process.env.SENDCLOUD_PUBLIC_KEY || "",
    secretKey: process.env.SENDCLOUD_SECRET_KEY || "",
    senderAddressId: process.env.SENDCLOUD_SENDER_ADDRESS_ID || "",
    shippingOptions: parseJsonEnv(process.env.SENDCLOUD_SHIPPING_OPTIONS_JSON, defaultSendcloudShippingOptions())
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

function parseJsonEnv(value, fallback) {
  const normalized = cleanEnv(value);
  if (!normalized) return fallback;

  try {
    const parsed = JSON.parse(normalized);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function parsePositiveNumber(value, fallback) {
  const amount = Number.parseFloat(cleanEnv(value).replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : fallback;
}

function cleanEnv(value) {
  return String(value || "").trim();
}

function defaultSendcloudShippingOptions() {
  return [
    {
      id: "colissimo-home",
      label: "Colissimo domicile",
      type: "home",
      carrier: "Colissimo",
      description: "Livraison a domicile avec suivi.",
      price: 3.99,
      freeAboveOrderAmount: 50,
      estimatedDaysMin: 2,
      estimatedDaysMax: 3,
      country: "FR",
      matcher: {
        carrier: "colissimo",
        nameIncludes: "domicile"
      }
    },
    {
      id: "colissimo-relay",
      label: "Colissimo point relais",
      type: "service_point",
      carrier: "Colissimo",
      description: "Retrait en point relais avec suivi.",
      price: 3.99,
      freeAboveOrderAmount: 50,
      estimatedDaysMin: 2,
      estimatedDaysMax: 3,
      country: "FR",
      pickerCarriers: ["colissimo"],
      matcher: {
        carrier: "colissimo",
        nameIncludes: ""
      }
    },
    {
      id: "mondial-relay",
      label: "Mondial Relay",
      type: "service_point",
      carrier: "Mondial Relay",
      description: "Retrait en point relais proche de chez vous.",
      price: 3.99,
      freeAboveOrderAmount: 50,
      estimatedDaysMin: 3,
      estimatedDaysMax: 4,
      country: "FR",
      pickerCarriers: ["mondial_relay"],
      matcher: {
        carrier: "mondial",
        nameIncludes: ""
      }
    },
    {
      id: "chronopost-relay",
      label: "Chronopost point relais",
      type: "service_point",
      carrier: "Chronopost",
      description: "Retrait rapide en point relais avec suivi.",
      price: 3.99,
      freeAboveOrderAmount: 50,
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      country: "FR",
      pickerCarriers: ["chronopost"],
      matcher: {
        carrier: "chronopost",
        nameIncludes: ""
      }
    },
    {
      id: "chronopost-home",
      label: "Chronopost express",
      type: "home",
      carrier: "Chronopost",
      description: "Livraison rapide a domicile avec suivi.",
      price: 8.9,
      freeAboveOrderAmount: null,
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      country: "FR",
      matcher: {
        carrier: "chronopost",
        nameIncludes: ""
      }
    }
  ];
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
