import {Timestamp} from "firebase-admin/firestore";
import qrcode = require("qrcode-generator");
import {
  CompanyBillingDetails,
  InvoiceIssuerSettings,
  normalizeCompanyBillingDetails,
  normalizeIssuerSettings,
  normalizeText,
} from "./billingConfig";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const POINTS_PER_MM = 72 / 25.4;
const SWISS_QR_SIZE = 46 * POINTS_PER_MM;
const SWISS_CROSS_SIZE = 7 * POINTS_PER_MM;

interface InvoicePdfResult {
  base64: string;
  filename: string;
  mimeType: string;
}

interface StructuredAddress {
  street: string;
  buildingNumber: string;
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
 * Formats a monthly rate without unnecessary trailing zeros.
 * @param {number} value Monthly rate.
 * @return {string} Compact decimal value.
 */
function formatRate(value: number): string {
  return value
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
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
 * Creates a filled rectangle command.
 * @param {number} x Left position.
 * @param {number} top Top position.
 * @param {number} width Width.
 * @param {number} height Height.
 * @return {string} PDF rectangle command.
 */
function filledRectCommand(
  x: number,
  top: number,
  width: number,
  height: number,
): string {
  const y = PAGE_HEIGHT - top - height;

  return [
    x.toFixed(3),
    y.toFixed(3),
    width.toFixed(3),
    height.toFixed(3),
    "re f",
  ].join(" ");
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
 * Splits a street field into street and building number.
 * @param {string} value Combined street and building number.
 * @return {StructuredAddress} Structured street details.
 */
function splitStreetAddress(
  value: string,
): StructuredAddress {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(.*\S)\s+(\d+[A-Za-z]?(?:[-/.]\d+[A-Za-z]?)?)$/,
  );

  if (!match) {
    return {
      street: trimmed,
      buildingNumber: "",
    };
  }

  return {
    street: match[1].trim(),
    buildingNumber: match[2].trim(),
  };
}

/**
 * Removes spaces from an IBAN.
 * @param {string} value IBAN value.
 * @return {string} Compact IBAN.
 */
function compactIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * Creates an ISO 11649 Creditor Reference.
 * @param {string} invoiceNumber Invoice identifier.
 * @return {string} RF Creditor Reference.
 */
function createScorReference(
  invoiceNumber: string,
): string {
  const base = invoiceNumber
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 21) || "POLYMAPP";

  const rearranged = `${base}RF00`;
  let remainder = 0;

  for (const character of rearranged) {
    const numeric =
      /[A-Z]/.test(character) ?
        String(character.charCodeAt(0) - 55) :
        character;

    for (const digit of numeric) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }

  const checkDigits = String(98 - remainder).padStart(2, "0");
  return `RF${checkDigits}${base}`;
}

/**
 * Returns a QR-safe single-line text value.
 * @param {string} value Source text.
 * @param {number} maxLength Maximum length.
 * @return {string} Sanitized text.
 */
function qrText(
  value: string,
  maxLength: number,
): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Returns the invoice customer's ISO country code.
 * @param {CompanyBillingDetails} customer Customer details.
 * @return {string} ISO alpha-2 country code.
 */
function customerCountryCode(
  customer: CompanyBillingDetails,
): string {
  if (/^[A-Z]{2}$/.test(customer.countryCode)) {
    return customer.countryCode;
  }

  const normalized = customer.country
    .trim()
    .toLocaleLowerCase("de-CH");

  if (
    [
      "schweiz",
      "suisse",
      "svizzera",
      "switzerland",
    ].includes(normalized)
  ) {
    return "CH";
  }

  return "";
}

/**
 * Builds the Swiss Payment Code payload.
 * @param {InvoiceIssuerSettings} issuer Creditor details.
 * @param {CompanyBillingDetails} customer Debtor details.
 * @param {string} invoiceNumber Invoice number.
 * @param {number} amount Invoice amount.
 * @return {{payload: string, scor: string}} QR payload.
 */
function buildSwissQrPayload(
  issuer: InvoiceIssuerSettings,
  customer: CompanyBillingDetails,
  invoiceNumber: string,
  amount: number,
): {
  payload: string;
  scor: string;
} {
  const creditorStreet = splitStreetAddress(issuer.street);
  const debtorStreet = splitStreetAddress(customer.street);
  const iban = compactIban(issuer.iban);
  const scor = createScorReference(invoiceNumber);
  const creditorName = qrText(
    issuer.contactName || issuer.businessName,
    70,
  );
  const debtorName = qrText(
    customer.invoiceCompanyName ||
      customer.recipientName,
    70,
  );

  const fields = [
    "SPC",
    "0200",
    "1",
    iban,
    "S",
    creditorName,
    qrText(creditorStreet.street, 70),
    qrText(creditorStreet.buildingNumber, 16),
    qrText(issuer.postalCode, 16),
    qrText(issuer.city, 35),
    "CH",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    amount.toFixed(2),
    "CHF",
    "S",
    debtorName,
    qrText(debtorStreet.street, 70),
    qrText(debtorStreet.buildingNumber, 16),
    qrText(customer.postalCode, 16),
    qrText(customer.city, 35),
    "CH",
    "SCOR",
    scor,
    qrText(`PolymApp Rechnung ${invoiceNumber}`, 140),
    "EPD",
    "",
  ];

  return {
    payload: fields.join("\n"),
    scor,
  };
}

/**
 * Builds vector commands for a Swiss QR Code.
 * @param {string} payload Swiss Payment Code payload.
 * @param {number} x Left position.
 * @param {number} top Top position.
 * @return {string[]} PDF drawing commands.
 */
function swissQrCommands(
  payload: string,
  x: number,
  top: number,
): string[] {
  const qr = qrcode(0, "M");
  qr.addData(payload, "Byte");
  qr.make();

  const count = qr.getModuleCount();
  const moduleSize = SWISS_QR_SIZE / count;
  const commands: string[] = [
    "0 g",
  ];

  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!qr.isDark(row, column)) {
        continue;
      }

