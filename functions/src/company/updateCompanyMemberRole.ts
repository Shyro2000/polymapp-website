import {FieldValue} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {isInvitationRole} from "../shared/validation";

export const updateCompanyMemberRole = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const rawTargetUid: unknown =
      request.data?.targetUid;
    const rawRole: unknown = request.data?.role;

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

    if (!isInvitationRole(rawRole)) {
      throw new HttpsError(
        "invalid-argument",
        "Die ausgewählte Rolle ist ungültig.",
      );
    }

    const callerUid = request.auth.uid;
    const targetUid = rawTargetUid;
    const newRole = rawRole;

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

      if (!callerMemberSnapshot.exists) {
        throw new HttpsError(
          "permission-denied",
          "Die eigene Mitgliedschaft wurde nicht gefunden.",
        );
      }

      if (
        callerMemberSnapshot.get("status") !== "active"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Die eigene Mitgliedschaft ist nicht aktiv.",
        );
      }

      if (!targetMemberSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Das Firmenmitglied wurde nicht gefunden.",
        );
      }

      if (
        targetMemberSnapshot.get("status") !== "active"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Das Firmenmitglied ist nicht aktiv.",
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

      const companyOwnerUid =
        companySnapshot.get("ownerUid");

      if (
        typeof companyOwnerUid !== "string" ||
        companyOwnerUid.length === 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Der Firmen-Owner ist ungültig.",
        );
      }

      const callerRole =
        callerMemberSnapshot.get("role");

      const currentTargetRole =
        targetMemberSnapshot.get("role");

      const callerIsOwner =
        callerRole === "owner" &&
        callerUid === companyOwnerUid;

      const callerIsAdmin =
        callerRole === "admin";

      if (!callerIsOwner && !callerIsAdmin) {
        throw new HttpsError(
          "permission-denied",
          "Du darfst keine Mitgliederrollen ändern.",
        );
      }

      if (
        targetUid === companyOwnerUid ||
        currentTargetRole === "owner"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Die Owner-Rolle kann hier nicht geändert werden.",
        );
      }

      if (
        callerIsAdmin &&
        currentTargetRole === "admin"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Admins dürfen keine Admin-Rollen verändern.",
        );
      }

      if (
        callerIsAdmin &&
        newRole === "admin"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Nur der Owner darf Admins ernennen.",
        );
      }

      if (currentTargetRole === newRole) {
        return {
          companyId,
          targetUid,
          role: newRole,
          changed: false,
        };
      }

      transaction.update(targetMemberRef, {
        role: newRole,
        roleUpdatedByUid: callerUid,
        roleUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        companyId,
        targetUid,
        role: newRole,
        changed: true,
      };
    });
  },
);
