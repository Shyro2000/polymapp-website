import {FieldValue} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {
  CompanyBillingDetails,
  normalizeCompanyBillingDetails,
} from "../admin/billingConfig";

interface OwnerContext {
  companyId: string;
  companyName: string;
  email: string;
}

/**
 * Loads and verifies the caller's owner context.
 * @param {string} uid Firebase Authentication uid.
 * @param {unknown} authenticatedEmail Authentication email.
 * @return {Promise<OwnerContext>} Verified owner context.
 */
async function getOwnerContext(
  uid: string,
  authenticatedEmail: unknown,
): Promise<OwnerContext> {
  const userRef = db.collection("users").doc(uid);
  const userSnapshot = await userRef.get();

  if (!userSnapshot.exists) {
    throw new HttpsError(
      "not-found",
      "Das Benutzerprofil wurde nicht gefunden.",
    );
  }

  const companyId = userSnapshot.get("companyId");

  if (
    typeof companyId !== "string" ||
    companyId.length === 0
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Der Benutzer gehört keiner Firma an.",
    );
  }

  const companyRef = db
    .collection("companies")
    .doc(companyId);
  const memberRef = companyRef
    .collection("members")
    .doc(uid);

  const [
    companySnapshot,
    memberSnapshot,
  ] = await Promise.all([
    companyRef.get(),
    memberRef.get(),
  ]);

  if (!companySnapshot.exists) {
    throw new HttpsError(
      "not-found",
      "Die Firma wurde nicht gefunden.",
    );
  }

  if (
    companySnapshot.get("ownerUid") !== uid ||
    !memberSnapshot.exists ||
    memberSnapshot.get("status") !== "active" ||
    memberSnapshot.get("role") !== "owner"
  ) {
    throw new HttpsError(
      "permission-denied",
      "Nur der Inhaber darf Rechnungsdaten einsehen oder ändern.",
    );
  }

  const companyName = companySnapshot.get("name");

  return {
    companyId,
    companyName:
      typeof companyName === "string" ?
        companyName :
        "",
    email:
      typeof authenticatedEmail === "string" ?
        authenticatedEmail.trim().toLowerCase() :
        "",
  };
}

/**
 * Validates an optional email address.
 * @param {CompanyBillingDetails} details Rechnungsdaten.
 */
function validateBillingDetails(
  details: CompanyBillingDetails,
): void {
  if (
    !details.invoiceCompanyName &&
    !details.recipientName
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Bitte Firma oder Name/Ansprechpartner angeben.",
    );
  }

  if (!details.street) {
    throw new HttpsError(
      "invalid-argument",
      "Strasse und Hausnummer sind erforderlich.",
    );
  }

  if (!details.postalCode) {
    throw new HttpsError(
      "invalid-argument",
      "Die PLZ ist erforderlich.",
    );
  }

  if (!details.city) {
    throw new HttpsError(
      "invalid-argument",
      "Der Ort ist erforderlich.",
    );
  }

  if (!details.country) {
    throw new HttpsError(
      "invalid-argument",
      "Das Land ist erforderlich.",
    );
  }

  if (!details.billingEmail) {
    throw new HttpsError(
      "invalid-argument",
      "Die Rechnungs-E-Mail-Adresse ist erforderlich.",
    );
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      details.billingEmail,
    )
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Die Rechnungs-E-Mail-Adresse ist ungültig.",
    );
  }
}

/**
 * Returns the owner-only company billing details.
 */
export const getCompanyBillingDetails = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const uid = request.auth.uid;
    const context = await getOwnerContext(
      uid,
      request.auth.token.email,
    );

    const billingRef = db
      .collection("companyBillingDetails")
      .doc(context.companyId);
    const billingSnapshot = await billingRef.get();

    const details = normalizeCompanyBillingDetails(
      billingSnapshot.exists ?
        billingSnapshot.data() :
        null,
      context.companyName,
      context.email,
    );

    return {
      companyId: context.companyId,
      details,
      needsReview:
        details.reviewedByOwnerUid !== uid,
    };
  },
);

/**
 * Saves owner-only company billing details.
 */
export const updateCompanyBillingDetails = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const uid = request.auth.uid;
    const context = await getOwnerContext(
      uid,
      request.auth.token.email,
    );

    const details = normalizeCompanyBillingDetails(
      request.data?.details,
      "",
      "",
    );
    validateBillingDetails(details);

    const savedDetails: CompanyBillingDetails = {
      ...details,
      reviewedByOwnerUid: uid,
    };

    const billingRef = db
      .collection("companyBillingDetails")
      .doc(context.companyId);

    await billingRef.set(
      {
        companyId: context.companyId,
        ...savedDetails,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: uid,
      },
      {merge: true},
    );

    return {
      companyId: context.companyId,
      details: savedDetails,
      needsReview: false,
    };
  },
);
