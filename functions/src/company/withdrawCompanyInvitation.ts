import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {
  INVITATION_ID_PATTERN,
  isInvitationRole,
} from "../shared/validation";

export const withdrawCompanyInvitation = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const rawInvitationId: unknown =
      request.data?.invitationId;

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

      const companyId = userSnapshot.get("companyId");
      const invitationCompanyId =
        invitationSnapshot.get("companyId");

      if (
        typeof companyId !== "string" ||
        companyId.length === 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Der Benutzer gehört keiner Firma an.",
        );
      }

      if (invitationCompanyId !== companyId) {
        throw new HttpsError(
          "permission-denied",
          "Die Einladung gehört zu einer anderen Firma.",
        );
      }

      if (invitationSnapshot.get("status") !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung ist nicht mehr offen.",
        );
      }

      const companyRef = db
        .collection("companies")
        .doc(companyId);

      const memberRef = companyRef
        .collection("members")
        .doc(uid);

      const companySnapshot =
        await transaction.get(companyRef);
      const memberSnapshot =
        await transaction.get(memberRef);

      if (!companySnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Firma wurde nicht gefunden.",
        );
      }

      if (!memberSnapshot.exists) {
        throw new HttpsError(
          "permission-denied",
          "Die Firmenmitgliedschaft wurde nicht gefunden.",
        );
      }

      if (memberSnapshot.get("status") !== "active") {
        throw new HttpsError(
          "permission-denied",
          "Die Mitgliedschaft ist nicht aktiv.",
        );
      }

      const callerRole = memberSnapshot.get("role");
      const isOwner = callerRole === "owner";
      const isAdmin = callerRole === "admin";

      if (!isOwner && !isAdmin) {
        throw new HttpsError(
          "permission-denied",
          "Du darfst keine Einladungen zurückziehen.",
        );
      }

      const invitationRole =
        invitationSnapshot.get("role");

      if (!isInvitationRole(invitationRole)) {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung enthält keine gültige Rolle.",
        );
      }

      if (isAdmin && invitationRole === "admin") {
        throw new HttpsError(
          "permission-denied",
          "Nur der Owner darf Admin-Einladungen verwalten.",
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
          status: "withdrawn",
          withdrawnByUid: uid,
          withdrawnAt: FieldValue.serverTimestamp(),
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
        status: isExpired ? "expired" : "withdrawn",
      };
    });
  },
);
