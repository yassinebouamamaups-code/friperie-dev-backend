import { Buffer } from "node:buffer";
import { config } from "../config.mjs";
import { httpError } from "./http.mjs";

const SENDCLOUD_API_BASE = "https://panel.sendcloud.sc/api/v2";
const shippingMethodsCache = new Map();

export function isSendcloudEnabled() {
  return Boolean(config.sendcloud.publicKey && config.sendcloud.secretKey);
}

export function getServicePointPickerConfig() {
  return {
    enabled: Boolean(config.sendcloud.publicKey),
    publicKey: clean(config.sendcloud.publicKey)
  };
}

export function listConfiguredShippingOptions({ orderAmount = 0, country = "", items = [] } = {}) {
  const normalizedCountry = normalizeCountryCode(country || config.shipping.defaultCountry);

  return normalizeShippingOptionsConfig()
    .filter((option) => !option.country || option.country === normalizedCountry)
    .map((option) => buildCheckoutShippingOption(option, orderAmount, items));
}

export function resolveShippingSelection(selectedOptionId, { orderAmount = 0, country = "", items = [] } = {}) {
  const options = listConfiguredShippingOptions({ orderAmount, country, items });
  const selected = options.find((option) => option.id === String(selectedOptionId || "").trim());
  if (!selected) {
    throw httpError(400, "Mode de livraison introuvable ou non disponible pour cette adresse.");
  }
  return selected;
}

export async function createShipmentForOrder(order) {
  if (!isSendcloudEnabled()) {
    return {
      enabled: false,
      status: "disabled",
      message: "Sendcloud n'est pas configure."
    };
  }

  if (!order?.shipping?.selectedOption?.id) {
    return {
      enabled: true,
      status: "skipped",
      message: "Aucun mode de livraison selectionne."
    };
  }

  const selectedOption = order.shipping.selectedOption;
  const shippingMethod = await resolveLiveShippingMethod(selectedOption, order);
  const createdParcel = await createParcel(order, shippingMethod);

  return {
    enabled: true,
    status: "label_created",
    provider: "sendcloud",
    optionId: selectedOption.id,
    optionLabel: selectedOption.label,
    carrier: shippingMethod.carrier || selectedOption.carrier || "",
    shippingMethodId: shippingMethod.id || null,
    shippingMethodName: shippingMethod.name || "",
    parcelId: createdParcel.id || null,
    trackingNumber: createdParcel.tracking_number || "",
    trackingUrl: createdParcel.tracking_url || "",
    sendcloudTrackingUrl: createdParcel.tracking_url || "",
    label: createdParcel.label || null,
    statusMessage: createdParcel.status?.message || "Ready to send",
    statusCode: createdParcel.status?.id || null,
    estimatedDeliveryDate: createdParcel.expected_delivery_date || null,
    rawParcel: createdParcel
  };
}

export function applyShipmentTrackingUpdate(order, webhookPayload) {
  const parcel = webhookPayload?.parcel;
  if (!parcel) {
    throw httpError(400, "Payload Sendcloud invalide.");
  }

  return {
    ...order,
    shipping: {
      ...order.shipping,
      shipment: {
        ...(order.shipping?.shipment || {}),
        enabled: true,
        provider: "sendcloud",
        parcelId: parcel.id || order.shipping?.shipment?.parcelId || null,
        trackingNumber: parcel.tracking_number || order.shipping?.shipment?.trackingNumber || "",
        trackingUrl: parcel.tracking_url || order.shipping?.shipment?.trackingUrl || "",
        sendcloudTrackingUrl: parcel.tracking_url || order.shipping?.shipment?.sendcloudTrackingUrl || "",
        statusMessage: parcel.status?.message || order.shipping?.shipment?.statusMessage || "",
        statusCode: parcel.status?.id || order.shipping?.shipment?.statusCode || null,
        estimatedDeliveryDate: parcel.expected_delivery_date || order.shipping?.shipment?.estimatedDeliveryDate || null,
        rawParcel: parcel
      }
    }
  };
}

async function resolveLiveShippingMethod(selectedOption, order) {
  const methods = await fetchShippingMethods({
    country: order.shipping?.country || config.shipping.defaultCountry,
    servicePointId: order.shipping?.selectedServicePoint?.servicePointId || ""
  });

  const matched = methods.find((method) => shippingMethodMatchesOption(method, selectedOption));
  if (!matched) {
    throw httpError(
      502,
      `Aucune methode Sendcloud n'a ete trouvee pour l'option ${selectedOption.label}.`
    );
  }
  return matched;
}