      commands.push(
        filledRectCommand(
          x + column * moduleSize,
          top + row * moduleSize,
          moduleSize + 0.02,
          moduleSize + 0.02,
        ),
      );
    }
  }

  const crossLeft =
    x + (SWISS_QR_SIZE - SWISS_CROSS_SIZE) / 2;
  const crossTop =
    top + (SWISS_QR_SIZE - SWISS_CROSS_SIZE) / 2;
  const bar = SWISS_CROSS_SIZE * 0.2;
  const arm = SWISS_CROSS_SIZE * 0.64;

  commands.push(
    "0 g",
    filledRectCommand(
      crossLeft,
      crossTop,
      SWISS_CROSS_SIZE,
      SWISS_CROSS_SIZE,
    ),
    "1 g",
    filledRectCommand(
      crossLeft + (SWISS_CROSS_SIZE - arm) / 2,
      crossTop + (SWISS_CROSS_SIZE - bar) / 2,
      arm,
      bar,
    ),
    filledRectCommand(
      crossLeft + (SWISS_CROSS_SIZE - bar) / 2,
      crossTop + (SWISS_CROSS_SIZE - arm) / 2,
      bar,
      arm,
    ),
    "0 g",
  );

  return commands;
}

/**
 * Builds the ordinary invoice page.
 * @param {InvoiceIssuerSettings} issuer Issuer details.
 * @param {CompanyBillingDetails} customer Customer details.
 * @param {Record<string, unknown>} data Invoice data.
 * @param {string} invoiceNumber Invoice number.
 * @param {string} companyName Company name.
 * @param {string} currency Invoice currency.
 * @param {number} seatLimit Seat limit.
 * @param {number} monthlyRate Monthly rate.
 * @param {number} annualAmount Annual amount.
 * @param {string} reference Invoice reference.
 * @param {boolean} activationOnPayment Activation mode.
 * @return {string} PDF page content.
 */
