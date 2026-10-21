import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

export const getAdminCompanies = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein.",
    );
  }

  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);
  const userSnapshot = await userRef.get();

  if (!userSnapshot.exists) {
    throw new HttpsError(
      "permission-denied",
      "Kein Zugriff auf die PolymApp-Administration.",
    );
  }

  if (userSnapshot.get("systemAdmin") !== true) {
    throw new HttpsError(
      "permission-denied",
      "Kein Zugriff auf die PolymApp-Administration.",
    );
  }

  const companiesSnapshot = await db
    .collection("companies")
    .get();

  const companies = companiesSnapshot.docs.map((document) => {
    const data = document.data();

    return {
      id: document.id,
      name:
        typeof data.name === "string"
          ? data.name
          : "",
      status:
        typeof data.status === "string"
          ? data.status
          : "unknown",
      seatLimit:
        typeof data.seatLimit === "number"
          ? data.seatLimit
          : 0,
      activeMemberCount:
        typeof data.activeMemberCount === "number"
          ? data.activeMemberCount
          : 0,
      billingStatus:
        typeof data.billingStatus === "string"
          ? data.billingStatus
          : "not_configured",
    };
  });

  companies.sort((first, second) =>
    first.name.localeCompare(
      second.name,
      "de",
      {sensitivity: "base"},
    ),
  );

  return {
    companies,
  };
});
