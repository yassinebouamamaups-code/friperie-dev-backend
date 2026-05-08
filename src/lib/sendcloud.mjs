import { Buffer } from "node:buffer";
import { config } from "../config.mjs";
import { httpError } from "./http.mjs";

const SENDCLOUD_API_V2_BASE = "https://panel.sendcloud.sc/api/v2";
const SENDCLOUD_API_V3_BASE = "https://panel.sendcloud.sc/api/v3";
const shippingMethodsCache = new Map();
let senderAddressCache = null;

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
  console.log("[sendcloud] shipping method selected", {
    orderNumber: order.orderNumber,
    selectedOptionId: selectedOption.id,
    selectedOptionLabel: selectedOption.label,
    selectedServicePoint: summarizeServicePoint(order.shipping?.selectedServicePoint),
    shippingMethod: summarizeShippingMethod(shippingMethod)
  });
  const createdShipment = await createShipment(order, shippingMethod);
  const firstParcel = firstShipmentParcel(createdShipment);
  const labelLink = findShipmentLabelLink(createdShipment, firstParcel);

  return {
    enabled: true,
    status: "label_created",
    provider: "sendcloud",
    optionId: selectedOption.id,
    optionLabel: selectedOption.label,
    carrier: shippingMethod.carrier || selectedOption.carrier || "",
    shippingMethodId: shippingMethod.id || null,
    shippingOptionCode: clean(
      shippingMethod.shipping_option_code
      || shippingMethod.code
      || shippingMethod.shipping_product_code
    ),
    shipmentId: clean(createdShipment?.id) || null,
    shippingMethodName: shippingMethod.name || "",
    parcelId: firstParcel?.id || null,
    trackingNumber: firstParcel?.tracking_number || "",
    trackingUrl: firstParcel?.tracking_url || "",
    sendcloudTrackingUrl: firstParcel?.tracking_url || "",
    label: labelLink
      ? {
          normal_printer: labelLink,
          printer: labelLink,
          label_printer: labelLink
        }
      : null,
    statusMessage: firstParcel?.status?.message || "Ready to send",
    statusCode: firstParcel?.status?.code || "",
    estimatedDeliveryDate: firstParcel?.expected_delivery_date || null,
    rawShipment: createdShipment,
    rawParcel: firstParcel || null
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

export async function fetchShipmentLabelAsset(shipment, orderNumber = "") {
  const labelLink = extractShipmentLabelLink(shipment);
  if (!labelLink) {
    throw httpError(404, "Etiquette Sendcloud introuvable.");
  }

  const authorization = Buffer.from(`${config.sendcloud.publicKey}:${config.sendcloud.secretKey}`).toString("base64");
  const response = await fetch(labelLink, {
    method: "GET",
    headers: {
      Authorization: `Basic ${authorization}`,
      Accept: "application/pdf",
      "User-Agent": "friperie-dev-backend/1.0"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw httpError(502, "Impossible de telecharger l'etiquette Sendcloud.", {
      status: response.status,
      body
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = clean(response.headers.get("content-type")) || "application/pdf";
  const fileName = `${clean(orderNumber) || "shipment-label"}.pdf`;

  return {
    buffer,
    contentType,
    fileName
  };
}

async function resolveLiveShippingMethod(selectedOption, order) {
  const methods = await fetchShippingMethods({
    country: order.shipping?.country || config.shipping.defaultCountry,
    servicePointId: order.shipping?.selectedServicePoint?.servicePointId || ""
  });

  console.log("[sendcloud] shipping methods received", {
    orderNumber: order.orderNumber,
    selectedOptionId: selectedOption?.id,
    selectedServicePoint: summarizeServicePoint(order.shipping?.selectedServicePoint),
    preferredKeyword: preferredShippingMethodKeyword(selectedOption, order),
    methods: methods.map((method) => summarizeShippingMethod(method))
  });

  const matched = chooseBestShippingMethod(methods, selectedOption, order);
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

  const response = await sendcloudRequestV2(`/shipping_methods${query.size ? `?${query}` : ""}`, {
    method: "GET"
  });

  const methods = Array.isArray(response?.shipping_methods) ? response.shipping_methods : [];
  shippingMethodsCache.set(cacheKey, methods);
  return methods;
}

async function createShipment(order, shippingMethod) {
  const selectedServicePoint = normalizeOrderServicePoint(order.shipping?.selectedServicePoint);
  const shippingOptionCode = clean(
    await resolveShippingOptionCode(shippingMethod)
    || shippingMethod?.shipping_option_code
    || shippingMethod?.code
    || shippingMethod?.shipping_product_code
  );

  if (!shippingOptionCode) {
    throw httpError(
      502,
      `La methode Sendcloud ${clean(shippingMethod?.name) || clean(shippingMethod?.id)} ne fournit pas de shipping_option_code compatible avec l'API v3.`,
      shippingMethod
    );
  }

  console.log("[sendcloud] shipment announce inputs", {
    orderNumber: order.orderNumber,
    selectedOptionId: order.shipping?.selectedOption?.id || "",
    selectedServicePoint: summarizeServicePoint(selectedServicePoint),
    shippingMethod: summarizeShippingMethod(shippingMethod),
    shippingOptionCode
  });

  const shipmentPayload = {
    order_number: order.orderNumber,
    external_reference_id: order.orderNumber,
    reference: order.invoiceNumber,
    total_order_price: {
      currency: "EUR",
      value: order.totalAmount.toFixed(2)
    },
    ship_with: {
      type: "shipping_option_code",
      properties: {
        shipping_option_code: shippingOptionCode
      }
    },
    to_address: buildV3RecipientAddress(order.customer),
    parcels: [
      {
        quantity: order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) || 1,
        dimensions: {
          length: toDimensionValue(order.shipping?.package?.lengthCm || config.shipping.defaultLengthCm),
          width: toDimensionValue(order.shipping?.package?.widthCm || config.shipping.defaultWidthCm),
          height: toDimensionValue(order.shipping?.package?.heightCm || config.shipping.defaultHeightCm),
          unit: "cm"
        },
        weight: {
          value: toWeightValue(order.shipping?.package?.weightKg || config.shipping.defaultWeightKg),
          unit: "kg"
        },
        parcel_items: order.items.map((item) => ({
          item_id: clean(item.id) || undefined,
          description: item.name,
          quantity: item.quantity,
          sku: clean(item.id) || undefined,
          origin_country: "FR",
          weight: {
            value: toWeightValue((order.shipping?.package?.weightKg || config.shipping.defaultWeightKg) / Math.max(order.items.length, 1)),
            unit: "kg"
          },
          price: {
            value: Number(item.unitAmount || 0).toFixed(2),
            currency: "EUR"
          }
        }))
      }
    ],
    label_details: {
      mime_type: "application/pdf",
      dpi: 72
    }
  };

  const senderAddress = await buildV3SenderAddress();
  if (senderAddress) {
    shipmentPayload.from_address = senderAddress;
  }

  if (selectedServicePoint) {
    shipmentPayload.to_service_point = {
      id: selectedServicePoint.servicePointId
    };

    if (selectedServicePoint.postNumber) {
      shipmentPayload.to_service_point.carrier_service_point_id = selectedServicePoint.postNumber;
    }
  }

  const response = await sendcloudRequestV3("/shipments/announce", {
    method: "POST",
    body: shipmentPayload
  });

  const shipment = response?.data;
  if (!shipment) {
    throw httpError(502, "Sendcloud n'a pas retourne d'envoi.", response);
  }

  return shipment;
}

async function resolveShippingOptionCode(shippingMethod) {
  const shippingMethodId = Number.parseInt(clean(shippingMethod?.id), 10);
  if (!Number.isFinite(shippingMethodId) || shippingMethodId <= 0) {
    return "";
  }

  const response = await sendcloudRequestV3("/compat/shipping-options", {
    method: "POST",
    body: {
      shipping_method_ids: [shippingMethodId]
    }
  });

  const mappedValue = response?.data?.[String(shippingMethodId)];
  return clean(mappedValue === "null" ? "" : mappedValue);
}

async function sendcloudRequestV2(path, { method = "GET", body } = {}) {
  return sendcloudRequest(`${SENDCLOUD_API_V2_BASE}${path}`, { method, body });
}

async function sendcloudRequestV3(path, { method = "GET", body } = {}) {
  return sendcloudRequest(`${SENDCLOUD_API_V3_BASE}${path}`, { method, body });
}

async function sendcloudRequest(url, { method = "GET", body } = {}) {
  const authorization = Buffer.from(`${config.sendcloud.publicKey}:${config.sendcloud.secretKey}`).toString("base64");
  const response = await fetch(url, {
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

async function buildV3SenderAddress() {
  const senderAddressId = await resolveSenderAddressId();
  if (!senderAddressId) {
    return null;
  }

  return {
    sender_address_id: senderAddressId
  };
}

async function resolveSenderAddressId() {
  if (Number.isInteger(senderAddressCache) && senderAddressCache > 0) {
    return senderAddressCache;
  }

  const configured = Number.parseInt(clean(config.sendcloud.senderAddressId), 10);
  if (Number.isInteger(configured) && configured > 0) {
    senderAddressCache = configured;
    return configured;
  }

  const response = await sendcloudRequestV2("/user/addresses/sender", {
    method: "GET"
  });

  const addresses = Array.isArray(response?.sender_addresses) ? response.sender_addresses : [];
  const defaultAddress = addresses.find((address) => Boolean(address?.default));
  const firstAddress = defaultAddress || addresses[0];
  const resolvedId = Number.parseInt(clean(firstAddress?.id), 10);

  if (Number.isInteger(resolvedId) && resolvedId > 0) {
    senderAddressCache = resolvedId;
    return resolvedId;
  }

  return null;
}

function buildV3RecipientAddress(customer) {
  const { street, houseNumber } = splitStreetAndHouseNumber(customer.addressLine1);

  return {
    name: `${customer.firstName} ${customer.lastName}`.trim(),
    company_name: "",
    address_line_1: street,
    house_number: houseNumber,
    postal_code: customer.postalCode,
    city: customer.city,
    country_code: normalizeCountryCode(customer.country || config.shipping.defaultCountry),
    phone_number: customer.phone,
    email: customer.email
  };
}

function splitStreetAndHouseNumber(value) {
  const address = clean(value);
  const match = address.match(/^(\d+[^\s,/-]*)\s+(.*)$/);
  if (!match) {
    return {
      street: address,
      houseNumber: ""
    };
  }

  return {
    houseNumber: clean(match[1]),
    street: clean(match[2])
  };
}

function toDimensionValue(value) {
  const parsed = parseNumber(value, 0);
  return parsed > 0 ? parsed.toFixed(2) : "0.00";
}

function toWeightValue(value) {
  const parsed = parseNumber(value, 0);
  return parsed > 0 ? parsed.toFixed(3) : "0.000";
}

function firstShipmentParcel(shipment) {
  return Array.isArray(shipment?.parcels) ? shipment.parcels[0] || null : null;
}

function findShipmentLabelLink(shipment, parcel) {
  const parcelLabel = Array.isArray(parcel?.documents)
    ? parcel.documents.find((document) => clean(document?.type).toLowerCase() === "label")
    : null;

  return cleanRemoteLink(parcelLabel?.link)
    || cleanRemoteLink(shipment?.label?.normal_printer)
    || cleanRemoteLink(shipment?.label?.printer)
    || cleanRemoteLink(parcel?.label?.normal_printer)
    || cleanRemoteLink(parcel?.label?.printer);
}

function extractShipmentLabelLink(shipment) {
  return cleanRemoteLink(
    shipment?.label?.normal_printer
    || shipment?.label?.printer
    || shipment?.label?.label_printer
    || shipment?.rawParcel?.label?.normal_printer
    || shipment?.rawParcel?.label?.printer
    || shipment?.rawParcel?.label?.label_printer
    || shipment?.rawParcel?.label
    || shipment?.rawParcel?.documents?.find?.((document) => clean(document?.type).toLowerCase() === "label")?.link
    || findShipmentLabelLink(shipment?.rawShipment, shipment?.rawParcel)
  );
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

function chooseBestShippingMethod(methods, option, order) {
  const matchingMethods = methods.filter((method) => shippingMethodMatchesOption(method, option));
  if (!matchingMethods.length) {
    return null;
  }

  const rankedMethods = matchingMethods
    .map((method, index) => ({
      method,
      index,
      score: scoreShippingMethod(method, option, order)
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });

  return rankedMethods[0]?.method || matchingMethods[0];
}

function preferredShippingMethodKeyword(option, order) {
  const optionId = clean(option?.id).toLowerCase();
  const servicePoint = order?.shipping?.selectedServicePoint;
  const servicePointLabel = [
    clean(servicePoint?.name),
    clean(servicePoint?.carrier)
  ].join(" ").toLowerCase();

  if (optionId === "mondial-relay" && /\blocker\b/.test(servicePointLabel)) {
    return "locker";
  }

  return "";
}

function preferredShippingMethodKeywords(option, order) {
  const keywords = [];
  const explicitKeyword = preferredShippingMethodKeyword(option, order);
  if (explicitKeyword) {
    keywords.push(explicitKeyword);
  }

  const optionType = clean(option?.type).toLowerCase();
  if (optionType === "service_point") {
    keywords.push("relay", "relais", "pickup", "point");
  }

  if (optionType === "home") {
    keywords.push("domicile", "home");
  }

  return Array.from(new Set(keywords.filter(Boolean)));
}

function shippingMethodContainsKeyword(method, keyword) {
  const normalizedKeyword = clean(keyword).toLowerCase();
  if (!normalizedKeyword) {
    return false;
  }

  const haystack = [
    clean(method?.name),
    clean(method?.shipping_option_code),
    clean(method?.code),
    clean(method?.shipping_product_code)
  ].join(" ").toLowerCase();

  return haystack.includes(normalizedKeyword);
}

function isInternationalShippingMethod(method) {
  return shippingMethodContainsKeyword(method, "international");
}

function getOrderPackageWeightKg(order) {
  return parseNumber(
    order?.shipping?.package?.weightKg
    || order?.shipping?.selectedOption?.package?.weightKg
    || config.shipping.defaultWeightKg,
    0
  );
}

function shippingMethodSupportsWeight(method, targetWeightKg) {
  const minWeight = parseNumber(method?.min_weight, null);
  const maxWeight = parseNumber(method?.max_weight, null);

  if (!Number.isFinite(targetWeightKg) || targetWeightKg <= 0) {
    return true;
  }

  if (!Number.isFinite(minWeight) && !Number.isFinite(maxWeight)) {
    return true;
  }

  if (Number.isFinite(minWeight) && targetWeightKg < minWeight) {
    return false;
  }

  if (Number.isFinite(maxWeight) && targetWeightKg > maxWeight) {
    return false;
  }

  return true;
}

function scoreShippingMethod(method, option, order) {
  let score = 0;
  const normalizedCountry = normalizeCountryCode(order?.shipping?.country || config.shipping.defaultCountry);
  const packageWeightKg = getOrderPackageWeightKg(order);
  const optionType = clean(option?.type).toLowerCase();
  const servicePointInput = clean(method?.service_point_input).toLowerCase();

  if (normalizedCountry === "FR" && !isInternationalShippingMethod(method)) {
    score += 40;
  }

  if (packageWeightKg > 0 && shippingMethodSupportsWeight(method, packageWeightKg)) {
    score += 35;
  }

  if (optionType === "service_point" && servicePointInput === "required") {
    score += 25;
  }

  if (optionType === "home" && servicePointInput !== "required") {
    score += 25;
  }

  for (const keyword of preferredShippingMethodKeywords(option, order)) {
    if (shippingMethodContainsKeyword(method, keyword)) {
      score += 10;
    }
  }

  return score;
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

function summarizeShippingMethod(method) {
  return {
    id: clean(method?.id),
    name: clean(method?.name),
    carrier: clean(method?.carrier || method?.carrier_name),
    code: clean(method?.code),
    shipping_option_code: clean(method?.shipping_option_code),
    shipping_product_code: clean(method?.shipping_product_code)
  };
}

function summarizeServicePoint(servicePoint) {
  if (!servicePoint) {
    return null;
  }

  return {
    servicePointId: clean(servicePoint?.servicePointId ?? servicePoint?.id),
    postNumber: clean(servicePoint?.postNumber),
    carrier: clean(servicePoint?.carrier),
    name: clean(servicePoint?.name),
    postalCode: clean(servicePoint?.postalCode),
    city: clean(servicePoint?.city)
  };
}

function cleanRemoteLink(value) {
  const normalized = clean(value);
  if (!normalized) return "";
  if (["null", "undefined", "[object Object]"].includes(normalized.toLowerCase())) {
    return "";
  }
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}
