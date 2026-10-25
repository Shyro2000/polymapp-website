import {createHash} from "node:crypto";
import {
  DocumentSnapshot,
  FieldValue,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {PRICE_TIERS} from "../admin/billingConfig";
import {hasCompanyAccess} from "../shared/companyAccess";
import {queueCompanyNotification} from "../shared/companyNotifications";
import {
  applyCredit,
  proratedDelta,
  ServicePeriod,
  utcDay,
} from "./tariffMath";

export const PRICING_VERSION = "intro-1";
export const PILOT_NOTICE =
  "Die Einführung des kostenpflichtigen Firmenabos " +
  "steht noch aus. Ein Starttermin ist noch nicht festgelegt. Sobald das " +
  "Einführungsdatum feststeht, informieren wir Sie frühzeitig. " +
  "Bis dahin entstehen keine Kosten.";

/**
 * Returns validated current catalogue prices in integer rappen.
 * @param {number} seatLimit Requested number of seats.
 * @return {*} Calculated result or verified server context.
 */
export function tariffPrice(seatLimit: number): {
  seatLimit: number;
  monthlyRate: number;
  annualCents: number;
} {
  const monthlyRate = PRICE_TIERS.get(seatLimit);
  if (monthlyRate === undefined) {
    throw new HttpsError(
      "invalid-argument",
      "Bitte eine gültige Tarifstufe wählen.",
    );
  }
  return {
    seatLimit,
    monthlyRate,
    annualCents: Math.round(seatLimit * monthlyRate * 1200),
  };
}

/**
 * Reads prepaid periods, including unchanged legacy annual invoices.
 * @param {Transaction} tx Transaction containing the related reads and writes.
 * @param {string} companyId Validated company identifier.
 * @return {*} Calculated result or verified server context.
 */
export async function readServicePeriods(
  tx: Transaction,
  companyId: string,
): Promise<ServicePeriod[]> {
  const [invoices, overrides] = await Promise.all([
    tx.get(
      db.collection("companyInvoices").where("companyId", "==", companyId),
    ),
    tx.get(
      db
        .collection("companySubscriptions")
        .doc(companyId)
        .collection("periods"),
    ),
  ]);
  const changes = new Map(overrides.docs.map((doc) => [doc.id, doc.data()]));
  return invoices.docs.flatMap((doc) => {
    if (doc.get("status") !== "paid" || doc.get("kind") === "tariff_change") {
      return [];
    }
    const data = changes.get(doc.id) || doc.data();
    const start =
      data.startAt || data.activatedPeriodStartAt || data.periodStartAt;
    const end = data.endAt || data.activatedPeriodEndAt || data.periodEndAt;
    if (!(start instanceof Timestamp) || !(end instanceof Timestamp)) {
      return [];
    }
    return [
      {
        id: doc.id,
        startMs: start.toMillis(),
        endMs: end.toMillis(),
        annualCents: Number(
          data.annualCents ??
            Math.round(Number(doc.get("annualAmount") || 0) * 100),
        ),
        seatLimit: Number(data.seatLimit || doc.get("seatLimit")),
      },
    ];
  });
}

/**
 * Updates remaining service entitlements; historical invoice values stay
 * intact.
 * @param {Transaction} tx Transaction containing the related reads and writes.
 * @param {string} companyId Validated company identifier.
 * @param {ServicePeriod[]} periods Prepaid service periods and their
 * locked prices.
 * @param {number} targetSeatLimit Requested number of seats.
 * @param {number} targetAnnualCents Annual tariff price in integer rappen.
 */
export function writeServicePeriods(
  tx: Transaction,
  companyId: string,
  periods: ServicePeriod[],
  targetSeatLimit: number,
  targetAnnualCents: number,
): void {
  for (const period of periods) {
    if (period.endMs < Date.now()) continue;
    tx.set(
      db
        .collection("companySubscriptions")
        .doc(companyId)
        .collection("periods")
        .doc(period.id),
      {
        startAt: Timestamp.fromMillis(period.startMs),
        endAt: Timestamp.fromMillis(period.endMs),
        seatLimit: targetSeatLimit,
        annualCents: targetAnnualCents,
        updatedAt: FieldValue.serverTimestamp(),
      },
    );
  }
}

/**
 * Verifies current membership inside the same transaction as financial changes.
 * @param {Transaction} tx Transaction containing the related reads and writes.
 * @param {string} uid Authenticated caller identifier.
 * @param {boolean} ownerOnly Whether to require the current company owner.
 * @return {*} Calculated result or verified server context.
 */
async function memberContext(
  tx: Transaction,
  uid: string,
  ownerOnly: boolean,
) {
  const user = await tx.get(db.collection("users").doc(uid));
  const companyId = user.get("companyId");
  if (typeof companyId !== "string" || !/^[\w-]{1,128}$/.test(companyId)) {
    throw new HttpsError(
      "failed-precondition",
      "Keine Firmenmitgliedschaft.",
    );
  }
  const ref = db.collection("companies").doc(companyId);
  const [company, member, subscription] = await Promise.all([
    tx.get(ref),
    tx.get(ref.collection("members").doc(uid)),
    tx.get(db.collection("companySubscriptions").doc(companyId)),
  ]);
  if (
    !company.exists ||
    company.get("status") !== "active" ||
    member.get("status") !== "active"
  ) {
    throw new HttpsError("permission-denied", "Keine aktive Mitgliedschaft.");
  }
  const isOwner =
    member.get("role") === "owner" && company.get("ownerUid") === uid;
  if (ownerOnly && !isOwner) {
    throw new HttpsError(
      "permission-denied",
      "Nur der Inhaber darf den Tarif ändern.",
    );
  }
  return {companyId, company, member, subscription, isOwner};
}

/**
 * Builds a versioned quotation exclusively from server data.
 * @param {Transaction} tx Transaction containing the related reads and writes.
 * @param {DocumentSnapshot} company Company document or its stored fields.
 * @param {DocumentSnapshot} subscription Private subscription document.
 * @param {number} target Requested seat tier.
 * @return {*} Calculated result or verified server context.
 */
async function buildQuote(
  tx: Transaction,
  company: DocumentSnapshot,
  subscription: DocumentSnapshot,
  target: number,
) {
  const price = tariffPrice(target);
  const [members, invitations, periods] = await Promise.all([
    tx.get(company.ref.collection("members").where("status", "==", "active")),
    tx.get(
      db
        .collection("companyInvitations")
        .where("companyId", "==", company.id),
    ),
    readServicePeriods(tx, company.id),
  ]);
  const nowMs = Date.now();
  const reserved =
    members.size +
    invitations.docs.filter(
      (doc) =>
        doc.get("status") === "pending" &&
        doc.get("expiresAt") instanceof Timestamp &&
        doc.get("expiresAt").toMillis() > nowMs,
    ).length;
  if (target < reserved) {
    throw new HttpsError(
      "failed-precondition",
      "Die Tarifstufe ist kleiner als die belegten oder reservierten Plätze.",
      {reason: "seats_occupied", reservedSeats: reserved},
    );
  }
  if (
    company.get("billingPendingInvoiceId") ||
    subscription.get("pendingChange")
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Bitte zuerst die offene Rechnung oder Tarifänderung abschliessen.",
      {reason: "billing_change_pending"},
    );
  }
  const pilot = company.get("accessMode") === "pilot";
  const current = Number(company.get("seatLimit"));
  if (
    !pilot &&
    hasCompanyAccess(company.data() || {}) &&
    !periods.some((p) => p.endMs >= nowMs)
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Für diese Laufzeit fehlt der bezahlte " +
          "Leistungsnachweis. Bitte PolymApp kontaktieren.",
    );
  }
  const deltaCents =
    pilot || current === target ?
      0 :
      proratedDelta(periods, price.annualCents, nowMs);
  const balanceCents = Number(subscription.get("creditBalanceCents") || 0);
  const credit = applyCredit(Math.max(0, deltaCents), balanceCents);
  const quote = {
    targetSeatLimit: target,
    monthlyRate: price.monthlyRate,
    annualCents: price.annualCents,
    deltaCents,
    ...credit,
    creditAddedCents: Math.max(0, -deltaCents),
    pilot,
    balanceCents,
    reservedSeats: reserved,
    activeMemberCount: members.size,
    pendingInvitationCount: reserved - members.size,
    effectiveDayMs: utcDay(nowMs),
    pricingVersion: PRICING_VERSION,
  };
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        ...quote,
        companyId: company.id,
        current,
        revision: subscription.get("revision") || 0,
        periods: [...periods].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
  return {...quote, quoteToken: token, periods};
}

