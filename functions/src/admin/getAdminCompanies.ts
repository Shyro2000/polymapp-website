import {Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

/**
 * Converts an unknown value to a string.
 * @param {unknown} value Value to convert.
 * @param {string} fallback Fallback value.
 * @return {string} Normalized string.
 */
function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Converts an unknown value to a finite number.
 * @param {unknown} value Value to convert.
 * @return {number} Normalized number.
 */
function readNumber(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) ?
    value :
    0;
}

/**
 * Converts a Firestore timestamp to milliseconds.
 * @param {unknown} value Value to convert.
 * @return {number | null} Milliseconds or null.
 */
function timestampToMillis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

/**
 * Returns the effective invoice status.
 * @param {string} status Stored invoice status.
 * @param {unknown} dueAt Invoice due timestamp.
 * @return {string} Effective status.
 */
function effectiveInvoiceStatus(
  status: string,
  dueAt: unknown,
): string {
  if (
    status === "open" &&
    dueAt instanceof Timestamp &&
    dueAt.toMillis() < Timestamp.now().toMillis()
  ) {
    return "overdue";
  }

  return status;
}

export const getAdminCompanies = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein.",
    );
  }

  const uid = request.auth.uid;
  const userSnapshot = await db
    .collection("users")
    .doc(uid)
    .get();

  if (
    !userSnapshot.exists ||
    userSnapshot.get("systemAdmin") !== true
  ) {
    throw new HttpsError(
      "permission-denied",
      "Kein Zugriff auf die PolymApp-Administration.",
    );
  }

  const [
    companiesSnapshot,
    archiveSnapshot,
    invoicesSnapshot,
  ] = await Promise.all([
    db.collection("companies").get(),
    db.collection("companyArchive").get(),
    db.collection("companyInvoices").get(),
  ]);

  const invoiceByCompany = new Map<
    string,
    {
      status: string;
      periodStartMs: number;
      periodEndMs: number;
    }
  >();

  const invoices = invoicesSnapshot.docs.map((document) => {
    const data = document.data();
    const companyId = readString(data.companyId);
    const status = effectiveInvoiceStatus(
      readString(data.status, "open"),
      data.dueAt,
    );
    const periodStartMs =
      timestampToMillis(data.periodStartAt) || 0;
    const periodEndMs =
      timestampToMillis(data.periodEndAt) || 0;

    if (companyId && status !== "cancelled") {
      const current = invoiceByCompany.get(companyId);

      if (
        !current ||
        periodStartMs > current.periodStartMs
      ) {
        invoiceByCompany.set(companyId, {
          status,
          periodStartMs,
          periodEndMs,
        });
      }
    }

    return {
      id: document.id,
      invoiceNumber: readString(data.invoiceNumber),
      companyId,
      companyName: readString(data.companyName),
      seatLimit: readNumber(data.seatLimit),
      monthlyRate: readNumber(data.monthlyRate),
      annualAmount: readNumber(data.annualAmount),
      currency: readString(data.currency, "CHF"),
      reference: readString(data.reference),
      paymentReference: readString(
        data.paymentReference,
      ),
      status,
      periodStartMs,
      periodEndMs,
      dueAtMs: timestampToMillis(data.dueAt),
      paidAtMs: timestampToMillis(data.paidAt),
      createdAtMs: timestampToMillis(data.createdAt),
    };
  });

  invoices.sort((first, second) => {
    const firstDate =
      first.createdAtMs ||
      first.periodStartMs ||
      0;
    const secondDate =
      second.createdAtMs ||
      second.periodStartMs ||
      0;

    return secondDate - firstDate;
  });

  const nowMs = Timestamp.now().toMillis();

  const companies = companiesSnapshot.docs.map((document) => {
    const data = document.data();
    const storedBillingStatus = readString(
      data.billingStatus,
      "not_configured",
    );
    const validUntilMs =
      timestampToMillis(data.billingValidUntil) || 0;
    const latestInvoice =
      invoiceByCompany.get(document.id);

    let billingStatus = storedBillingStatus;

    if (storedBillingStatus !== "suspended") {
      if (validUntilMs >= nowMs) {
        billingStatus = "active";
      } else if (latestInvoice?.status === "overdue") {
        billingStatus = "overdue";
      } else if (latestInvoice?.status === "open") {
        billingStatus = "payment_pending";
      } else if (
        latestInvoice?.status === "paid" &&
        latestInvoice.periodEndMs >= nowMs
      ) {
        billingStatus = "active";
      } else {
        billingStatus = "not_configured";
      }
    }

    return {
      id: document.id,
      name: readString(data.name),
      status: readString(data.status, "unknown"),
      seatLimit: readNumber(data.seatLimit),
      activeMemberCount: readNumber(
        data.activeMemberCount,
      ),
      billingStatus,
      billingValidUntilMs: validUntilMs || null,
    };
  });

  companies.sort((first, second) =>
    first.name.localeCompare(
      second.name,
      "de",
      {sensitivity: "base"},
    ),
  );

  const formerCompanies = archiveSnapshot.docs.map(
    (document) => {
      const data = document.data();

      return {
        id: document.id,
        name: readString(data.name),
        seatLimit: readNumber(data.seatLimit),
        activeMemberCount: readNumber(
          data.activeMemberCount,
        ),
        billingStatus: readString(
          data.billingStatus,
          "not_configured",
        ),
        archiveStatus: readString(
          data.archiveStatus,
          "deleted",
        ),
        deletedAtMs: timestampToMillis(data.deletedAt),
      };
    },
  );

  formerCompanies.sort((first, second) => {
    const firstDeletedAt = first.deletedAtMs || 0;
    const secondDeletedAt = second.deletedAtMs || 0;
    return secondDeletedAt - firstDeletedAt;
  });

  const companyNameById = new Map<string, string>();

  for (const company of companies) {
    companyNameById.set(company.id, company.name);
  }

  for (const company of formerCompanies) {
    if (!companyNameById.has(company.id)) {
      companyNameById.set(company.id, company.name);
    }
  }

  const normalizedInvoices = invoices.map((invoice) => ({
    ...invoice,
    companyName:
      invoice.companyName ||
      companyNameById.get(invoice.companyId) ||
      "Unbekannte Firma",
  }));

  return {
    companies,
    formerCompanies,
    invoices: normalizedInvoices,
  };
});
