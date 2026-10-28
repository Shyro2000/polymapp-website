import {requireAdminMfa} from "../shared/adminAccess";
import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

export const markCompanyNotificationRead = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  await requireAdminMfa(request.auth);
  const id = request.data?.notificationId;
  if (typeof id !== "string" || !/^[\w-]{1,240}$/.test(id)) {
    throw new HttpsError("invalid-argument", "Ungültige Meldung.");
  }
  await db
    .collection("adminNotifications")
    .doc(id)
    .update({
      read: true,
      readAt: FieldValue.serverTimestamp(),
      readByUid: request.auth.uid,
    });
  return {changed: true};
});

/**
 * Repeatable migration preserving existing payments and suspensions.
 */
export const migrateCompanySubscriptions = onCall(
  {timeoutSeconds: 540},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bitte anmelden.");
    }
    await requireAdminMfa(request.auth);
    const companies = await db.collection("companies").get();
    let migrated = 0;
    for (const document of companies.docs) {
      const changed = await db.runTransaction(async (tx) => {
        const company = await tx.get(document.ref);
        if (
          !company.exists ||
          company.get("status") !== "active" ||
          company.get("accessMode")
        ) {
          return false;
        }
        const until = company.get("billingValidUntil");
        const paid =
          until instanceof Timestamp ||
          !!company.get("billingPendingInvoiceId") ||
          ["active", "overdue", "payment_pending", "suspended"].includes(
            company.get("billingStatus"),
          );
        const subscriptionRef = db
          .collection("companySubscriptions")
          .doc(company.id);
        const existing = await tx.get(subscriptionRef);
        tx.update(company.ref, {
          accessMode: paid ? "paid" : "pilot",
          ...(paid ? {} : {billingStatus: "pilot"}),
          ...(paid ?
            {
              paidTariffAcceptedAt:
                  company.get("createdAt") || FieldValue.serverTimestamp(),
              acceptedPricingVersion: "legacy",
            } :
            {}),
          subscriptionRevision: FieldValue.increment(1),
          subscriptionMigratedAt: FieldValue.serverTimestamp(),
        });
        if (!existing.exists) {
          tx.create(subscriptionRef, {
            creditBalanceCents: 0,
            revision: 0,
            pendingChange: null,
          });
        }
        return true;
      });
      if (changed) migrated++;
    }
    return {migrated};
  },
);

/** Explicit future launch switch. Existing pilot firms require owner opt-in. */
export const updateCompanyProgram = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  await requireAdminMfa(request.auth);
  if (typeof request.data?.paidEnrollmentEnabled !== "boolean") {
    throw new HttpsError("invalid-argument", "Ungültiger Einführungsstatus.");
  }
  const enabled = request.data.paidEnrollmentEnabled;
  const launchDate = enabled ? request.data?.launchDate : null;
  if (
    enabled &&
    (typeof launchDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(launchDate) ||
      Number.isNaN(Date.parse(launchDate)) ||
      new Date(launchDate).toISOString().slice(0, 10) !== launchDate ||
      Date.parse(launchDate) > Date.now())
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Die bezahlte Einführung darf erst am " +
          "bekanntgegebenen Startdatum aktiviert werden.",
    );
  }
  await db.collection("systemSettings").doc("companyProgram").set(
    {
      paidEnrollmentEnabled: enabled,
      launchDate,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: request.auth.uid,
    },
    {merge: true},
  );
  return {paidEnrollmentEnabled: enabled, launchDate};
});