export const getCompanyTariffs = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  const program = await db
    .collection("systemSettings")
    .doc("companyProgram")
    .get();
  return {
    pricingVersion: PRICING_VERSION,
    notice: PILOT_NOTICE,
    paidEnrollmentEnabled: program.get("paidEnrollmentEnabled") === true,
    tariffs: [...PRICE_TIERS.keys()].map(tariffPrice),
  };
});

export const getCompanySubscription = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  const uid = request.auth.uid;
  return db.runTransaction(async (tx) => {
    const ctx = await memberContext(tx, uid, false);
    const program = await tx.get(
      db.collection("systemSettings").doc("companyProgram"),
    );
    const data = ctx.company.data() || {};
    const status =
      data.billingStatus === "suspended" ?
        "suspended" :
        data.accessMode === "pilot" && hasCompanyAccess(data) ?
          "pilot" :
          hasCompanyAccess(data) ?
            "active" :
            data.billingPendingInvoiceId ||
                data.billingStatus === "payment_pending" ?
              "payment_pending" :
              "expired";
    const basic = {
      isOwner: ctx.isOwner,
      role: ctx.member.get("role"),
      status,
      accessActive: hasCompanyAccess(data),
      seatLimit: data.seatLimit,
      activeMemberCount: data.activeMemberCount,
      validUntilMs:
        data.billingValidUntil instanceof Timestamp ?
          data.billingValidUntil.toMillis() :
          null,
    };
    if (!ctx.isOwner) {
      if (ctx.member.get("role") === "admin") return basic;
      return {isOwner: false, role: ctx.member.get("role"),
        accessActive: basic.accessActive};
    }
    const invoices = await tx.get(
      db
        .collection("companyInvoices")
        .where("companyId", "==", ctx.companyId),
    );
    const ledger = await tx.get(
      ctx.subscription.ref
        .collection("ledger")
        .orderBy("createdAt", "desc")
        .limit(20),
    );
    return {
      ...basic,
      ...tariffPrice(Number(data.seatLimit)),
      pricingVersion: PRICING_VERSION,
      notice: PILOT_NOTICE,
      paidEnrollmentEnabled: program.get("paidEnrollmentEnabled") === true,
      creditBalanceCents: Number(
        ctx.subscription.get("creditBalanceCents") || 0,
      ),
      pendingChange: ctx.subscription.get("pendingChange") || null,
      ledger: ledger.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAtMs: doc.get("createdAt")?.toMillis?.() || 0,
      })),
      invoices: invoices.docs.map((doc) => ({
        id: doc.id,
        invoiceNumber: doc.get("invoiceNumber"),
        status:
          doc.get("status") === "open" &&
          doc.get("dueAt") instanceof Timestamp &&
          doc.get("dueAt").toMillis() < Date.now() ?
            "overdue" :
            doc.get("status"),
        amountCents: Math.round(Number(doc.get("annualAmount") || 0) * 100),
        creditUsedCents: doc.get("creditUsedCents") || 0,
        dueDate: doc.get("dueDate") || "",
        settledByCredit: doc.get("settledByCredit") === true,
      })),
    };
  });
});