async function fetchShippingMethods({ country, servicePointId = "" }) {
  const normalizedCountry = normalizeCountryCode(country || config.shipping.defaultCountry);
  const normalizedServicePointId = clean(servicePointId);
  const cacheKey = normalizedServicePointId
    ? `service-point:${normalizedServicePointId}`
    : `country:${normalizedCountry}`;

  if (shippingMethodsCache.has(cacheKey)) {
    return shippingMethodsCache.get(cacheKey);
  }

  const query = new URLSearchParams();
  if (normalizedServicePointId) {
    query.set("service_point_id", normalizedServicePointId);
  } else if (normalizedCountry) {
    query.set("to_country", normalizedCountry);
  }
  const senderAddress = clean(config.sendcloud.senderAddressId);
  if (senderAddress) query.set("sender_address", senderAddress);

  const response = await sendcloudRequest(`/shipping_methods${query.size ? `?${query}` : ""}`, {
    method: "GET"
  });

  const methods = Array.isArray(response?.shipping_methods) ? response.shipping_methods : [];
  shippingMethodsCache.set(cacheKey, methods);
  return methods;
}

async function createParcel(order, shippingMethod) {
  const selectedServicePoint = normalizeOrderServicePoint(order.shipping?.selectedServicePoint);
  const destinationAddress = selectedServicePoint
    ? {
        address: [selectedServicePoint.street, selectedServicePoint.houseNumber].filter(Boolean).join(" ").trim(),
        city: selectedServicePoint.city,
        postalCode: selectedServicePoint.postalCode,
        country: selectedServicePoint.country || order.shipping?.country || config.shipping.defaultCountry,
        companyName: selectedServicePoint.name
      }
    : {
        address: order.customer.addressLine1,
        city: order.customer.city,
        postalCode: order.customer.postalCode,
        country: order.shipping?.country || config.shipping.defaultCountry,
        companyName: ""
      };

  const parcelPayload = {
    parcel: {
      name: `${order.customer.firstName} ${order.customer.lastName}`.trim(),
      company_name: destinationAddress.companyName,
      address: destinationAddress.address,
      city: destinationAddress.city,
      postal_code: destinationAddress.postalCode,
      country: destinationAddress.country,
      email: order.customer.email,
      telephone: order.customer.phone,
      order_number: order.orderNumber,
      external_reference: order.orderNumber,
      shipping_method: shippingMethod.id,
      weight: Number((order.shipping?.package?.weightKg || config.shipping.defaultWeightKg).toFixed(3)),
      length: Math.round(order.shipping?.package?.lengthCm || config.shipping.defaultLengthCm),
      width: Math.round(order.shipping?.package?.widthCm || config.shipping.defaultWidthCm),
      height: Math.round(order.shipping?.package?.heightCm || config.shipping.defaultHeightCm),
      request_label: true,
      quantity: order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) || 1,
      parcel_items: order.items.map((item) => ({
        description: item.name,
        quantity: item.quantity,
        value: Number(item.unitAmount || 0),
        weight: Number((((order.shipping?.package?.weightKg || config.shipping.defaultWeightKg) / Math.max(order.items.length, 1))).toFixed(3)),
        sku: item.id,
        hs_code: "",
        origin_country: "FR"
      }))
    }
  };

  if (clean(config.sendcloud.senderAddressId)) {
    parcelPayload.parcel.sender_address = Number.parseInt(config.sendcloud.senderAddressId, 10);
  }

  if (selectedServicePoint) {
    parcelPayload.parcel.to_service_point = selectedServicePoint.servicePointId;
    if (selectedServicePoint.postNumber) {
      parcelPayload.parcel.to_post_number = selectedServicePoint.postNumber;
    }
  }

  const response = await sendcloudRequest("/parcels", {
    method: "POST",
    body: parcelPayload
  });

  const parcel = response?.parcel;
  if (!parcel) {
    throw httpError(502, "Sendcloud n'a pas retourne de colis.", response);
  }

  return parcel;
}

