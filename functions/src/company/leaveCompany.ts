import {FieldValue} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

export const leaveCompany = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein.",
    );
  }

  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);

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

    const memberAdminDataRef = companyRef
      .collection("memberAdminData")
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

    if (
      !memberSnapshot.exists ||
      memberSnapshot.get("status") !== "active"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Die aktive Mitgliedschaft wurde nicht gefunden.",
      );
    }

    const ownerUid = companySnapshot.get("ownerUid");
    const role = memberSnapshot.get("role");

    if (uid === ownerUid || role === "owner") {
      throw new HttpsError(
        "failed-precondition",
        "Der Owner muss zuerst seine Rechte übertragen.",
      );
    }

    if (
      role !== "admin" &&
      role !== "editor" &&
      role !== "viewer"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Die Mitgliederrolle ist ungültig.",
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

    transaction.delete(memberRef);
    transaction.delete(memberAdminDataRef);

    transaction.update(userRef, {
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
      previousRole: role,
      status: "left",
    };
  });
});
