import {Timestamp} from "firebase-admin/firestore";
import {
  CompanyBillingDetails,
  InvoiceIssuerSettings,
  normalizeCompanyBillingDetails,
  normalizeIssuerSettings,
  normalizeText,
} from "./billingConfig";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

interface InvoicePdfResult {
  base64: string;
  filename: string;
  mimeType: string;
}

/**
 * Converts unknown Firestore date values to Date objects.
 * @param {unknown} value Raw date value.
 * @return {Date | null} Converted date.
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  if (value instanceof Date) {
    return value;
  }

  return null;
}

/**
 * Formats a date for Swiss German invoices.
 * @param {unknown} value Raw date value.
 * @return {string} Formatted date.
 */
function formatDate(value: unknown): string {
  const date = toDate(value);

  if (!date) {
    return "-";
  }

  return new Intl.DateTimeFormat("de-CH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Zurich",
  }).format(date);
}

/**
 * Formats an ISO calendar date without timezone conversion.
 * @param {unknown} value Raw ISO date.
 * @return {string} Formatted date.
 */
function formatIsoDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return "-";
  }

  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

/**
 * Formats a CHF amount.
 * @param {unknown} value Raw amount.
 * @return {string} Formatted amount.
 */
function formatCurrency(value: unknown): string {
  const amount =
    typeof value === "number" &&
    Number.isFinite(value) ?
      value :
      0;

  return `CHF ${amount.toFixed(2)}`;
}

/**
 * Converts text to a safe WinAnsi-like character set.
 * @param {string} value Input text.
 * @return {string} PDF-safe text.
 */
function normalizePdfText(value: string): string {
  return Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) || 0;

      if (code <= 255) {
        return character;
      }

      switch (character) {
      case "–":
      case "—":
        return "-";
      case "’":
      case "‘":
        return "'";
      case "“":
      case "”":
        return "\"";
      default:
        return "?";
      }
    })
    .join("");
}

/**
 * Escapes a literal PDF text string.
 * @param {string} value Input text.
 * @return {string} Escaped PDF string.
 */
function pdfString(value: string): string {
  return normalizePdfText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r?\n/g, " ");
}

/**
 * Creates a PDF text command.
 * @param {string} font Font resource name.
 * @param {number} size Font size.
 * @param {number} x X position.
 * @param {number} top Top position from page top.
 * @param {string} value Text.
 * @return {string} PDF content command.
 */
function textCommand(
  font: string,
  size: number,
  x: number,
  top: number,
  value: string,
): string {
  const y = PAGE_HEIGHT - top;

  return [
    "BT",
    `/${font} ${size} Tf`,
    `${x.toFixed(2)} ${y.toFixed(2)} Td`,
    `(${pdfString(value)}) Tj`,
    "ET",
  ].join("\n");
}

/**
 * Creates a horizontal line command.
 * @param {number} x1 Start x.
 * @param {number} x2 End x.
 * @param {number} top Top position.
 * @return {string} PDF line command.
 */
function lineCommand(
  x1: number,
  x2: number,
  top: number,
): string {
  const y = PAGE_HEIGHT - top;
  return `${x1} ${y} m ${x2} ${y} l S`;
}

/**
 * Wraps text to a basic fixed width.
 * @param {string} value Text to wrap.
 * @param {number} maxCharacters Approximate characters per line.
 * @return {string[]} Wrapped lines.
 */
function wrapText(
  value: string,
  maxCharacters: number,
): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (
      candidate.length > maxCharacters &&
      current
    ) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * Reads a billing snapshot from invoice data.
 * @param {unknown} value Raw snapshot.
 * @return {CompanyBillingDetails} Normalized billing details.
 */
function customerSnapshot(
  value: unknown,
): CompanyBillingDetails {
  return normalizeCompanyBillingDetails(value);
}

/**
 * Reads an issuer snapshot from invoice data.
 * @param {unknown} value Raw snapshot.
 * @return {InvoiceIssuerSettings} Normalized issuer settings.
 */
function issuerSnapshot(
  value: unknown,
): InvoiceIssuerSettings {
  return normalizeIssuerSettings(value);
}

/**
 * Builds a one-page PDF from invoice data.
 * @param {string} invoiceId Firestore invoice id.
 * @param {Record<string, unknown>} data Invoice document data.
 * @return {InvoicePdfResult} Encoded PDF and filename.
 */
