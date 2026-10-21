import {
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";
import {
  HttpsError,
  onCall,
} from "firebase-functions/https";
import {db} from "../firebase";

const PRICE_TIERS = new Map<number, number>([
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

/**
 * Verifies that the caller is a PolymApp system admin.
 * @param {string} uid Firebase Authentication uid.
 * @return {Promise<void>} Resolves for authorized admins.
 */
async function requireSystemAdmin(uid: string): Promise<void> {
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
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} ist ungültig.`,
    );
  }

  const time = endOfDay ?
    "23:59:59.999" :
    "00:00:00.000";
  const date = new Date(`${value}T${time}Z`);

  if (Number.isNaN(date.getTime())) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} ist ungültig.`,
    );
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
 * Returns the annual amount for a supported seat tier.
 * @param {number} seatLimit Booked seats.
 * @return {{monthlyRate: number, annualAmount: number}} Pricing.
 */
function pricingForSeatLimit(
  seatLimit: number,
): {
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

  const annualAmount =
    Math.round(seatLimit * monthlyRate * 12 * 100) / 100;

  return {
    monthlyRate,
    annualAmount,
  };
}

/**
 * Reads and trims an optional short text value.
 * @param {unknown} value Raw value.
 * @param {number} maxLength Maximum allowed length.
 * @return {string} Sanitized string.
 */
function optionalText(
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
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

export const createCompanyInvoice = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein.",
    );
  }

  const adminUid = request.auth.uid;
  await requireSystemAdmin(adminUid);

  const companyId = optionalText(
    request.data?.companyId,
    200,
  );

  if (!companyId) {
    throw new HttpsError(
      "invalid-argument",
      "Die Firma fehlt.",
    );
  }

  const periodStartAt = parseDate(
    request.data?.periodStart,
    "Der Leistungsbeginn",
  );
  const dueAt = parseDate(
    request.data?.dueDate,
    "Das Fälligkeitsdatum",
    true,
  );
  const periodEndAt = annualPeriodEnd(periodStartAt);
  const reference = optionalText(
    request.data?.reference,
    120,
  );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  if (dueAt.toMillis() < today.getTime()) {
    throw new HttpsError(
      "invalid-argument",
      "Das Fälligkeitsdatum darf nicht in der Vergangenheit liegen.",
    );
  }

  const companyRef = db
    .collection("companies")
    .doc(companyId);
  const invoiceRef = db
    .collection("companyInvoices")
    .doc();
  const invoicesQuery = db
    .collection("companyInvoices")
    .where("companyId", "==", companyId);

  const periodYear =
    periodStartAt.toDate().getUTCFullYear();
  const counterRef = db
    .collection("systemCounters")
    .doc(`companyInvoices-${periodYear}`);

  return db.runTransaction(async (transaction) => {
    const [
      companySnapshot,
      invoicesSnapshot,
      counterSnapshot,
    ] = await Promise.all([
      transaction.get(companyRef),
      transaction.get(invoicesQuery),
      transaction.get(counterRef),
    ]);

    if (!companySnapshot.exists) {
      throw new HttpsError(
        "not-found",
        "Die Firma wurde nicht gefunden.",
      );
    }

    if (companySnapshot.get("status") !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "Nur aktive Firmen können verrechnet werden.",
      );
    }

    for (const existingInvoice of invoicesSnapshot.docs) {
      const status = existingInvoice.get("status");
      const existingStart =
        existingInvoice.get("periodStartAt");
      const existingEnd =
        existingInvoice.get("periodEndAt");

      if (
        status !== "cancelled" &&
        existingStart instanceof Timestamp &&
        existingEnd instanceof Timestamp &&
        periodsOverlap(
          periodStartAt,
          periodEndAt,
          existingStart,
          existingEnd,
        )
      ) {
        throw new HttpsError(
          "already-exists",
          "Für diesen Leistungszeitraum besteht bereits eine Rechnung.",
        );
      }
    }

    const name = companySnapshot.get("name");
    const seatLimit = companySnapshot.get("seatLimit");

    if (
      typeof seatLimit !== "number" ||
      !Number.isFinite(seatLimit)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Die Firma hat keinen gültigen Tarif.",
      );
    }

    const pricing = pricingForSeatLimit(seatLimit);

    const currentSequence =
      counterSnapshot.exists &&
      typeof counterSnapshot.get("sequence") === "number" ?
        counterSnapshot.get("sequence") :
        0;
    const nextSequence = currentSequence + 1;
    const invoiceNumber =
      `PA-${periodYear}-${String(nextSequence).padStart(5, "0")}`;

    const currentBillingStatus =
      companySnapshot.get("billingStatus");
    const billingValidUntil =
      companySnapshot.get("billingValidUntil");
    const now = Timestamp.now();

    const currentlyActive =
      billingValidUntil instanceof Timestamp &&
      billingValidUntil.toMillis() >= now.toMillis();

    let nextBillingStatus =
      currentlyActive ? "active" : "payment_pending";

    if (currentBillingStatus === "suspended") {
      nextBillingStatus = "suspended";
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
      companyName:
        typeof name === "string" ? name : "",
      seatLimit,
      monthlyRate: pricing.monthlyRate,
      annualAmount: pricing.annualAmount,
      currency: "CHF",
      periodStartAt,
      periodEndAt,
      dueAt,
      reference,
      status: "open",
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: adminUid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(companyRef, {
      billingPendingInvoiceId: invoiceRef.id,
      billingStatus: nextBillingStatus,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      invoiceId: invoiceRef.id,
      invoiceNumber,
      companyId,
      annualAmount: pricing.annualAmount,
    };
  });
});

