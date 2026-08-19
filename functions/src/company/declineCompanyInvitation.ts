import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {
  EMAIL_PATTERN,
  INVITATION_ID_PATTERN,
  normalizeEmail,
} from "../shared/validation";

export const declineCompanyInvitation = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const authenticatedEmail = request.auth.token.email;
    const emailVerified =
      request.auth.token.email_verified === true;
    const rawInvitationId: unknown =
      request.data?.invitationId;

    if (
      typeof authenticatedEmail !== "string" ||
      !EMAIL_PATTERN.test(
        normalizeEmail(authenticatedEmail),
      )
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Im Account fehlt eine gültige E-Mail-Adresse.",
      );
    }

    if (!emailVerified) {
      throw new HttpsError(
        "failed-precondition",
        "Die E-Mail-Adresse muss zuerst bestätigt werden.",
      );
    }

    if (
      typeof rawInvitationId !== "string" ||
      !INVITATION_ID_PATTERN.test(rawInvitationId)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Die Einladungs-ID ist ungültig.",
      );
    }

    const uid = request.auth.uid;
    const email = normalizeEmail(authenticatedEmail);
    const invitationId = rawInvitationId;

    const userRef = db.collection("users").doc(uid);
    const invitationRef = db
      .collection("companyInvitations")
      .doc(invitationId);

    return db.runTransaction(async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      const invitationSnapshot =
        await transaction.get(invitationRef);

      if (!userSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Das Benutzerprofil wurde nicht gefunden.",
        );
      }

      if (!invitationSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Einladung wurde nicht gefunden.",
        );
      }

      if (invitationSnapshot.get("status") !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung ist nicht mehr offen.",
        );
      }

      const invitedEmail =
        invitationSnapshot.get("invitedEmail");

      if (
        typeof invitedEmail !== "string" ||
        normalizeEmail(invitedEmail) !== email
      ) {
        throw new HttpsError(
          "permission-denied",
          "Diese Einladung gehört zu einem anderen Account.",
        );
      }

      const companyId =
        invitationSnapshot.get("companyId");

      if (
        typeof companyId !== "string" ||
        companyId.length === 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung enthält keine gültige Firma.",
        );
      }

      const companyRef = db
        .collection("companies")
        .doc(companyId);

      const companySnapshot =
        await transaction.get(companyRef);

      if (!companySnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Firma wurde nicht gefunden.",
        );
      }

      const pendingInvitationCount =
        companySnapshot.get("pendingInvitationCount");

      if (
        !Number.isInteger(pendingInvitationCount) ||
        pendingInvitationCount < 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Anzahl offener Einladungen ist ungültig.",
        );
      }

      const expiresAt =
        invitationSnapshot.get("expiresAt");

      const isExpired =
        !(expiresAt instanceof Timestamp) ||
        expiresAt.toMillis() <= Timestamp.now().toMillis();

      if (isExpired) {
        transaction.update(invitationRef, {
          status: "expired",
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(invitationRef, {
          status: "declined",
          declinedByUid: uid,
          declinedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      transaction.update(companyRef, {
        pendingInvitationCount: Math.max(
          pendingInvitationCount - 1,
          0,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        invitationId,
        companyId,
        status: isExpired ? "expired" : "declined",
      };
    });
  },
);
