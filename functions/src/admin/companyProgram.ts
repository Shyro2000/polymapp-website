import {requireAdminMfa} from "../shared/adminAccess";
import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {PRICING_VERSION, tariffPrice} from "../company/companySubscription";
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

/** Enables paid enrollment for new companies. */
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

/** Moves one pilot company onto its displayed annual tariff. */
export const activatePaidCompanyByAdmin = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  const uid = request.auth.uid;
  await requireAdminMfa(request.auth);
  const {companyId, seatLimit, annualCents} = request.data || {};
  if (typeof companyId !== "string" || !/^[\w-]{1,200}$/.test(companyId)) {
    throw new HttpsError("invalid-argument", "Ungültige Firma.");
  }
  const ref = db.collection("companies").doc(companyId);
  return db.runTransaction(async (tx) => {
    const company = await tx.get(ref);
    const program = await tx.get(
      db.collection("systemSettings").doc("companyProgram"),
    );
    if (!company.exists) {
      throw new HttpsError("not-found", "Firma nicht gefunden.");
    }
    if (company.get("accessMode") === "paid") return {changed: false};
    if (program.get("paidEnrollmentEnabled") !== true ||
        company.get("accessMode") !== "pilot" ||
        company.get("status") !== "active" ||
        company.get("billingStatus") === "suspended" ||
        company.get("subscriptionEndsAt") != null) {
      throw new HttpsError("failed-precondition",
        "Diese Firma kann derzeit nicht umgestellt werden.");
    }
    if (company.get("seatLimit") !== seatLimit ||
        tariffPrice(seatLimit).annualCents !== annualCents) {
      throw new HttpsError("failed-precondition",
        "Der Tarif hat sich geändert. Bitte die Übersicht aktualisieren.");
    }
    tx.update(ref, {
      accessMode: "paid",
      billingStatus: "payment_pending",
      paidTariffActivatedByAdminAt: FieldValue.serverTimestamp(),
      paidTariffActivatedByAdminUid: uid,
      acceptedPricingVersion: PRICING_VERSION,
      subscriptionRevision: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {changed: true};
  });
});