function buildInvoicePage(
  issuer: InvoiceIssuerSettings,
  customer: CompanyBillingDetails,
  data: Record<string, unknown>,
  invoiceNumber: string,
  companyName: string,
  currency: string,
  seatLimit: number,
  monthlyRate: number,
  annualAmount: number,
  reference: string,
  activationOnPayment: boolean,
): string {
  const commands: string[] = [
    "0 G",
    "0.7 w",
    textCommand(
      "F2",
      18,
      48,
      58,
      issuer.businessName || "PolymApp",
    ),
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
    textCommand("F1", 8, 48, 164, "Rechnung an"),
  );

  let customerTop = 183;
  for (const line of [
    customer.invoiceCompanyName || companyName,
    customer.recipientName,
    customer.street,
    customer.addressSupplement,
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
      `${seatLimit} x CHF ${formatRate(monthlyRate)} x 12 Monate`,
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
    `Bitte Rechnungsnummer ${invoiceNumber} als Referenz angeben.`,
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

  return commands.join("\n");
}

/**
 * Builds a Swiss QR payment page.
 * @param {InvoiceIssuerSettings} issuer Issuer details.
 * @param {CompanyBillingDetails} customer Customer details.
 * @param {string} invoiceNumber Invoice number.
 * @param {number} annualAmount Invoice amount.
 * @return {string} PDF page content.
 */
function buildSwissQrPage(
  issuer: InvoiceIssuerSettings,
  customer: CompanyBillingDetails,
  invoiceNumber: string,
  annualAmount: number,
): string {
  const {
    payload,
    scor,
  } = buildSwissQrPayload(
    issuer,
    customer,
    invoiceNumber,
    annualAmount,
  );

  const qrLeft = 52;
  const qrTop = 190;
  const commands: string[] = [
    "0 G",
    "0 g",
    "0.7 w",
    textCommand("F2", 22, 48, 60, "QR-Zahlteil"),
    textCommand(
      "F1",
      9,
      48,
      82,
      "Für E-Banking und Mobile Banking in der Schweiz.",
    ),
    lineCommand(48, 547, 108),
    textCommand("F2", 11, 48, 142, "Swiss QR Code"),
    ...swissQrCommands(payload, qrLeft, qrTop),
  ];

  let rightTop = 150;
  const rightLeft = 235;
  const creditorName =
    issuer.businessName && issuer.contactName ?
      `${issuer.businessName}, ${issuer.contactName}` :
      issuer.businessName || issuer.contactName;

  for (const line of [
    "Zahlbar an",
    creditorName,
    issuer.street,
    [issuer.postalCode, issuer.city].filter(Boolean).join(" "),
    issuer.country,
    "",
    `IBAN: ${issuer.iban}`,
  ]) {
    if (!line) {
      rightTop += 9;
      continue;
    }

    commands.push(
      textCommand(
        line === "Zahlbar an" ? "F2" : "F1",
        line === "Zahlbar an" ? 10 : 9,
        rightLeft,
        rightTop,
        line,
      ),
    );
    rightTop += 14;
  }

  rightTop += 12;
  commands.push(
    textCommand("F2", 10, rightLeft, rightTop, "Betrag"),
    textCommand(
      "F1",
      11,
      rightLeft,
      rightTop + 17,
      formatCurrency(annualAmount),
    ),
  );

  rightTop += 55;
  commands.push(
    textCommand("F2", 10, rightLeft, rightTop, "Referenz"),
  );

  for (const line of wrapText(scor, 28)) {
    rightTop += 15;
    commands.push(
      textCommand("F1", 9, rightLeft, rightTop, line),
    );
  }

  rightTop += 27;
  commands.push(
    textCommand("F2", 10, rightLeft, rightTop, "Zahlbar durch"),
  );

  for (const line of [
    customer.invoiceCompanyName ||
      customer.recipientName,
    customer.recipientName &&
      customer.invoiceCompanyName ?
      customer.recipientName :
      "",
    customer.street,
    customer.addressSupplement,
    [customer.postalCode, customer.city]
      .filter(Boolean)
      .join(" "),
    customer.country,
  ].filter(Boolean)) {
    rightTop += 14;
    commands.push(
      textCommand("F1", 9, rightLeft, rightTop, line),
    );
  }

  commands.push(
    lineCommand(48, 547, 560),
    textCommand(
      "F1",
      8,
      48,
      585,
      "Beim Scannen werden IBAN, Betrag und Referenz automatisch übernommen.",
    ),
    textCommand(
      "F1",
      8,
      48,
      602,
      `Rechnung ${invoiceNumber}`,
    ),
  );

  return commands.join("\n");
}

/**
 * Builds a PDF with one or two pages.
 * @param {string} firstPage First page content.
 * @param {string | null} secondPage Optional second page content.
 * @return {Buffer} PDF bytes.
 */
function buildPdfDocument(
  firstPage: string,
  secondPage: string | null,
): Buffer {
  const firstLength = Buffer.byteLength(
    firstPage,
    "latin1",
  );
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    secondPage ?
      "<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>" :
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
    `<< /Length ${firstLength} >>\nstream\n` +
      `${firstPage}\nendstream`,
  ];

  if (secondPage) {
    const secondLength = Buffer.byteLength(
      secondPage,
      "latin1",
    );

    objects.push(
      [
        "<< /Type /Page /Parent 2 0 R",
        `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]`,
        "/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >>",
        "/Contents 8 0 R >>",
      ].join(" "),
      `<< /Length ${secondLength} >>\nstream\n` +
        `${secondPage}\nendstream`,
    );
  }

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

  return Buffer.from(pdf, "latin1");
}

/**
 * Builds an invoice PDF from invoice data.
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

  const firstPage = buildInvoicePage(
    issuer,
    customer,
    data,
    invoiceNumber,
    companyName,
    currency,
    seatLimit,
    monthlyRate,
    annualAmount,
    reference,
    activationOnPayment,
  );

  const hasSwissQrPage =
    customerCountryCode(customer) === "CH" &&
    currency === "CHF" &&
    /^CH\d{19}$/.test(compactIban(issuer.iban));

  const secondPage = hasSwissQrPage ?
    buildSwissQrPage(
      issuer,
      customer,
      invoiceNumber,
      annualAmount,
    ) :
    null;

  const buffer = buildPdfDocument(
    firstPage,
    secondPage,
  );

  return {
    base64: buffer.toString("base64"),
    filename:
      `PolymApp-Rechnung-${invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "-")}.pdf`,
    mimeType: "application/pdf",
  };
}
