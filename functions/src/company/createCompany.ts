import {FieldValue} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {normalizeCompanyBillingDetails} from "../admin/billingConfig";
import {validateBillingDetails} from "./companyBilling";
import {PRICING_VERSION, tariffPrice} from "./companySubscription";
import {queueCompanyNotification} from "../shared/companyNotifications";

export const createCompany = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein, um eine Firma zu erstellen.",
    );
  }

  const authenticatedEmail = request.auth.token.email;

  if (
    typeof authenticatedEmail !== "string" ||
    authenticatedEmail.trim().length === 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Im Account fehlt eine gültige E-Mail-Adresse.",
    );
  }

  if (request.auth.token.email_verified !== true) {
    throw new HttpsError(
      "failed-precondition",
      "Die E-Mail-Adresse muss zuerst bestätigt werden.",
      {reason: "email_not_verified"},
    );
  }

  const rawName: unknown = request.data?.name;

  if (typeof rawName !== "string") {
    throw new HttpsError("invalid-argument", "Der Firmenname fehlt.");
  }

  const companyName = rawName.trim().replace(/\s+/g, " ");

  if (companyName.length < 2 || companyName.length > 80) {
    throw new HttpsError(
      "invalid-argument",
      "Der Firmenname muss zwischen 2 und 80 Zeichen lang sein.",
    );
  }

  const price = tariffPrice(Number(request.data?.seatLimit));
  if (request.data?.pricingVersion !== PRICING_VERSION) {
    throw new HttpsError(
      "failed-precondition",
      "Bitte die Tarifauswahl aktualisieren.",
    );
  }
  const billing = normalizeCompanyBillingDetails(
    request.data?.billingDetails,
  );
  validateBillingDetails(billing);
  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);
  const companyRef = db.collection("companies").doc();
  const memberRef = companyRef.collection("members").doc(uid);
  const memberAdminDataRef = companyRef
    .collection("memberAdminData")
    .doc(uid);
  const memberEmail = authenticatedEmail.trim().toLowerCase();

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const program = await transaction.get(
      db.collection("systemSettings").doc("companyProgram"),
    );
    const paid = program.get("paidEnrollmentEnabled") === true;
    if (paid && request.data?.acceptPaidTerms !== true) {
      throw new HttpsError(
        "failed-precondition",
        "Bitte den kostenpflichtigen Jahrestarif bestätigen.",
      );
    }

    if (!userSnapshot.exists) {
      throw new HttpsError(
        "not-found",
        "Das Benutzerprofil wurde nicht gefunden.",
      );
    }

    const currentCompanyId = userSnapshot.get("companyId");

    if (currentCompanyId !== undefined && currentCompanyId !== null) {
      throw new HttpsError(
        "already-exists",
        "Der Benutzer gehört bereits zu einer Firma.",
      );
    }

    transaction.set(companyRef, {
      name: companyName,
      ownerUid: uid,
      status: "active",
      seatLimit: price.seatLimit,
      accessMode: paid ? "paid" : "pilot",
      billingStatus: paid ? "payment_pending" : "pilot",
      ...(paid ?
        {
          paidTariffAcceptedAt: FieldValue.serverTimestamp(),
          paidTariffAcceptedByUid: uid,
          acceptedPricingVersion: PRICING_VERSION,
        } :
        {}),
      subscriptionRevision: 0,
      activeMemberCount: 1,
      pendingInvitationCount: 0,
      logoPath: null,
      schemaVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.create(
      db.collection("companyBillingDetails").doc(companyRef.id),
      {
        ...billing,
        companyId: companyRef.id,
        reviewedByOwnerUid: uid,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: uid,
      },
    );
    transaction.create(
      db.collection("companySubscriptions").doc(companyRef.id),
      {
        creditBalanceCents: 0,
        revision: 0,
        pendingChange: null,
        pricingVersion: PRICING_VERSION,
        createdAt: FieldValue.serverTimestamp(),
      },
    );
    queueCompanyNotification(
      transaction,
      `created-${companyRef.id}`,
      companyRef.id,
      "Neue Firma erstellt",
      `${companyName} wurde von ${memberEmail} erstellt.\n` +
        `Gebucht: ${price.seatLimit} Plätze; Einführungspreis CHF ` +
        `${(price.annualCents / 100).toFixed(2)} / Jahr.\n` +
        (paid ?
          "Kostenpflichtiges Firmenabo bestätigt: " +
            "Rechnung manuell zustellen.\n" :
          "Kostenlose Aufbauphase: aktuell keine Rechnung oder Forderung.\n") +
        "Rechnungsadresse: " +
        `${billing.invoiceCompanyName || billing.recipientName}, ` +
        `${billing.street}, ${billing.postalCode} ${billing.city}, ` +
        `${billing.country}.\n` +
        `Rechnungs-E-Mail: ${billing.billingEmail}\n` +
        "Administration: https://polymapp.ch/polymapp-admin.html",
    );

    transaction.set(memberRef, {
      role: "owner",
      status: "active",
      addedByUid: uid,
      joinedAt: FieldValue.serverTimestamp(),
    });

    transaction.set(memberAdminDataRef, {
      memberUid: uid,
      email: memberEmail,
      firstName: "",
      lastName: "",
      department: "",
      employmentStatus: "",
      notes: "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: uid,
    });

    transaction.update(userRef, {
      companyId: companyRef.id,
      companyJoinedAt: FieldValue.serverTimestamp(),
    });

    return {
      companyId: companyRef.id,
      name: companyName,
      role: "owner",
      seatLimit: price.seatLimit,
    };
  });
});
