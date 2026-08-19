import {FieldValue} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

export const removeCompanyMember = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const rawTargetUid: unknown =
      request.data?.targetUid;

    if (
      typeof rawTargetUid !== "string" ||
      rawTargetUid.length < 1 ||
      rawTargetUid.length > 128
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Die Benutzer-ID ist ungültig.",
      );
    }

    const callerUid = request.auth.uid;
    const targetUid = rawTargetUid;

    if (callerUid === targetUid) {
      throw new HttpsError(
        "invalid-argument",
        "Verwende zum Austreten die Austrittsfunktion.",
      );
    }

    const callerUserRef = db
      .collection("users")
      .doc(callerUid);

    const targetUserRef = db
      .collection("users")
      .doc(targetUid);

    return db.runTransaction(async (transaction) => {
      const callerUserSnapshot =
        await transaction.get(callerUserRef);

      if (!callerUserSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Das Benutzerprofil wurde nicht gefunden.",
        );
      }

      const companyId =
        callerUserSnapshot.get("companyId");

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

      const callerMemberRef = companyRef
        .collection("members")
        .doc(callerUid);

      const targetMemberRef = companyRef
        .collection("members")
        .doc(targetUid);

      const targetAdminDataRef = companyRef
        .collection("memberAdminData")
        .doc(targetUid);

      const companySnapshot =
        await transaction.get(companyRef);

      const callerMemberSnapshot =
        await transaction.get(callerMemberRef);

      const targetMemberSnapshot =
        await transaction.get(targetMemberRef);

      const targetUserSnapshot =
        await transaction.get(targetUserRef);

      if (!companySnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Firma wurde nicht gefunden.",
        );
      }

      if (companySnapshot.get("status") !== "active") {
        throw new HttpsError(
          "failed-precondition",
          "Die Firma ist nicht aktiv.",
        );
      }

      if (
        !callerMemberSnapshot.exists ||
        callerMemberSnapshot.get("status") !== "active"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Die eigene Mitgliedschaft ist nicht aktiv.",
        );
      }

      if (
        !targetMemberSnapshot.exists ||
        targetMemberSnapshot.get("status") !== "active"
      ) {
        throw new HttpsError(
          "not-found",
          "Das aktive Firmenmitglied wurde nicht gefunden.",
        );
      }

      if (!targetUserSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Das Benutzerprofil des Mitglieds fehlt.",
        );
      }

      if (targetUserSnapshot.get("companyId") !== companyId) {
        throw new HttpsError(
          "failed-precondition",
          "Der Benutzer gehört nicht zu dieser Firma.",
        );
      }

      const ownerUid = companySnapshot.get("ownerUid");
      const callerRole =
        callerMemberSnapshot.get("role");
      const targetRole =
        targetMemberSnapshot.get("role");

      const callerIsOwner =
        callerRole === "owner" &&
        callerUid === ownerUid;

      const callerIsAdmin =
        callerRole === "admin";

      if (!callerIsOwner && !callerIsAdmin) {
        throw new HttpsError(
          "permission-denied",
          "Du darfst keine Mitglieder entfernen.",
        );
      }

      if (
        targetUid === ownerUid ||
        targetRole === "owner"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Der Owner kann nicht entfernt werden.",
        );
      }

      if (
        callerIsAdmin &&
        targetRole !== "editor" &&
        targetRole !== "viewer"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Admins dürfen keine Admins entfernen.",
        );
      }

      const activeMemberCount =
        companySnapshot.get("activeMemberCount");

      if (
        !Number.isInteger(activeMemberCount) ||
        activeMemberCount <= 1
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Mitgliederzahl der Firma ist ungültig.",
        );
      }

      transaction.delete(targetMemberRef);
      transaction.delete(targetAdminDataRef);

      transaction.update(targetUserRef, {
        companyId: FieldValue.delete(),
        companyJoinedAt: FieldValue.delete(),
        companyMembershipUpdatedAt:
          FieldValue.serverTimestamp(),
      });

      transaction.update(companyRef, {
        activeMemberCount: activeMemberCount - 1,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        companyId,
        targetUid,
        removedRole: targetRole,
        status: "removed",
      };
    });
  },
);
