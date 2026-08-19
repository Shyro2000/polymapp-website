import {FieldValue} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

const PROFILE_FIELD_LIMITS = {
  firstName: 80,
  lastName: 80,
  department: 120,
  employmentStatus: 120,
  notes: 2000,
} as const;

export const updateCompanyMemberAdminData = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const rawMemberUid: unknown = request.data?.memberUid;
    const rawProfile: unknown = request.data?.profile;

    if (
      typeof rawMemberUid !== "string" ||
      rawMemberUid.length === 0 ||
      rawMemberUid.length > 128 ||
      rawMemberUid.includes("/") ||
      rawMemberUid.trim() !== rawMemberUid
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Die Mitglieds-ID ist ungültig.",
      );
    }

    if (
      typeof rawProfile !== "object" ||
      rawProfile === null ||
      Array.isArray(rawProfile)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Die Mitgliederdaten fehlen.",
      );
    }

    const profile = rawProfile as Record<string, unknown>;
    const allowedFields = Object.keys(PROFILE_FIELD_LIMITS);
    const providedFields = Object.keys(profile);

    if (
      providedFields.length === 0 ||
      providedFields.some((field) =>
        !allowedFields.includes(field)
      )
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Die Mitgliederdaten enthalten ungültige Felder.",
      );
    }

    const updates: Record<string, string> = {};

    for (const field of providedFields) {
      const value = profile[field];
      const limit = PROFILE_FIELD_LIMITS[
        field as keyof typeof PROFILE_FIELD_LIMITS
      ];

      if (typeof value !== "string") {
        throw new HttpsError(
          "invalid-argument",
          `Das Feld ${field} muss Text enthalten.`,
        );
      }

      const normalizedValue = value.trim();

      if (normalizedValue.length > limit) {
        throw new HttpsError(
          "invalid-argument",
          `Das Feld ${field} ist zu lang.`,
        );
      }

      updates[field] = normalizedValue;
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
      const callerMemberRef = companyRef
        .collection("members")
        .doc(uid);
      const targetMemberRef = companyRef
        .collection("members")
        .doc(rawMemberUid);
      const targetAdminDataRef = companyRef
        .collection("memberAdminData")
        .doc(rawMemberUid);
      const targetUserRef = db
        .collection("users")
        .doc(rawMemberUid);

      const companySnapshot = await transaction.get(companyRef);
      const callerMemberSnapshot =
        await transaction.get(callerMemberRef);
      const targetMemberSnapshot =
        await transaction.get(targetMemberRef);
      const targetAdminDataSnapshot =
        await transaction.get(targetAdminDataRef);
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
          "Die Firmenmitgliedschaft ist nicht aktiv.",
        );
      }

      const callerRole = callerMemberSnapshot.get("role");

      if (callerRole !== "owner" && callerRole !== "admin") {
        throw new HttpsError(
          "permission-denied",
          "Nur Owner und Admins dürfen Mitgliederdaten bearbeiten.",
        );
      }

      if (
        !targetMemberSnapshot.exists ||
        targetMemberSnapshot.get("status") !== "active"
      ) {
        throw new HttpsError(
          "not-found",
          "Das Firmenmitglied wurde nicht gefunden.",
        );
      }

      const dataToWrite: Record<string, unknown> = {
        ...updates,
        memberUid: rawMemberUid,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: uid,
      };

      if (!targetAdminDataSnapshot.exists) {
        const targetEmail = targetUserSnapshot.get("email");

        dataToWrite.email =
          typeof targetEmail === "string" ?
            targetEmail.trim().toLowerCase() :
            "";
        dataToWrite.firstName = updates.firstName ?? "";
        dataToWrite.lastName = updates.lastName ?? "";
        dataToWrite.department = updates.department ?? "";
        dataToWrite.employmentStatus =
          updates.employmentStatus ?? "";
        dataToWrite.notes = updates.notes ?? "";
        dataToWrite.createdAt = FieldValue.serverTimestamp();
      }

      transaction.set(
        targetAdminDataRef,
        dataToWrite,
        {merge: true},
      );

      return {
        companyId,
        memberUid: rawMemberUid,
        updatedFields: Object.keys(updates),
      };
    });
  },
);