export function buildInvoicePdf(
  invoiceId: string,
  data: Record<string, unknown>,
): InvoicePdfResult {
  const issuer = issuerSnapshot(data.issuerSnapshot);
  const customer = customerSnapshot(
    data.customerBillingSnapshot,
  );

  const invoiceNumber = normalizeText(
    data.invoiceNumber,
    invoiceId,
    100,
  );
  const companyName = normalizeText(
    data.companyName,
    customer.invoiceCompanyName,
    120,
  );
  const currency = normalizeText(
    data.currency,
    "CHF",
    20,
  );
  const seatLimit =
    typeof data.seatLimit === "number" ?
      data.seatLimit :
      0;
  const monthlyRate =
    typeof data.monthlyRate === "number" ?
      data.monthlyRate :
      0;
  const annualAmount =
    typeof data.annualAmount === "number" ?
      data.annualAmount :
      0;
  const reference = normalizeText(
    data.reference,
    customer.customerReference,
    120,
  );
  const activationOnPayment =
    data.activationOnPayment === true;

  const commands: string[] = [
    "0 G",
    "0.7 w",
    textCommand("F2", 18, 48, 58, issuer.businessName || "PolymApp"),
  ];

  let senderTop = 78;
  for (const line of [
    issuer.contactName,
    issuer.street,
    [issuer.postalCode, issuer.city].filter(Boolean).join(" "),
    issuer.country,
    issuer.email,
  ].filter(Boolean)) {
    commands.push(
      textCommand("F1", 9, 48, senderTop, line),
    );
    senderTop += 13;
  }

  commands.push(
    textCommand("F2", 26, 390, 62, "RECHNUNG"),
    textCommand("F1", 9, 390, 88, `Nr. ${invoiceNumber}`),
    textCommand(
      "F1",
      9,
      390,
      103,
      `Datum: ${formatDate(data.createdAt)}`,
    ),
    textCommand(
      "F1",
      9,
      390,
      118,
      `Fällig: ${formatIsoDate(data.dueDate)}`,
    ),
  );

  commands.push(
    textCommand("F1", 8, 48, 164, "Rechnung an"),
  );

  let customerTop = 183;
  for (const line of [
    customer.invoiceCompanyName || companyName,
    customer.recipientName,
    customer.street,
    [customer.postalCode, customer.city]
      .filter(Boolean)
      .join(" "),
    customer.country,
  ].filter(Boolean)) {
    commands.push(
      textCommand("F1", 10, 48, customerTop, line),
    );
    customerTop += 15;
  }

  if (customer.billingEmail) {
    commands.push(
      textCommand(
        "F1",
        9,
        48,
        customerTop + 3,
        customer.billingEmail,
      ),
    );
  }

  commands.push(
    lineCommand(48, 547, 282),
    textCommand("F2", 9, 48, 304, "Beschreibung"),
    textCommand("F2", 9, 320, 304, "Berechnung"),
    textCommand("F2", 9, 472, 304, "Betrag"),
    lineCommand(48, 547, 314),
  );

  const description =
    `PolymApp Firmen-Jahresabo für bis zu ${seatLimit} Mitglieder`;
  const descriptionLines = wrapText(description, 50);

  let descriptionTop = 338;
  for (const line of descriptionLines) {
    commands.push(
      textCommand("F1", 10, 48, descriptionTop, line),
    );
    descriptionTop += 14;
  }

  const periodText = activationOnPayment ?
    "Leistungsdauer: 12 Monate ab Freischaltung nach Zahlungseingang" :
    `Leistungszeitraum: ${formatDate(data.periodStartAt)} bis ` +
      `${formatDate(data.periodEndAt)}`;

  commands.push(
    textCommand("F1", 8, 48, descriptionTop + 3, periodText),
    textCommand(
      "F1",
      9,
      320,
      338,
      `${seatLimit} x CHF ${monthlyRate.toFixed(3)} x 12`,
    ),
    textCommand(
      "F2",
      10,
      472,
      338,
      currency === "CHF" ?
        formatCurrency(annualAmount) :
        `${annualAmount.toFixed(2)} ${currency}`,
    ),
    lineCommand(48, 547, 392),
    textCommand("F2", 11, 410, 420, "Total"),
    textCommand(
      "F2",
      12,
      472,
      420,
      currency === "CHF" ?
        formatCurrency(annualAmount) :
        `${annualAmount.toFixed(2)} ${currency}`,
    ),
  );

  if (reference) {
    commands.push(
      textCommand(
        "F1",
        9,
        48,
        450,
        `Referenz: ${reference}`,
      ),
    );
  }

  if (customer.uidVat) {
    commands.push(
      textCommand(
        "F1",
        8,
        48,
        470,
        `Kunden-UID/MWST: ${customer.uidVat}`,
      ),
    );
  }

  commands.push(
    lineCommand(48, 547, 510),
    textCommand("F2", 10, 48, 535, "Zahlungsinformationen"),
  );

  let paymentTop = 555;
  for (const line of [
    issuer.bankName,
    issuer.iban ? `IBAN: ${issuer.iban}` : "",
    `Zahlungsfrist: ${issuer.paymentTermsDays} Tage`,
    `Bitte Rechnungsnummer ${invoiceNumber} als Zahlungsreferenz angeben.`,
  ].filter(Boolean)) {
    commands.push(
      textCommand("F1", 9, 48, paymentTop, line),
    );
    paymentTop += 15;
  }

  if (issuer.uidVat) {
    commands.push(
      textCommand(
        "F1",
        8,
        48,
        paymentTop + 5,
        `UID/MWST: ${issuer.uidVat}`,
      ),
    );
  }

  commands.push(
    textCommand(
      "F1",
      8,
      48,
      775,
      "Vielen Dank für Ihr Vertrauen in PolymApp.",
    ),
  );

  const content = commands.join("\n");
  const contentLength = Buffer.byteLength(
    content,
    "latin1",
  );

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    [
      "<< /Type /Page /Parent 2 0 R",
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]`,
      "/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >>",
      "/Contents 6 0 R >>",
    ].join(" "),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica " +
      "/Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold " +
      "/Encoding /WinAnsiEncoding >>",
    `<< /Length ${contentLength} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }

  pdf += [
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");

  const buffer = Buffer.from(pdf, "latin1");

  return {
    base64: buffer.toString("base64"),
    filename:
      `PolymApp-Rechnung-${invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "-")}.pdf`,
    mimeType: "application/pdf",
  };
}
