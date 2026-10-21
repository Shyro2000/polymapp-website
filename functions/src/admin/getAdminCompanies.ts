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

export const getAdminCompanies = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein.",
    );
  }

  const uid = request.auth.uid;
  const userSnapshot = await db.collection("users").doc(uid).get();

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
    paymentsSnapshot,
  ] = await Promise.all([
    db.collection("companies").get(),
    db.collection("companyArchive").get(),
    db.collection("companyPayments").get(),
  ]);

  const companies = companiesSnapshot.docs.map((document) => {
    const data = document.data();

    return {
      id: document.id,
      name: readString(data.name),
      status: readString(data.status, "unknown"),
      seatLimit: readNumber(data.seatLimit),
      activeMemberCount: readNumber(data.activeMemberCount),
      billingStatus: readString(
        data.billingStatus,
        "not_configured",
      ),
    };
  });

  companies.sort((first, second) =>
    first.name.localeCompare(
      second.name,
      "de",
      {sensitivity: "base"},
    ),
  );

  const formerCompanies = archiveSnapshot.docs.map((document) => {
    const data = document.data();

    return {
      id: document.id,
      name: readString(data.name),
      seatLimit: readNumber(data.seatLimit),
      activeMemberCount: readNumber(data.activeMemberCount),
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

  const payments = paymentsSnapshot.docs.map((document) => {
    const data = document.data();
    const companyId = readString(data.companyId);
    const storedCompanyName = readString(data.companyName);

    return {
      id: document.id,
      companyId,
      companyName:
        storedCompanyName ||
        companyNameById.get(companyId) ||
        "Unbekannte Firma",
      amount: readNumber(data.amount),
      currency: readString(data.currency, "CHF"),
      reference: readString(data.reference),
      status: readString(data.status, "pending"),
      dueAtMs: timestampToMillis(data.dueAt),
      paidAtMs: timestampToMillis(data.paidAt),
      createdAtMs: timestampToMillis(data.createdAt),
    };
  });

  payments.sort((first, second) => {
    const firstDate = first.dueAtMs || first.createdAtMs || 0;
    const secondDate = second.dueAtMs || second.createdAtMs || 0;
    return secondDate - firstDate;
  });

  return {
    companies,
    formerCompanies,
    payments,
  };
});
