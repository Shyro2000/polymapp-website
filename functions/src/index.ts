import {initializeApp} from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
} from "firebase-admin/firestore";
import {setGlobalOptions} from "firebase-functions";
import {
  HttpsError,
  onCall,
} from "firebase-functions/https";

initializeApp();

setGlobalOptions({
  region: "europe-west1",
  maxInstances: 3,
});

const db = getFirestore();
const DEFAULT_SEAT_LIMIT = 10;

export const createCompany = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein, um eine Firma zu erstellen.",
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
  const companyRef = db.collection("companies").doc();
  const memberRef = companyRef
    .collection("members")
    .doc(uid);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new HttpsError(
        "not-found",
        "Das Benutzerprofil wurde nicht gefunden.",
      );
    }

    const currentCompanyId = userSnapshot.get("companyId");

    if (
      currentCompanyId !== undefined &&
      currentCompanyId !== null
    ) {
      throw new HttpsError(
        "already-exists",
        "Der Benutzer gehört bereits zu einer Firma.",
      );
    }

    transaction.set(companyRef, {
      name: companyName,
      ownerUid: uid,
      status: "active",
      seatLimit: DEFAULT_SEAT_LIMIT,
      activeMemberCount: 1,
      pendingInvitationCount: 0,
      logoPath: null,
      schemaVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.set(memberRef, {
      role: "owner",
      status: "active",
      addedByUid: uid,
      joinedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(userRef, {
      companyId: companyRef.id,
      companyJoinedAt: FieldValue.serverTimestamp(),
    });

    return {
      companyId: companyRef.id,
      name: companyName,
      role: "owner",
      seatLimit: DEFAULT_SEAT_LIMIT,
    };
  });
});
