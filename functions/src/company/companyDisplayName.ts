import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

interface DisplayName {
  firstName: string;
  lastName: string;
}

const maxNameLength = 80;

/**
 * Validates both parts of a name entered by the account holder.
 * @param {unknown} firstName Given name from the request.
 * @param {unknown} lastName Family name from the request.
 * @return {DisplayName} Normalized name.
 */
export function requireDisplayName(
  firstName: unknown,
  lastName: unknown,
): DisplayName {
  const first = typeof firstName === "string" ?
    firstName.trim().replace(/\s+/g, " ") : "";
  const last = typeof lastName === "string" ?
    lastName.trim().replace(/\s+/g, " ") : "";
  if (
    !first || !last ||
    first.length > maxNameLength || last.length > maxNameLength ||
    /\p{Cc}/u.test(first + last)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Vor- und Nachname müssen je 1–80 Zeichen enthalten.",
    );
  }
  return {firstName: first, lastName: last};
}

export const saveOwnDisplayName = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }
  const {expectedUid, companyId = null, joinedAt = null, firstName, lastName} =
    request.data || {};
  if (expectedUid !== request.auth.uid) {
    throw new HttpsError(
      "permission-denied",
      "Der angemeldete Benutzer hat sich geändert.",
    );
  }
  if (
    (companyId !== null &&
      (typeof companyId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(companyId))) ||
    (joinedAt !== null &&
      (companyId === null || typeof joinedAt !== "string" ||
        !/^-?\d{1,12}:\d{1,9}$/.test(joinedAt)))
  ) {
    throw new HttpsError("invalid-argument", "Ungültige Firmenzuordnung.");
  }
  const name = requireDisplayName(firstName, lastName);
  const {uid, token} = request.auth;
  const userRef = db.collection("users").doc(uid);
  const nameRef = userRef.collection("privateProfile").doc("displayName");

  return db.runTransaction(async (transaction) => {
    const user = await transaction.get(userRef);
    if (!user.exists) {
      throw new HttpsError("not-found", "Das Benutzerprofil fehlt.");
    }
    if ((user.get("companyId") || null) !== companyId) {
      throw new HttpsError(
        "failed-precondition",
        "Der Firmenbereich hat sich geändert.",
      );
    }
    if (companyId !== null) {
      const companyRef = db.collection("companies").doc(companyId);
      const memberRef = companyRef.collection("members").doc(uid);
      const adminRef = companyRef.collection("memberAdminData").doc(uid);
      const [company, member, adminData] = await transaction.getAll(
        companyRef, memberRef, adminRef,
      );
      if (
        company.get("status") !== "active" ||
        member.get("status") !== "active" ||
        !["owner", "admin", "editor", "viewer"].includes(member.get("role"))
      ) {
        throw new HttpsError(
          "permission-denied",
          "Keine aktive Mitgliedschaft.",
        );
      }
      const joined = member.get("joinedAt");
      const expected = joined instanceof Timestamp ?
        joined.seconds + ":" + joined.nanoseconds : null;
      if (expected !== joinedAt) {
        throw new HttpsError(
          "failed-precondition",
          "Die Mitgliedschaft hat sich geändert.",
        );
      }
      transaction.update(memberRef, {...name, nameConfirmed: true});
      transaction.set(adminRef, {
        ...(!adminData.exists ? {
          email: typeof token.email === "string" ?
            token.email.trim().toLowerCase() : "",
          department: "",
          employmentStatus: "",
          notes: "",
          createdAt: FieldValue.serverTimestamp(),
        } : {}),
        ...name,
        memberUid: uid,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: uid,
      }, {merge: true});
    }
    transaction.set(nameRef, name);
    return name;
  });
});
