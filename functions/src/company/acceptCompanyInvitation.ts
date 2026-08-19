import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {
  EMAIL_PATTERN,
  INVITATION_ID_PATTERN,
  isInvitationRole,
  normalizeEmail,
} from "../shared/validation";

export const acceptCompanyInvitation = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const authenticatedEmail = request.auth.token.email;
    const emailVerified =
      request.auth.token.email_verified === true;
    const rawInvitationId: unknown =
      request.data?.invitationId;

    if (
      typeof authenticatedEmail !== "string" ||
      !EMAIL_PATTERN.test(
        normalizeEmail(authenticatedEmail),
      )
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Im Account fehlt eine gültige E-Mail-Adresse.",
      );
    }

    if (!emailVerified) {
      throw new HttpsError(
        "failed-precondition",
        "Die E-Mail-Adresse muss zuerst bestätigt werden.",
      );
    }

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
    const email = normalizeEmail(authenticatedEmail);
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

      const currentCompanyId =
        userSnapshot.get("companyId");

      if (
        currentCompanyId !== undefined &&
        currentCompanyId !== null
      ) {
        throw new HttpsError(
          "already-exists",
          "Der Benutzer gehört bereits zu einer Firma.",
        );
      }

      if (!invitationSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Einladung wurde nicht gefunden.",
        );
      }

      if (invitationSnapshot.get("status") !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung ist nicht mehr gültig.",
        );
      }

      const invitedEmail =
        invitationSnapshot.get("invitedEmail");

      if (
        typeof invitedEmail !== "string" ||
        normalizeEmail(invitedEmail) !== email
      ) {
        throw new HttpsError(
          "permission-denied",
          "Diese Einladung gehört zu einem anderen Account.",
        );
      }

      const expiresAt =
        invitationSnapshot.get("expiresAt");
      const now = Timestamp.now();

      if (
        !(expiresAt instanceof Timestamp) ||
        expiresAt.toMillis() <= now.toMillis()
      ) {
        throw new HttpsError(
          "deadline-exceeded",
          "Die Einladung ist abgelaufen.",
        );
      }

      const companyId =
        invitationSnapshot.get("companyId");
      const role = invitationSnapshot.get("role");
      const invitedByUid =
        invitationSnapshot.get("invitedByUid");

      if (
        typeof companyId !== "string" ||
        companyId.length === 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung enthält keine gültige Firma.",
        );
      }

      if (!isInvitationRole(role)) {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung enthält keine gültige Rolle.",
        );
      }

      if (
        typeof invitedByUid !== "string" ||
        invitedByUid.length === 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Der Absender der Einladung ist ungültig.",
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

      if (companySnapshot.get("status") !== "active") {
        throw new HttpsError(
          "failed-precondition",
          "Die Firma ist nicht aktiv.",
        );
      }

      if (memberSnapshot.exists) {
        throw new HttpsError(
          "already-exists",
          "Der Benutzer ist bereits Firmenmitglied.",
        );
      }

      const seatLimit =
        companySnapshot.get("seatLimit");
      const activeMemberCount =
        companySnapshot.get("activeMemberCount");
      const pendingInvitationCount =
        companySnapshot.get("pendingInvitationCount");

      if (
        !Number.isInteger(seatLimit) ||
        !Number.isInteger(activeMemberCount) ||
        !Number.isInteger(pendingInvitationCount) ||
        seatLimit < 1 ||
        activeMemberCount < 1 ||
        pendingInvitationCount < 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Platzangaben der Firma sind ungültig.",
        );
      }

      if (activeMemberCount >= seatLimit) {
        throw new HttpsError(
          "resource-exhausted",
          "Es ist kein freier Firmenplatz vorhanden.",
        );
      }

      const pendingEmailQuery = db
        .collection("companyInvitations")
        .where("invitedEmail", "==", email)
        .where("status", "==", "pending");

      const pendingEmailSnapshot =
        await transaction.get(pendingEmailQuery);

      const closingCounts =
        new Map<string, number>();

      for (const document of pendingEmailSnapshot.docs) {
        const documentCompanyId =
          document.get("companyId");

        if (typeof documentCompanyId === "string") {
          const currentCount =
            closingCounts.get(documentCompanyId) ?? 0;

          closingCounts.set(
            documentCompanyId,
            currentCount + 1,
          );
        }
      }

      const otherCompanyIds = Array.from(
        closingCounts.keys(),
      ).filter((id) => id !== companyId);

      const otherCompanies = [];

      for (const otherCompanyId of otherCompanyIds) {
        const otherCompanyRef = db
          .collection("companies")
          .doc(otherCompanyId);

        const otherCompanySnapshot =
          await transaction.get(otherCompanyRef);

        otherCompanies.push({
          companyId: otherCompanyId,
          reference: otherCompanyRef,
          snapshot: otherCompanySnapshot,
        });
      }

      transaction.set(memberRef, {
        role,
        status: "active",
        addedByUid: invitedByUid,
        invitationId,
        joinedAt: FieldValue.serverTimestamp(),
      });

      transaction.update(userRef, {
        companyId,
        companyJoinedAt: FieldValue.serverTimestamp(),
      });

      for (const document of pendingEmailSnapshot.docs) {
        if (document.id === invitationId) {
          transaction.update(document.ref, {
            status: "accepted",
            acceptedByUid: uid,
            acceptedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });

          continue;
        }

        const documentExpiresAt =
          document.get("expiresAt");

        const isExpired =
          !(documentExpiresAt instanceof Timestamp) ||
          documentExpiresAt.toMillis() <= now.toMillis();

        if (isExpired) {
          transaction.update(document.ref, {
            status: "expired",
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          transaction.update(document.ref, {
            status: "invalidated",
            invalidatedReason: "joined_another_company",
            invalidatedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      const targetClosingCount =
        closingCounts.get(companyId) ?? 1;

      transaction.update(companyRef, {
        activeMemberCount: activeMemberCount + 1,
        pendingInvitationCount: Math.max(
          pendingInvitationCount - targetClosingCount,
          0,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      });

      for (const otherCompany of otherCompanies) {
        if (!otherCompany.snapshot.exists) {
          continue;
        }

        const otherPendingCount =
          otherCompany.snapshot.get(
            "pendingInvitationCount",
          );

        if (!Number.isInteger(otherPendingCount)) {
          continue;
        }

        const closingCount =
          closingCounts.get(otherCompany.companyId) ?? 0;

        transaction.update(otherCompany.reference, {
          pendingInvitationCount: Math.max(
            otherPendingCount - closingCount,
            0,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return {
        companyId,
        companyName: companySnapshot.get("name"),
        role,
        status: "accepted",
        invalidatedInvitationCount: Math.max(
          pendingEmailSnapshot.size - 1,
          0,
        ),
      };
    });
  },
);