export const markCompanyInvoicePaid = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const adminUid = request.auth.uid;
    await requireSystemAdmin(adminUid);

    const invoiceId = optionalText(
      request.data?.invoiceId,
      200,
    );
    const paymentReference = optionalText(
      request.data?.paymentReference,
      120,
    );

    if (!invoiceId) {
      throw new HttpsError(
        "invalid-argument",
        "Die Rechnung fehlt.",
      );
    }

    const invoiceRef = db
      .collection("companyInvoices")
      .doc(invoiceId);

    return db.runTransaction(async (transaction) => {
      const invoiceSnapshot =
        await transaction.get(invoiceRef);

      if (!invoiceSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Rechnung wurde nicht gefunden.",
        );
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

      const companyId =
        invoiceSnapshot.get("companyId");
      const periodEndAt =
        invoiceSnapshot.get("periodEndAt");

      if (
        typeof companyId !== "string" ||
        !(periodEndAt instanceof Timestamp)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Rechnungsdaten sind unvollständig.",
        );
      }

      const companyRef = db
        .collection("companies")
        .doc(companyId);
      const companySnapshot =
        await transaction.get(companyRef);

      transaction.update(invoiceRef, {
        status: "paid",
        paymentReference,
        paidAt: FieldValue.serverTimestamp(),
        paidByUid: adminUid,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (companySnapshot.exists) {
        const currentValidUntil =
          companySnapshot.get("billingValidUntil");
        const currentValidUntilMs =
          currentValidUntil instanceof Timestamp ?
            currentValidUntil.toMillis() :
            0;
        const invoiceValidUntilMs =
          periodEndAt.toMillis();

        const effectiveValidUntil =
          invoiceValidUntilMs >= currentValidUntilMs ?
            periodEndAt :
            currentValidUntil;

        if (effectiveValidUntil instanceof Timestamp) {
          const companyUpdate: Record<string, unknown> = {
            billingStatus:
              effectiveValidUntil.toMillis() >=
              Timestamp.now().toMillis() ?
                "active" :
                "not_configured",
            billingValidUntil: effectiveValidUntil,
            billingLastPaidAt:
              FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          };

          if (invoiceValidUntilMs >= currentValidUntilMs) {
            companyUpdate.billingInvoiceId = invoiceId;
          }

          if (
            companySnapshot.get("billingPendingInvoiceId") ===
            invoiceId
          ) {
            companyUpdate.billingPendingInvoiceId =
              FieldValue.delete();
          }

          transaction.update(companyRef, companyUpdate);
        }
      }

      return {
        invoiceId,
        changed: true,
      };
    });
  },
);

export const cancelCompanyInvoice = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const adminUid = request.auth.uid;
    await requireSystemAdmin(adminUid);

    const invoiceId = optionalText(
      request.data?.invoiceId,
      200,
    );

    if (!invoiceId) {
      throw new HttpsError(
        "invalid-argument",
        "Die Rechnung fehlt.",
      );
    }

    const invoiceRef = db
      .collection("companyInvoices")
      .doc(invoiceId);

    return db.runTransaction(async (transaction) => {
      const invoiceSnapshot =
        await transaction.get(invoiceRef);

      if (!invoiceSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Rechnung wurde nicht gefunden.",
        );
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

      const companyId =
        invoiceSnapshot.get("companyId");
      const companyRef =
        typeof companyId === "string" ?
          db.collection("companies").doc(companyId) :
          null;
      const companySnapshot = companyRef ?
        await transaction.get(companyRef) :
        null;

      transaction.update(invoiceRef, {
        status: "cancelled",
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledByUid: adminUid,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (
        companyRef &&
        companySnapshot?.exists &&
        companySnapshot.get("billingPendingInvoiceId") ===
          invoiceId
      ) {
        const validUntil =
          companySnapshot.get("billingValidUntil");
        const stillActive =
          validUntil instanceof Timestamp &&
          validUntil.toMillis() >=
            Timestamp.now().toMillis();
        const currentStatus =
          companySnapshot.get("billingStatus");

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
  },
);