export const quoteCompanyTariff = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  const uid = request.auth.uid;
  return db.runTransaction(async (tx) => {
    const ctx = await memberContext(tx, uid, true);
    const quote = await buildQuote(
      tx,
      ctx.company,
      ctx.subscription,
      Number(request.data?.seatLimit),
    );
    const publicQuote: Record<string, unknown> = {...quote};
    delete publicQuote.periods;
    return publicQuote;
  });
});

export const changeCompanyTariff = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  const uid = request.auth.uid;
  const requestId = request.data?.requestId;
  if (
    typeof requestId !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)
  ) {
    throw new HttpsError("invalid-argument", "Ungültige Vorgangsnummer.");
  }
  return db.runTransaction(async (tx) => {
    const ctx = await memberContext(tx, uid, true);
    const operation = ctx.subscription.ref
      .collection("operations")
      .doc(requestId);
    const previous = await tx.get(operation);
    if (previous.exists) return previous.get("result");
    const quote = await buildQuote(
      tx,
      ctx.company,
      ctx.subscription,
      Number(request.data?.seatLimit),
    );
    if (quote.quoteToken !== request.data?.quoteToken) {
      throw new HttpsError(
        "aborted",
        "Die Vorschau ist veraltet. Bitte neu berechnen.",
        {reason: "quote_expired"},
      );
    }
    const unchanged = ctx.company.get("seatLimit") === quote.targetSeatLimit;
    const pending = !unchanged && quote.amountDueCents > 0;
    const result = {pending, changed: !unchanged};
    if (unchanged) return result;
    const remainingBalance =
      quote.balanceCents - quote.creditUsedCents + quote.creditAddedCents;
    const pendingChange = pending ?
      {
        requestId,
        targetSeatLimit: quote.targetSeatLimit,
        oldSeatLimit: ctx.company.get("seatLimit"),
        deltaCents: quote.deltaCents,
        creditUsedCents: quote.creditUsedCents,
        amountDueCents: quote.amountDueCents,
        effectiveDayMs: quote.effectiveDayMs,
        pricingVersion: PRICING_VERSION,
      } :
      null;
    tx.set(
      ctx.subscription.ref,
      {
        creditBalanceCents: remainingBalance,
        revision: FieldValue.increment(1),
        pendingChange,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    if (!pending) {
      tx.update(ctx.company.ref, {
        seatLimit: quote.targetSeatLimit,
        activeMemberCount: quote.activeMemberCount,
        pendingInvitationCount: quote.pendingInvitationCount,
        subscriptionRevision: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      writeServicePeriods(
        tx,
        ctx.companyId,
        quote.periods,
        quote.targetSeatLimit,
        quote.annualCents,
      );
    } else {
      tx.update(ctx.company.ref, {
        subscriptionRevision: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      queueCompanyNotification(
        tx,
        `tariff-${ctx.companyId}-${requestId}`,
        ctx.companyId,
        "Tariferhöhung angefragt",
        `${ctx.company.get("name")}: ${ctx.company.get("seatLimit")} → ` +
          `${quote.targetSeatLimit} Plätze. Offener Betrag CHF ` +
          `${(quote.amountDueCents / 100).toFixed(2)}. ` +
          "Rechnung manuell erstellen.",
      );
    }
    if (quote.creditAddedCents || quote.creditUsedCents) {
      tx.create(ctx.subscription.ref.collection("ledger").doc(requestId), {
        kind: pending ? "credit_reserved" : "tariff_change",
        amountCents: quote.creditAddedCents - quote.creditUsedCents,
        targetSeatLimit: quote.targetSeatLimit,
        createdByUid: uid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.create(operation, {result, createdAt: FieldValue.serverTimestamp()});
    return result;
  });
});

export const requestPaidCompanySubscription = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  const uid = request.auth.uid;
  if (
    request.data?.acceptPaidTerms !== true ||
    request.data?.pricingVersion !== PRICING_VERSION
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Bitte den Jahrestarif bestätigen.",
    );
  }
  return db.runTransaction(async (tx) => {
    const ctx = await memberContext(tx, uid, true);
    const program = await tx.get(
      db.collection("systemSettings").doc("companyProgram"),
    );
    if (program.get("paidEnrollmentEnabled") !== true) {
      throw new HttpsError(
        "failed-precondition",
        "Das kostenpflichtige Firmenabo " + "wurde noch nicht eingeführt.",
      );
    }
    if (ctx.company.get("accessMode") === "paid") return {changed: false};
    const price = tariffPrice(Number(ctx.company.get("seatLimit")));
    tx.update(ctx.company.ref, {
      accessMode: "paid",
      billingStatus: "payment_pending",
      paidTariffAcceptedAt: FieldValue.serverTimestamp(),
      paidTariffAcceptedByUid: uid,
      acceptedPricingVersion: PRICING_VERSION,
      updatedAt: FieldValue.serverTimestamp(),
    });
    queueCompanyNotification(
      tx,
      `paid-${ctx.companyId}`,
      ctx.companyId,
      "Firmenabo zur Verrechnung bestätigt",
      `${ctx.company.get("name")}: ` +
        `${price.seatLimit} Plätze, CHF ` +
        `${(price.annualCents / 100).toFixed(2)} pro Jahr. ` +
        "Bitte Rechnung erstellen und manuell zustellen.",
    );
    return {changed: true};
  });
});

export const cancelPendingCompanyTariff = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  const uid = request.auth.uid;
  return db.runTransaction(async (tx) => {
    const ctx = await memberContext(tx, uid, true);
    const pending = ctx.subscription.get("pendingChange");
    if (!pending) return {changed: false};
    if (ctx.company.get("billingPendingInvoiceId")) {
      throw new HttpsError(
        "failed-precondition",
        "Bitte die Rechnung durch PolymApp stornieren lassen.",
      );
    }
    const restored = Number(pending.creditUsedCents || 0);
    tx.set(
      ctx.subscription.ref,
      {
        pendingChange: null,
        creditBalanceCents:
          Number(ctx.subscription.get("creditBalanceCents") || 0) + restored,
        revision: FieldValue.increment(1),
      },
      {merge: true},
    );
    if (restored) {
      tx.create(
        ctx.subscription.ref
          .collection("ledger")
          .doc(`withdrawn-${pending.requestId}`),
        {
          kind: "credit_restored",
          amountCents: restored,
          createdAt: FieldValue.serverTimestamp(),
        },
      );
    }
    tx.update(ctx.company.ref, {
      subscriptionRevision: FieldValue.increment(1),
    });
    return {changed: true};
  });
});
