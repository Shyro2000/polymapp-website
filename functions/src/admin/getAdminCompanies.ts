import {Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {
  DEFAULT_ISSUER_SETTINGS,
  normalizeIssuerSettings,
} from "./billingConfig";

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
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
function effectiveInvoiceStatus(status: string, dueAt: unknown): string {
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
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }

  const uid = request.auth.uid;
  const userSnapshot = await db.collection("users").doc(uid).get();

  if (!userSnapshot.exists || userSnapshot.get("systemAdmin") !== true) {
    throw new HttpsError(
      "permission-denied",
      "Kein Zugriff auf die PolymApp-Administration.",
    );
  }

  const [
    companiesSnapshot,
    archiveSnapshot,
    invoicesSnapshot,
    billingDetailsSnapshot,
    issuerSettingsSnapshot,
    subscriptionsSnapshot,
    notificationsSnapshot,
    programSnapshot,
  ] = await Promise.all([
    db.collection("companies").get(),
    db.collection("companyArchive").get(),
    db.collection("companyInvoices").get(),
    db.collection("companyBillingDetails").get(),
    db.collection("systemSettings").doc("invoicing").get(),
    db.collection("companySubscriptions").get(),
    db
      .collection("adminNotifications")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get(),
    db.collection("systemSettings").doc("companyProgram").get(),
  ]);

  const billingDetailsByCompany = new Map<string, Record<string, unknown>>();

  for (const document of billingDetailsSnapshot.docs) {
    billingDetailsByCompany.set(document.id, document.data());
  }

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
      timestampToMillis(data.activatedPeriodStartAt) ||
      timestampToMillis(data.periodStartAt) ||
      0;
    const periodEndMs =
      timestampToMillis(data.activatedPeriodEndAt) ||
      timestampToMillis(data.periodEndAt) ||
      0;

    if (companyId && status !== "cancelled") {
      const current = invoiceByCompany.get(companyId);
      const sortDate =
        periodStartMs || timestampToMillis(data.createdAt) || 0;

      if (!current || sortDate > current.periodStartMs) {
        invoiceByCompany.set(companyId, {
          status,
          periodStartMs: sortDate,
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
      kind: readString(data.kind, "annual"),
      settledByCredit: data.settledByCredit === true,
      grossAmountCents: readNumber(data.grossAmountCents),
      creditUsedCents: readNumber(data.creditUsedCents),
      currency: readString(data.currency, "CHF"),
      reference: readString(data.reference),
      paymentReference: readString(data.paymentReference),
      status,
      activationOnPayment: data.activationOnPayment === true,
      periodStartMs,
      periodEndMs,
      dueAtMs: timestampToMillis(data.dueAt),
      dueDate: readString(data.dueDate),
      paidAtMs: timestampToMillis(data.paidAt),
      createdAtMs: timestampToMillis(data.createdAt),
    };
  });

  invoices.sort((first, second) => {
    const firstDate = first.createdAtMs || first.periodStartMs || 0;
    const secondDate = second.createdAtMs || second.periodStartMs || 0;

    return secondDate - firstDate;
  });

  const nowMs = Timestamp.now().toMillis();

  const companies = companiesSnapshot.docs.map((document) => {
    const data = document.data();
    const storedBillingStatus = readString(
      data.billingStatus,
      "not_configured",
    );
    const validUntilMs = timestampToMillis(data.billingValidUntil) || 0;
    const latestInvoice = invoiceByCompany.get(document.id);
    const ownerUid = readString(data.ownerUid);
    const billingDetails = billingDetailsByCompany.get(document.id);
    const billingDetailsReady =
      billingDetails?.reviewedByOwnerUid === ownerUid;

    let billingStatus = storedBillingStatus;
    const graceUntilMs =
      validUntilMs > 0 ? validUntilMs + 10 * 24 * 60 * 60 * 1000 : 0;

    if (storedBillingStatus !== "suspended") {
      if (
        validUntilMs > 0 &&
        nowMs > graceUntilMs &&
        latestInvoice?.status === "overdue"
      ) {
        billingStatus = "suspended";
      } else if (validUntilMs >= nowMs) {
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

    const subscription = subscriptionsSnapshot.docs.find(
      (item) => item.id === document.id,
    );
    if (data.accessMode === "pilot" && storedBillingStatus !== "suspended") {
      billingStatus = "pilot";
    }
    return {
      accessMode: readString(data.accessMode, "migration_required"),
      creditBalanceCents: Number(
        subscription?.get("creditBalanceCents") || 0,
      ),
      pendingChange: subscription?.get("pendingChange") || null,
      id: document.id,
      name: readString(data.name),
      status: readString(data.status, "unknown"),
      seatLimit: readNumber(data.seatLimit),
      activeMemberCount: readNumber(data.activeMemberCount),
      billingStatus,
      billingDetailsReady,
      billingValidUntilMs: validUntilMs || null,
      renewalRecommendedAtMs:
        validUntilMs > 0 ? validUntilMs - 40 * 24 * 60 * 60 * 1000 : null,
    };
  });

  companies.sort((first, second) =>
    first.name.localeCompare(second.name, "de", {sensitivity: "base"}),
  );

  const formerCompanies = archiveSnapshot.docs.map((document) => {
    const data = document.data();

    return {
      id: document.id,
      name: readString(data.name),
      seatLimit: readNumber(data.seatLimit),
      activeMemberCount: readNumber(data.activeMemberCount),
      billingStatus: readString(data.billingStatus, "not_configured"),
      archiveStatus: readString(data.archiveStatus, "deleted"),
      deletedAtMs: timestampToMillis(data.deletedAt),
    };
  });

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
    notifications: notificationsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      createdAtMs: timestampToMillis(doc.get("createdAt")),
    })),
    program: {
      paidEnrollmentEnabled:
        programSnapshot.get("paidEnrollmentEnabled") === true,
      launchDate: programSnapshot.get("launchDate") || null,
    },
    migrationRequired: companies.some(
      (company) => company.accessMode === "migration_required",
    ),
    companies,
    formerCompanies,
    invoices: normalizedInvoices,
    billingSettings: normalizeIssuerSettings(
      issuerSettingsSnapshot.exists ?
        issuerSettingsSnapshot.data() :
        DEFAULT_ISSUER_SETTINGS,
    ),
  };
});
