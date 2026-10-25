import {
  readServicePeriods,
  tariffPrice,
  writeServicePeriods,
} from "../company/companySubscription";
import {applyCredit, proratedDelta} from "../company/tariffMath";
import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {
  DEFAULT_ISSUER_SETTINGS,
  InvoiceIssuerSettings,
  normalizeCompanyBillingDetails,
  normalizeIssuerSettings,
  normalizeText,
  PRICE_TIERS,
} from "./billingConfig";
import {buildInvoicePdf} from "./invoicePdf";

/**
 * Verifies that the caller is a PolymApp system admin.
 * @param {string} uid Firebase Authentication uid.
 * @return {Promise<void>} Resolves for authorized admins.
 */
async function requireSystemAdmin(uid: string): Promise<void> {
  const userSnapshot = await db.collection("users").doc(uid).get();

  if (!userSnapshot.exists || userSnapshot.get("systemAdmin") !== true) {
    throw new HttpsError(
      "permission-denied",
      "Kein Zugriff auf die PolymApp-Administration.",
    );
  }
}

/**
 * Parses a YYYY-MM-DD date.
 * @param {unknown} value Date value.
 * @param {string} fieldName Field label for errors.
 * @param {boolean} endOfDay Whether to use the end of the UTC day.
 * @return {Timestamp} Parsed timestamp.
 */
function parseDate(
  value: unknown,
  fieldName: string,
  endOfDay = false,
): Timestamp {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpsError("invalid-argument", `${fieldName} ist ungültig.`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new HttpsError("invalid-argument", `${fieldName} ist ungültig.`);
  }

  if (endOfDay) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  if (Number.isNaN(date.getTime())) {
    throw new HttpsError("invalid-argument", `${fieldName} ist ungültig.`);
  }

  return Timestamp.fromDate(date);
}

/**
 * Adds one year and subtracts one day.
 * @param {Timestamp} startAt Period start.
 * @return {Timestamp} Inclusive period end.
 */
function annualPeriodEnd(startAt: Timestamp): Timestamp {
  const date = startAt.toDate();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  date.setUTCDate(date.getUTCDate() - 1);
  date.setUTCHours(23, 59, 59, 999);
  return Timestamp.fromDate(date);
}

/**
 * Returns the day after a timestamp.
 * @param {Timestamp} value Source timestamp.
 * @return {Timestamp} Next day at midnight UTC.
 */
function nextDay(value: Timestamp): Timestamp {
  const date = value.toDate();
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(0, 0, 0, 0);
  return Timestamp.fromDate(date);
}

/**
 * Returns the annual amount for a supported seat tier.
 * @param {number} seatLimit Booked seats.
 * @return {{monthlyRate: number, annualAmount: number}} Pricing.
 */
function pricingForSeatLimit(seatLimit: number): {
  monthlyRate: number;
  annualAmount: number;
} {
  const monthlyRate = PRICE_TIERS.get(seatLimit);

  if (monthlyRate === undefined) {
    throw new HttpsError(
      "failed-precondition",
      "Für diese Sitzplatzanzahl ist kein Tarif hinterlegt.",
    );
  }

  const annualAmount = Math.round(seatLimit * monthlyRate * 12 * 100) / 100;

  return {
    monthlyRate,
    annualAmount,
  };
}

/**
 * Checks whether two invoice periods overlap.
 * @param {Timestamp} firstStart First start.
 * @param {Timestamp} firstEnd First end.
 * @param {Timestamp} secondStart Second start.
 * @param {Timestamp} secondEnd Second end.
 * @return {boolean} True when the periods overlap.
 */
function periodsOverlap(
  firstStart: Timestamp,
  firstEnd: Timestamp,
  secondStart: Timestamp,
  secondEnd: Timestamp,
): boolean {
  return (
    firstStart.toMillis() <= secondEnd.toMillis() &&
    firstEnd.toMillis() >= secondStart.toMillis()
  );
}

/**
 * Validates optional email values.
 * @param {string} value Email value.
 * @param {string} fieldName Field label.
 */
function validateOptionalEmail(value: string, fieldName: string): void {
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new HttpsError("invalid-argument", `${fieldName} ist ungültig.`);
  }
}

/**
 * Sanitizes admin invoice issuer settings.
 * @param {unknown} value Raw settings.
 * @return {InvoiceIssuerSettings} Validated settings.
 */