async function sendcloudRequest(path, { method = "GET", body } = {}) {
  const authorization = Buffer.from(`${config.sendcloud.publicKey}:${config.sendcloud.secretKey}`).toString("base64");
  const response = await fetch(`${SENDCLOUD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/json",
      "User-Agent": "friperie-dev-backend/1.0"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw httpError(502, "Sendcloud a refuse la requete.", payload);
  }

  return payload;
}

function normalizeShippingOptionsConfig() {
  const configured = Array.isArray(config.sendcloud.shippingOptions)
    ? config.sendcloud.shippingOptions
    : [];

  return configured.map((entry, index) => ({
    id: clean(entry?.id) || `shipping-option-${index + 1}`,
    label: clean(entry?.label) || "Livraison",
    type: clean(entry?.type).toLowerCase() === "service_point" ? "service_point" : "home",
    carrier: clean(entry?.carrier),
    description: clean(entry?.description),
    price: parseNumber(entry?.price, 0),
    freeAboveOrderAmount: entry?.freeAboveOrderAmount == null || clean(entry?.freeAboveOrderAmount) === ""
      ? null
      : parseNumber(entry?.freeAboveOrderAmount, null),
    estimatedDaysMin: parseInteger(entry?.estimatedDaysMin, null),
    estimatedDaysMax: parseInteger(entry?.estimatedDaysMax, null),
    country: normalizeCountryCode(entry?.country || config.shipping.defaultCountry),
    pickerCarriers: normalizePickerCarriers(entry?.pickerCarriers ?? entry?.pickerCarrierCodes),
    matcher: {
      carrier: clean(entry?.matcher?.carrier).toLowerCase(),
      nameIncludes: clean(entry?.matcher?.nameIncludes).toLowerCase()
    }
  }));
}

function buildCheckoutShippingOption(option, orderAmount, items) {
  const qualifiesForFreeShipping = option.freeAboveOrderAmount != null && orderAmount >= option.freeAboveOrderAmount;
  const shippingAmount = qualifiesForFreeShipping ? 0 : option.price;
  const totalItems = Array.isArray(items) ? items.reduce((sum, item) => sum + Math.max(Number(item?.quantity || 1), 1), 0) : 0;

  return {
    ...option,
    originalPrice: option.price,
    estimatedLabel: buildEstimatedLabel(option.estimatedDaysMin, option.estimatedDaysMax),
    shippingAmount,
    qualifiesForFreeShipping,
    requiresServicePoint: option.type === "service_point",
    package: {
      itemsCount: totalItems,
      weightKg: Number((config.shipping.defaultWeightKg * Math.max(totalItems || 1, 1)).toFixed(3))
    }
  };
}

function shippingMethodMatchesOption(method, option) {
  const carrierName = clean(method?.carrier || method?.carrier_name).toLowerCase();
  const methodName = clean(method?.name).toLowerCase();
  const matcherCarrier = clean(option?.matcher?.carrier).toLowerCase();
  const matcherName = clean(option?.matcher?.nameIncludes).toLowerCase();

  if (matcherCarrier && !carrierName.includes(matcherCarrier)) {
    return false;
  }

  if (matcherName && !methodName.includes(matcherName)) {
    return false;
  }

  return true;
}

function buildEstimatedLabel(minDays, maxDays) {
  if (minDays && maxDays) {
    return minDays === maxDays
      ? `${minDays} jour${minDays > 1 ? "s" : ""} ouvre${minDays > 1 ? "s" : ""}`
      : `${minDays} a ${maxDays} jours ouvres`;
  }

  if (minDays) {
    return `${minDays} jour${minDays > 1 ? "s" : ""} ouvre${minDays > 1 ? "s" : ""}`;
  }

  return "";
}

function normalizeCountryCode(value) {
  return clean(value).toUpperCase() || "FR";
}

function parseNumber(value, fallback) {
  const amount = Number.parseFloat(clean(value).replace(",", "."));
  return Number.isFinite(amount) ? amount : fallback;
}

function parseInteger(value, fallback) {
  const amount = Number.parseInt(clean(value), 10);
  return Number.isFinite(amount) ? amount : fallback;
}

function normalizePickerCarriers(value) {
  const carriers = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

  return carriers
    .map((entry) => clean(entry).toLowerCase())
    .filter(Boolean);
}

function normalizeOrderServicePoint(value) {
  const servicePointId = Number.parseInt(clean(value?.servicePointId ?? value?.service_point_id ?? value?.id), 10);
  if (!Number.isFinite(servicePointId) || servicePointId <= 0) {
    return null;
  }

  return {
    servicePointId,
    postNumber: clean(value?.postNumber ?? value?.post_number),
    carrier: clean(value?.carrier),
    name: clean(value?.name),
    street: clean(value?.street),
    houseNumber: clean(value?.houseNumber ?? value?.house_number),
    postalCode: clean(value?.postalCode ?? value?.postal_code),
    city: clean(value?.city),
    country: normalizeCountryCode(value?.country || config.shipping.defaultCountry)
  };
}

function clean(value) {
  return String(value || "").trim();
}
