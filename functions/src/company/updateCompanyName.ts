import {FieldValue} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

export const updateCompanyName = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein.",
    );
  }

  const rawName: unknown = request.data?.name;

  if (typeof rawName !== "string") {
    throw new HttpsError(
      "invalid-argument",
      "Der Firmenname fehlt.",
    );
  }

  const companyName = rawName.trim().replace(/\s+/g, " ");

  if (companyName.length < 2 || companyName.length > 80) {
    throw new HttpsError(
      "invalid-argument",
      "Der Firmenname muss zwischen 2 und 80 Zeichen lang sein.",
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

    const companySnapshot = await transaction.get(companyRef);
    const memberSnapshot = await transaction.get(memberRef);

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
      !memberSnapshot.exists ||
      memberSnapshot.get("status") !== "active"
    ) {
      throw new HttpsError(
        "permission-denied",
        "Die Firmenmitgliedschaft ist nicht aktiv.",
      );
    }

    if (memberSnapshot.get("role") !== "owner") {
      throw new HttpsError(
        "permission-denied",
        "Nur der Owner darf den Firmennamen ändern.",
      );
    }

    const previousName = companySnapshot.get("name");

    if (previousName === companyName) {
      return {
        companyId,
        name: companyName,
        changed: false,
        updatedInvitationCount: 0,
      };
    }

    const pendingInvitationsQuery = db
      .collection("companyInvitations")
      .where("companyId", "==", companyId)
      .where("status", "==", "pending");
    const pendingInvitationsSnapshot =
      await transaction.get(pendingInvitationsQuery);

    transaction.update(companyRef, {
      name: companyName,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: uid,
    });

    for (const invitation of pendingInvitationsSnapshot.docs) {
      transaction.update(invitation.ref, {
        companyName,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      companyId,
      previousName:
        typeof previousName === "string" ? previousName : "",
      name: companyName,
      changed: true,
      updatedInvitationCount: pendingInvitationsSnapshot.size,
    };
  });
});