function validatedIssuerSettings(value: unknown): InvoiceIssuerSettings {
  const settings = normalizeIssuerSettings(value);
  validateOptionalEmail(settings.email, "Die Absender-E-Mail-Adresse");

  return settings;
}

/**
 * Creates an annual company invoice.
 */
export const createCompanyInvoice = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }

  const adminUid = request.auth.uid;
  await requireSystemAdmin(adminUid);

  const companyId = normalizeText(request.data?.companyId, "", 200);

  if (!companyId) {
    throw new HttpsError("invalid-argument", "Die Firma fehlt.");
  }

  const dueDate = normalizeText(request.data?.dueDate, "", 10);
  const dueAt = parseDate(dueDate, "Das Fälligkeitsdatum", true);
  const requestedReference = normalizeText(request.data?.reference, "", 120);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  if (dueAt.toMillis() < today.getTime()) {
    throw new HttpsError(
      "invalid-argument",
      "Das Fälligkeitsdatum darf nicht in der Vergangenheit liegen.",
    );
  }

  const companyRef = db.collection("companies").doc(companyId);
  const billingDetailsRef = db
    .collection("companyBillingDetails")
    .doc(companyId);
  const issuerSettingsRef = db.collection("systemSettings").doc("invoicing");
  const invoiceRef = db.collection("companyInvoices").doc();
  const invoicesQuery = db
    .collection("companyInvoices")
    .where("companyId", "==", companyId);

  const issueYear = new Date().getUTCFullYear();
  const counterRef = db
    .collection("systemCounters")
    .doc(`companyInvoices-${issueYear}`);

  return db.runTransaction(async (transaction) => {
    const [
      companySnapshot,
      billingDetailsSnapshot,
      issuerSettingsSnapshot,
      invoicesSnapshot,
      counterSnapshot,
      subscriptionSnapshot,
    ] = await Promise.all([
      transaction.get(companyRef),
      transaction.get(billingDetailsRef),
      transaction.get(issuerSettingsRef),
      transaction.get(invoicesQuery),
      transaction.get(counterRef),
      transaction.get(db.collection("companySubscriptions").doc(companyId)),
    ]);

    if (!companySnapshot.exists) {
      throw new HttpsError("not-found", "Die Firma wurde nicht gefunden.");
    }

    if (companySnapshot.get("status") !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "Nur aktive Firmen können verrechnet werden.",
      );
    }

    if (
      companySnapshot.get("accessMode") !== "paid" ||
      !companySnapshot.get("paidTariffAcceptedAt")
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Während der kostenlosen Aufbauphase " +
            "werden keine Rechnungen erstellt. " +
          "Der Inhaber muss das kostenpflichtige Firmenabo zuerst bestätigen.",
      );
    }
    if (companySnapshot.get("billingPendingInvoiceId")) {
      throw new HttpsError(
        "already-exists",
        "Es besteht bereits eine offene Rechnung.",
      );
    }
    const pendingChange = subscriptionSnapshot.get("pendingChange");
    const isTariffChange = !!pendingChange;
    const companyName = normalizeText(companySnapshot.get("name"), "", 120);
    const ownerUid = normalizeText(companySnapshot.get("ownerUid"), "", 200);
    const customerBilling = normalizeCompanyBillingDetails(
      billingDetailsSnapshot.exists ? billingDetailsSnapshot.data() : null,
      companyName,
      "",
    );

    if (!ownerUid || customerBilling.reviewedByOwnerUid !== ownerUid) {
      throw new HttpsError(
        "failed-precondition",
        "Der Firmeninhaber muss die Rechnungsdaten zuerst " +
          "prüfen und speichern.",
      );
    }

    const issuerSettings = validatedIssuerSettings(
      issuerSettingsSnapshot.exists ?
        issuerSettingsSnapshot.data() :
        DEFAULT_ISSUER_SETTINGS,
    );

    const seatLimit = isTariffChange ?
      pendingChange.targetSeatLimit :
      companySnapshot.get("seatLimit");

    if (typeof seatLimit !== "number" || !Number.isFinite(seatLimit)) {
      throw new HttpsError(
        "failed-precondition",
        "Die Firma hat keinen gültigen Tarif.",
      );
    }

    const pricing = pricingForSeatLimit(seatLimit);
    const currentBillingValidUntil = companySnapshot.get("billingValidUntil");
    const nowMs = Timestamp.now().toMillis();
    const hasExistingSubscription =
      currentBillingValidUntil instanceof Timestamp &&
      currentBillingValidUntil.toMillis() >= nowMs;

    const activationOnPayment = !isTariffChange && !hasExistingSubscription;
    const periodStartAt = isTariffChange ?
      Timestamp.fromMillis(pendingChange.effectiveDayMs) :
      hasExistingSubscription ?
        nextDay(currentBillingValidUntil) :
        null;
    const periodEndAt = isTariffChange ?
      currentBillingValidUntil :
      periodStartAt instanceof Timestamp ?
        annualPeriodEnd(periodStartAt) :
        null;

    for (const existingInvoice of invoicesSnapshot.docs) {
      const status = existingInvoice.get("status");

      if (
        status === "cancelled" ||
        isTariffChange ||
        existingInvoice.get("kind") === "tariff_change"
      ) {
        continue;
      }

      const existingActivationOnPayment =
        existingInvoice.get("activationOnPayment") === true;

      if (
        activationOnPayment &&
        existingActivationOnPayment &&
        status !== "paid"
      ) {
        throw new HttpsError(
          "already-exists",
          "Für die Erstaktivierung besteht bereits eine offene Rechnung.",
        );
      }

      const existingStart = existingInvoice.get("periodStartAt");
      const existingEnd = existingInvoice.get("periodEndAt");

      if (
        periodStartAt instanceof Timestamp &&
        periodEndAt instanceof Timestamp &&
        existingStart instanceof Timestamp &&
        existingEnd instanceof Timestamp &&
        periodsOverlap(periodStartAt, periodEndAt, existingStart, existingEnd)
      ) {
        throw new HttpsError(
          "already-exists",
          "Für diesen Leistungszeitraum besteht bereits eine Rechnung.",
        );
      }
    }

    const currentSequence =
      counterSnapshot.exists &&
      typeof counterSnapshot.get("sequence") === "number" ?
        counterSnapshot.get("sequence") :
        0;
    const nextSequence = currentSequence + 1;
    const invoiceNumber =
      `PA-${issueYear}-${String(nextSequence).padStart(5, "0")}`;
    const reference =
      requestedReference ||
      customerBilling.customerReference ||
      invoiceNumber;

    const currentBillingStatus = companySnapshot.get("billingStatus");
    const now = Timestamp.now();
    const currentlyActive =
      currentBillingValidUntil instanceof Timestamp &&
      currentBillingValidUntil.toMillis() >= now.toMillis();

    let nextBillingStatus = currentlyActive ? "active" : "payment_pending";

    if (currentBillingStatus === "suspended") {
      nextBillingStatus = "suspended";
    }

    const subscriptionRef = subscriptionSnapshot.ref;
    const grossCents = isTariffChange ?
      Number(pendingChange.deltaCents) :
      Math.round(pricing.annualAmount * 100);
    const balanceCents = Number(
      subscriptionSnapshot.get("creditBalanceCents") || 0,
    );
    const credit = isTariffChange ?
      {
        creditUsedCents: Number(pendingChange.creditUsedCents),
        amountDueCents: Number(pendingChange.amountDueCents),
      } :
      applyCredit(grossCents, balanceCents);
    const fullyCredited = credit.amountDueCents === 0;
    const nowStart = Timestamp.fromDate(today);
    const settledStart = periodStartAt || nowStart;
    const settledEnd = periodEndAt || annualPeriodEnd(settledStart);
    transaction.set(
      subscriptionRef,
      {
        creditBalanceCents: isTariffChange ?
          balanceCents :
          balanceCents - credit.creditUsedCents,
        revision: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    if (!isTariffChange && credit.creditUsedCents) {
      transaction.create(
        subscriptionRef.collection("ledger").doc(`invoice-${invoiceRef.id}`),
        {
          kind: "invoice_credit_applied",
          amountCents: -credit.creditUsedCents,
          invoiceId: invoiceRef.id,
          createdAt: FieldValue.serverTimestamp(),
        },
      );
    }

    transaction.set(
      counterRef,
      {
        sequence: nextSequence,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    transaction.create(invoiceRef, {
      invoiceNumber,
      companyId,
      companyName,
      seatLimit,
      monthlyRate: pricing.monthlyRate,
      kind: isTariffChange ? "tariff_change" : "annual",
      requestId: isTariffChange ? pendingChange.requestId : null,
      grossAmountCents: grossCents,
      creditUsedCents: credit.creditUsedCents,
      annualAmount: credit.amountDueCents / 100,
      pricingAnnualCents: Math.round(pricing.annualAmount * 100),
      currency: "CHF",
      activationOnPayment,
      periodStartAt,
      periodEndAt,
      dueAt,
      dueDate,
      reference,
      customerBillingSnapshot: customerBilling,
      issuerSnapshot: issuerSettings,
      status: fullyCredited ? "paid" : "open",
      settledByCredit: fullyCredited,
      ...(fullyCredited ?
        {
          paidAt: FieldValue.serverTimestamp(),
          paidByUid: adminUid,
          activatedPeriodStartAt: settledStart,
          activatedPeriodEndAt: settledEnd,
        } :
        {}),
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: adminUid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(companyRef, {
      billingPendingInvoiceId: fullyCredited ?
        FieldValue.delete() :
        invoiceRef.id,
      billingStatus:
        fullyCredited && currentBillingStatus !== "suspended" ?
          "active" :
          nextBillingStatus,
      ...(fullyCredited ?
        {
          billingValidFrom:
              companySnapshot.get("billingValidFrom") || settledStart,
          billingValidUntil: settledEnd,
          billingInvoiceId: invoiceRef.id,
        } :
        {}),
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (fullyCredited && !isTariffChange) {
      transaction.set(
        subscriptionRef.collection("periods").doc(invoiceRef.id),
        {
          startAt: settledStart,
          endAt: settledEnd,
          seatLimit,
          annualCents: Math.round(pricing.annualAmount * 100),
        },
      );
    }
    return {
      invoiceId: invoiceRef.id,
      invoiceNumber,
      companyId,
      annualAmount: credit.amountDueCents / 100,
      activationOnPayment,
      periodStartAtMs:
        periodStartAt instanceof Timestamp ? periodStartAt.toMillis() : null,
      periodEndAtMs:
        periodEndAt instanceof Timestamp ? periodEndAt.toMillis() : null,
    };
  });
});

/**
 * Marks an invoice as paid and activates or extends the subscription.
 */
export const markCompanyInvoicePaid = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }

  const adminUid = request.auth.uid;
  await requireSystemAdmin(adminUid);

  const invoiceId = normalizeText(request.data?.invoiceId, "", 200);
  const paymentReference = normalizeText(
    request.data?.paymentReference,
    "",
    120,
  );

  if (!invoiceId) {
    throw new HttpsError("invalid-argument", "Die Rechnung fehlt.");
  }

  const invoiceRef = db.collection("companyInvoices").doc(invoiceId);

  return db.runTransaction(async (transaction) => {
    const invoiceSnapshot = await transaction.get(invoiceRef);

    if (!invoiceSnapshot.exists) {
      throw new HttpsError("not-found", "Die Rechnung wurde nicht gefunden.");
    }

    const status = invoiceSnapshot.get("status");

    if (status === "paid") {
      return {
        invoiceId,
        changed: false,
      };
    }

    if (status !== "open") {
      throw new HttpsError(
        "failed-precondition",
        "Nur offene Rechnungen können bezahlt werden.",
      );
    }

    const companyId = normalizeText(
      invoiceSnapshot.get("companyId"),
      "",
      200,
    );

    if (!companyId) {
      throw new HttpsError(
        "failed-precondition",
        "Die Rechnungsdaten sind unvollständig.",
      );
    }

    const companyRef = db.collection("companies").doc(companyId);
    const companySnapshot = await transaction.get(companyRef);

    if (
      !companySnapshot.exists ||
      companySnapshot.get("status") !== "active"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Die Firma ist nicht mehr aktiv.",
      );
    }
    const subscriptionRef = db
      .collection("companySubscriptions")
      .doc(companyId);
    const subscription = await transaction.get(subscriptionRef);
    const periods = await readServicePeriods(transaction, companyId);
    if (invoiceSnapshot.get("kind") === "tariff_change") {
      const change = subscription.get("pendingChange");
      if (
        !change ||
        change.requestId !== invoiceSnapshot.get("requestId") ||
        !periods.some((period) => period.endMs >= Date.now())
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Tarifänderung ist veraltet " +
            "oder die Laufzeit ist abgelaufen. " +
              "Rechnung stornieren und neu anfragen.",
        );
      }
      const price = tariffPrice(Number(invoiceSnapshot.get("seatLimit")));
      const deltaAtPayment = Math.max(
        0,
        proratedDelta(periods, price.annualCents, Date.now()),
      );
      const adjustmentCredit = Math.max(
        0,
        Number(invoiceSnapshot.get("grossAmountCents") || 0) - deltaAtPayment,
      );
      transaction.update(invoiceRef, {
        status: "paid",
        paymentReference,
        paidAt: FieldValue.serverTimestamp(),
        paidByUid: adminUid,
        adjustmentCreditCents: adjustmentCredit,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(
        subscriptionRef,
        {
          pendingChange: null,
          creditBalanceCents:
            Number(subscription.get("creditBalanceCents") || 0) +
            adjustmentCredit,
          revision: FieldValue.increment(1),
        },
        {merge: true},
      );
      if (adjustmentCredit) {
        transaction.create(
          subscriptionRef.collection("ledger").doc(`settled-${invoiceId}`),
          {
            kind: "activation_delay_credit",
            amountCents: adjustmentCredit,
            invoiceId,
            createdAt: FieldValue.serverTimestamp(),
          },
        );
      }
      writeServicePeriods(
        transaction,
        companyId,
        periods,
        price.seatLimit,
        price.annualCents,
      );
      transaction.update(companyRef, {
        seatLimit: price.seatLimit,
        billingPendingInvoiceId: FieldValue.delete(),
        subscriptionRevision: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {invoiceId, changed: true};
    }
    if (
      invoiceSnapshot.get("seatLimit") !== companySnapshot.get("seatLimit")
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Der gebuchte Tarif hat sich geändert.",
      );
    }
    const activationOnPayment =
      invoiceSnapshot.get("activationOnPayment") === true;
    const paidAt = Timestamp.now();

    let invoicePeriodStart = invoiceSnapshot.get("periodStartAt");
    let invoicePeriodEnd = invoiceSnapshot.get("periodEndAt");

    if (
      activationOnPayment ||
      !(companySnapshot.get("billingValidUntil") instanceof Timestamp) ||
      companySnapshot.get("billingValidUntil").toMillis() < Date.now()
    ) {
      invoicePeriodStart = Timestamp.fromDate(
        new Date(
          Date.UTC(
            paidAt.toDate().getUTCFullYear(),
            paidAt.toDate().getUTCMonth(),
            paidAt.toDate().getUTCDate(),
          ),
        ),
      );
      invoicePeriodEnd = annualPeriodEnd(invoicePeriodStart);
    }

    if (
      !(invoicePeriodStart instanceof Timestamp) ||
      !(invoicePeriodEnd instanceof Timestamp)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Der Leistungszeitraum der Rechnung ist ungültig.",
      );
    }

    transaction.set(subscriptionRef.collection("periods").doc(invoiceId), {
      startAt: invoicePeriodStart,
      endAt: invoicePeriodEnd,
      seatLimit: invoiceSnapshot.get("seatLimit"),
      annualCents: Number(
        invoiceSnapshot.get("pricingAnnualCents") ||
          invoiceSnapshot.get("grossAmountCents") ||
          Math.round(Number(invoiceSnapshot.get("annualAmount")) * 100),
      ),
    });
    transaction.update(invoiceRef, {
      status: "paid",
      paymentReference,
      paidAt: FieldValue.serverTimestamp(),
      paidByUid: adminUid,
      activatedPeriodStartAt: invoicePeriodStart,
      activatedPeriodEndAt: invoicePeriodEnd,
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (companySnapshot.exists) {
      const currentValidUntil = companySnapshot.get("billingValidUntil");
      const currentValidUntilMs =
        currentValidUntil instanceof Timestamp ?
          currentValidUntil.toMillis() :
          0;
      const invoiceValidUntilMs = invoicePeriodEnd.toMillis();

      const effectiveValidUntil =
        invoiceValidUntilMs >= currentValidUntilMs ?
          invoicePeriodEnd :
          currentValidUntil;
      const effectiveValidFrom =
        companySnapshot.get("billingValidFrom") instanceof Timestamp ?
          companySnapshot.get("billingValidFrom") :
          invoicePeriodStart;

      if (effectiveValidUntil instanceof Timestamp) {
        const companyUpdate: Record<string, unknown> = {
          billingStatus:
            companySnapshot.get("billingStatus") === "suspended" ?
              "suspended" :
              "active",
          billingValidFrom: effectiveValidFrom,
          billingValidUntil: effectiveValidUntil,
          billingLastPaidAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };

        if (invoiceValidUntilMs >= currentValidUntilMs) {
          companyUpdate.billingInvoiceId = invoiceId;
        }

        if (companySnapshot.get("billingPendingInvoiceId") === invoiceId) {
          companyUpdate.billingPendingInvoiceId = FieldValue.delete();
        }

        transaction.update(companyRef, companyUpdate);
      }
    }

    return {
      invoiceId,
      changed: true,
      billingValidFromMs: invoicePeriodStart.toMillis(),
      billingValidUntilMs: invoicePeriodEnd.toMillis(),
    };
  });
});

/**
 * Cancels an open invoice.
 */
export const cancelCompanyInvoice = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }

  const adminUid = request.auth.uid;
  await requireSystemAdmin(adminUid);

  const invoiceId = normalizeText(request.data?.invoiceId, "", 200);

  if (!invoiceId) {
    throw new HttpsError("invalid-argument", "Die Rechnung fehlt.");
  }

  const invoiceRef = db.collection("companyInvoices").doc(invoiceId);

  return db.runTransaction(async (transaction) => {
    const invoiceSnapshot = await transaction.get(invoiceRef);

    if (!invoiceSnapshot.exists) {
      throw new HttpsError("not-found", "Die Rechnung wurde nicht gefunden.");
    }

    const status = invoiceSnapshot.get("status");

    if (status === "cancelled") {
      return {
        invoiceId,
        changed: false,
      };
    }

    if (status !== "open") {
      throw new HttpsError(
        "failed-precondition",
        "Nur offene Rechnungen können storniert werden.",
      );
    }

    const companyId = normalizeText(
      invoiceSnapshot.get("companyId"),
      "",
      200,
    );
    const companyRef = companyId ?
      db.collection("companies").doc(companyId) :
      null;
    const companySnapshot = companyRef ?
      await transaction.get(companyRef) :
      null;

    const subscriptionRef = db
      .collection("companySubscriptions")
      .doc(companyId);
    const subscription = await transaction.get(subscriptionRef);
    const restoredCredit = Number(
      invoiceSnapshot.get("creditUsedCents") || 0,
    );
    transaction.set(
      subscriptionRef,
      {
        creditBalanceCents:
          Number(subscription.get("creditBalanceCents") || 0) +
          restoredCredit,
        ...(invoiceSnapshot.get("kind") === "tariff_change" ?
          {pendingChange: null} :
          {}),
        revision: FieldValue.increment(1),
      },
      {merge: true},
    );
    if (restoredCredit) {
      transaction.create(
        subscriptionRef.collection("ledger").doc(`cancelled-${invoiceId}`),
        {
          kind: "invoice_credit_restored",
          amountCents: restoredCredit,
          invoiceId,
          createdAt: FieldValue.serverTimestamp(),
        },
      );
    }
    transaction.update(invoiceRef, {
      status: "cancelled",
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledByUid: adminUid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (
      companyRef &&
      companySnapshot?.exists &&
      companySnapshot.get("billingPendingInvoiceId") === invoiceId
    ) {
      const validUntil = companySnapshot.get("billingValidUntil");
      const stillActive =
        validUntil instanceof Timestamp &&
        validUntil.toMillis() >= Timestamp.now().toMillis();
      const currentStatus = companySnapshot.get("billingStatus");

      transaction.update(companyRef, {
        billingStatus:
          currentStatus === "suspended" ?
            "suspended" :
            stillActive ?
              "active" :
              "not_configured",
        billingPendingInvoiceId: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      invoiceId,
      changed: true,
    };
  });
});

/**
 * Updates PolymApp invoice sender and payment settings.
 */
export const updateAdminBillingSettings = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }

  const adminUid = request.auth.uid;
  await requireSystemAdmin(adminUid);

  const settings = validatedIssuerSettings(request.data?.settings);

  await db
    .collection("systemSettings")
    .doc("invoicing")
    .set(
      {
        ...settings,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: adminUid,
      },
      {merge: true},
    );

  return {
    settings,
  };
});

/**
 * Returns a generated invoice PDF for manual sending.
 */
export const getCompanyInvoicePdf = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }

  await requireSystemAdmin(request.auth.uid);

  const invoiceId = normalizeText(request.data?.invoiceId, "", 200);

  if (!invoiceId) {
    throw new HttpsError("invalid-argument", "Die Rechnung fehlt.");
  }

  const invoiceSnapshot = await db
    .collection("companyInvoices")
    .doc(invoiceId)
    .get();

  if (!invoiceSnapshot.exists) {
    throw new HttpsError("not-found", "Die Rechnung wurde nicht gefunden.");
  }

  return buildInvoicePdf(invoiceSnapshot.id, invoiceSnapshot.data() || {});
});
