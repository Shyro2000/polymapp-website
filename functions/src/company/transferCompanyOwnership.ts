import {FieldValue} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

export const transferCompanyOwnership = onCall(
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

    const currentOwnerUid = request.auth.uid;
    const newOwnerUid = rawTargetUid;

    if (currentOwnerUid === newOwnerUid) {
      throw new HttpsError(
        "invalid-argument",
        "Der Benutzer ist bereits Owner.",
      );
    }

    const currentOwnerUserRef = db
      .collection("users")
      .doc(currentOwnerUid);

    const newOwnerUserRef = db
      .collection("users")
      .doc(newOwnerUid);

    return db.runTransaction(async (transaction) => {
      const currentOwnerUserSnapshot =
        await transaction.get(currentOwnerUserRef);

      if (!currentOwnerUserSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Das Benutzerprofil wurde nicht gefunden.",
        );
      }

      const companyId =
        currentOwnerUserSnapshot.get("companyId");

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

      const currentOwnerMemberRef = companyRef
        .collection("members")
        .doc(currentOwnerUid);

      const newOwnerMemberRef = companyRef
        .collection("members")
        .doc(newOwnerUid);

      const companySnapshot =
        await transaction.get(companyRef);

      const currentOwnerMemberSnapshot =
        await transaction.get(currentOwnerMemberRef);

      const newOwnerMemberSnapshot =
        await transaction.get(newOwnerMemberRef);

      const newOwnerUserSnapshot =
        await transaction.get(newOwnerUserRef);

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
        companySnapshot.get("ownerUid") !==
        currentOwnerUid
      ) {
        throw new HttpsError(
          "permission-denied",
          "Nur der aktuelle Owner darf Rechte übertragen.",
        );
      }

      if (
        !currentOwnerMemberSnapshot.exists ||
        currentOwnerMemberSnapshot.get("status") !==
          "active" ||
        currentOwnerMemberSnapshot.get("role") !== "owner"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Owner-Mitgliedschaft ist ungültig.",
        );
      }

      if (
        !newOwnerMemberSnapshot.exists ||
        newOwnerMemberSnapshot.get("status") !== "active"
      ) {
        throw new HttpsError(
          "not-found",
          "Das Ziel ist kein aktives Firmenmitglied.",
        );
      }

      if (!newOwnerUserSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Das Benutzerprofil des neuen Owners fehlt.",
        );
      }

      if (
        newOwnerUserSnapshot.get("companyId") !== companyId
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Der neue Owner gehört nicht zu dieser Firma.",
        );
      }

      const previousTargetRole =
        newOwnerMemberSnapshot.get("role");

      if (
        previousTargetRole !== "admin" &&
        previousTargetRole !== "editor" &&
        previousTargetRole !== "viewer"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Rolle des neuen Owners ist ungültig.",
        );
      }

      const activeMemberCount =
        companySnapshot.get("activeMemberCount");

      if (
        !Number.isInteger(activeMemberCount) ||
        activeMemberCount < 2
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Für die Übertragung fehlt ein weiteres Mitglied.",
        );
      }

      transaction.update(currentOwnerMemberRef, {
        role: "admin",
        roleUpdatedByUid: currentOwnerUid,
        roleUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      transaction.update(newOwnerMemberRef, {
        role: "owner",
        roleUpdatedByUid: currentOwnerUid,
        roleUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      transaction.update(companyRef, {
        ownerUid: newOwnerUid,
        previousOwnerUid: currentOwnerUid,
        ownershipTransferredByUid: currentOwnerUid,
        ownershipTransferredAt:
          FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        companyId,
        previousOwnerUid: currentOwnerUid,
        newOwnerUid,
        previousTargetRole,
        previousOwnerRole: "admin",
        newOwnerRole: "owner",
        status: "transferred",
      };
    });
  },
);
