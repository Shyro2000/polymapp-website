export interface CompanyBillingDetails {
  invoiceCompanyName: string;
  recipientName: string;
  street: string;
  addressSupplement: string;
  postalCode: string;
  city: string;
  country: string;
  billingEmail: string;
  uidVat: string;
  customerReference: string;
  reviewedByOwnerUid: string;
}

export interface InvoiceIssuerSettings {
  businessName: string;
  contactName: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  email: string;
  bankName: string;
  iban: string;
  uidVat: string;
  paymentTermsDays: number;
}

export const PRICE_TIERS = new Map<number, number>([
  [10, 1.5],
  [20, 1.475],
  [30, 1.45],
  [50, 1.43],
  [75, 1.4],
  [100, 1.4],
  [150, 1.4],
  [200, 1.4],
  [300, 1.4],
  [500, 1.4],
]);

export const DEFAULT_ISSUER_SETTINGS: InvoiceIssuerSettings = {
  businessName: "PolymApp",
  contactName: "Fabian Schatzmann",
  street: "Solistr. 52",
  postalCode: "8180",
  city: "Bülach",
  country: "Schweiz",
  email: "info@polymapp.ch",
  bankName: "Zürcher Kantonalbank",
  iban: "CH47 0070 0110 0014 6863 6",
  uidVat: "",
  paymentTermsDays: 30,
};

/**
 * Converts a value to a trimmed string.
 * @param {unknown} value Raw value.
 * @param {string} fallback Fallback value.
 * @param {number} maxLength Maximum length.
 * @return {string} Normalized text.
 */
export function normalizeText(
  value: unknown,
  fallback = "",
  maxLength = 250,
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim().slice(0, maxLength);
}

/**
 * Normalizes company billing details.
 * @param {unknown} value Stored object.
 * @param {string} fallbackCompanyName Fallback company name.
 * @param {string} fallbackEmail Fallback billing email.
 * @return {CompanyBillingDetails} Normalized details.
 */
export function normalizeCompanyBillingDetails(
  value: unknown,
  fallbackCompanyName = "",
  fallbackEmail = "",
): CompanyBillingDetails {
  const data =
    value && typeof value === "object" ?
      value as Record<string, unknown> :
      {};

  return {
    invoiceCompanyName: normalizeText(
      data.invoiceCompanyName,
      fallbackCompanyName,
      120,
    ),
    recipientName: normalizeText(
      data.recipientName,
      "",
      120,
    ),
    street: normalizeText(data.street, "", 160),
    addressSupplement: normalizeText(
      data.addressSupplement,
      "",
      160,
    ),
    postalCode: normalizeText(data.postalCode, "", 30),
    city: normalizeText(data.city, "", 100),
    country: normalizeText(data.country, "", 100),
    billingEmail: normalizeText(
      data.billingEmail,
      fallbackEmail,
      254,
    ).toLowerCase(),
    uidVat: normalizeText(data.uidVat, "", 80),
    customerReference: normalizeText(
      data.customerReference,
      "",
      120,
    ),
    reviewedByOwnerUid: normalizeText(
      data.reviewedByOwnerUid,
      "",
      200,
    ),
  };
}

/**
 * Normalizes invoice issuer settings.
 * @param {unknown} value Stored object.
 * @return {InvoiceIssuerSettings} Normalized settings.
 */
export function normalizeIssuerSettings(
  value: unknown,
): InvoiceIssuerSettings {
  const data =
    value && typeof value === "object" ?
      value as Record<string, unknown> :
      {};

  const rawTerms = data.paymentTermsDays;
  const paymentTermsDays =
    typeof rawTerms === "number" &&
    Number.isFinite(rawTerms) ?
      Math.min(90, Math.max(1, Math.round(rawTerms))) :
      DEFAULT_ISSUER_SETTINGS.paymentTermsDays;

  return {
    businessName: normalizeText(
      data.businessName,
      DEFAULT_ISSUER_SETTINGS.businessName,
      120,
    ),
    contactName: normalizeText(
      data.contactName,
      DEFAULT_ISSUER_SETTINGS.contactName,
      120,
    ),
    street: normalizeText(
      data.street,
      DEFAULT_ISSUER_SETTINGS.street,
      160,
    ),
    postalCode: normalizeText(
      data.postalCode,
      DEFAULT_ISSUER_SETTINGS.postalCode,
      30,
    ),
    city: normalizeText(
      data.city,
      DEFAULT_ISSUER_SETTINGS.city,
      100,
    ),
    country: normalizeText(
      data.country,
      DEFAULT_ISSUER_SETTINGS.country,
      100,
    ),
    email: normalizeText(
      data.email,
      DEFAULT_ISSUER_SETTINGS.email,
      254,
    ).toLowerCase(),
    bankName: normalizeText(
      data.bankName,
      DEFAULT_ISSUER_SETTINGS.bankName,
      160,
    ),
    iban: normalizeText(
      data.iban,
      DEFAULT_ISSUER_SETTINGS.iban,
      80,
    ),
    uidVat: normalizeText(data.uidVat, "", 80),
    paymentTermsDays,
  };
}
