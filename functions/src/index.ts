import {createHash} from "node:crypto";
import {initializeApp} from "firebase-admin/app";
import {
  FieldValue,
  Timestamp,
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

const INVITATION_VALIDITY_MS = 72 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_ID_PATTERN = /^[a-f0-9]{64}$/;

type InvitationRole = "admin" | "editor" | "viewer";

/**
 * Normalisiert eine E-Mail-Adresse für Vergleiche.
 *
 * @param {string} value Die ursprüngliche E-Mail-Adresse.
 * @return {string} Die normalisierte E-Mail-Adresse.
 */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Prüft, ob ein Wert eine erlaubte Einladungsrolle ist.
 *
 * @param {*} value Der zu prüfende Wert.
 * @return {boolean} True, wenn die Rolle erlaubt ist.
 */
function isInvitationRole(
  value: unknown,
): value is InvitationRole {
  return (
    value === "admin" ||
    value === "editor" ||
    value === "viewer"
  );
}

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

export const inviteCompanyMember = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Du musst angemeldet sein.",
    );
  }

  const rawEmail: unknown = request.data?.email;
  const rawRole: unknown = request.data?.role;

  if (typeof rawEmail !== "string") {
    throw new HttpsError(
      "invalid-argument",
      "Die E-Mail-Adresse fehlt.",
    );
  }

  const email = normalizeEmail(rawEmail);

  if (
    email.length > 254 ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Die E-Mail-Adresse ist ungültig.",
    );
  }

  if (!isInvitationRole(rawRole)) {
    throw new HttpsError(
      "invalid-argument",
      "Die ausgewählte Rolle ist ungültig.",
    );
  }

  const role = rawRole;
  const uid = request.auth.uid;
  const authenticatedEmail = request.auth.token.email;

  if (
    typeof authenticatedEmail === "string" &&
    normalizeEmail(authenticatedEmail) === email
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Du kannst dich nicht selbst einladen.",
    );
  }

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

    if (!memberSnapshot.exists) {
      throw new HttpsError(
        "permission-denied",
        "Die Firmenmitgliedschaft wurde nicht gefunden.",
      );
    }

    if (companySnapshot.get("status") !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "Die Firma ist nicht aktiv.",
      );
    }

    if (memberSnapshot.get("status") !== "active") {
      throw new HttpsError(
        "permission-denied",
        "Die Mitgliedschaft ist nicht aktiv.",
      );
    }

    const callerRole = memberSnapshot.get("role");
    const isOwner = callerRole === "owner";
    const isAdmin = callerRole === "admin";

    if (!isOwner && !isAdmin) {
      throw new HttpsError(
        "permission-denied",
        "Du darfst keine Mitglieder einladen.",
      );
    }

    if (isAdmin && role === "admin") {
      throw new HttpsError(
        "permission-denied",
        "Nur der Owner darf Admins einladen.",
      );
    }

    const seatLimit = companySnapshot.get("seatLimit");
    const activeMemberCount =
      companySnapshot.get("activeMemberCount");

    if (
      !Number.isInteger(seatLimit) ||
      !Number.isInteger(activeMemberCount) ||
      seatLimit < 1 ||
      activeMemberCount < 1
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Die Platzangaben der Firma sind ungültig.",
      );
    }

    const invitationId = createHash("sha256")
      .update(`${companyId}:${email}`)
      .digest("hex");

    const invitationRef = db
      .collection("companyInvitations")
      .doc(invitationId);

    const pendingQuery = db
      .collection("companyInvitations")
      .where("companyId", "==", companyId)
      .where("status", "==", "pending");

    const pendingSnapshot =
      await transaction.get(pendingQuery);

    const now = Timestamp.now();
    const nowMilliseconds = now.toMillis();
    let activePendingCount = 0;
    let invitationAlreadyActive = false;

    for (const document of pendingSnapshot.docs) {
      const expiresAt = document.get("expiresAt");

      const isStillValid =
        expiresAt instanceof Timestamp &&
        expiresAt.toMillis() > nowMilliseconds;

      if (isStillValid) {
        activePendingCount += 1;

        if (document.id === invitationId) {
          invitationAlreadyActive = true;
        }
      }
    }

    if (invitationAlreadyActive) {
      throw new HttpsError(
        "already-exists",
        "Für diese E-Mail besteht bereits eine Einladung.",
      );
    }

    if (
      activeMemberCount + activePendingCount >= seatLimit
    ) {
      throw new HttpsError(
        "resource-exhausted",
        "Alle verfügbaren Firmenplätze sind belegt.",
      );
    }

    for (const document of pendingSnapshot.docs) {
      const expiresAt = document.get("expiresAt");

      const isStillValid =
        expiresAt instanceof Timestamp &&
        expiresAt.toMillis() > nowMilliseconds;

      if (!isStillValid && document.id !== invitationId) {
        transaction.update(document.ref, {
          status: "expired",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    const expiresAt = Timestamp.fromMillis(
      nowMilliseconds + INVITATION_VALIDITY_MS,
    );

    transaction.set(invitationRef, {
      companyId,
      companyName: companySnapshot.get("name"),
      invitedEmail: email,
      role,
      status: "pending",
      invitedByUid: uid,
      acceptedByUid: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt,
    });

    transaction.update(companyRef, {
      pendingInvitationCount: activePendingCount + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      invitationId,
      companyId,
      email,
      role,
      status: "pending",
      expiresAt: expiresAt.toDate().toISOString(),
    };
  });
});

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

export const declineCompanyInvitation = onCall(
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

      if (!invitationSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Einladung wurde nicht gefunden.",
        );
      }

      if (invitationSnapshot.get("status") !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung ist nicht mehr offen.",
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

      const companyId =
        invitationSnapshot.get("companyId");

      if (
        typeof companyId !== "string" ||
        companyId.length === 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung enthält keine gültige Firma.",
        );
      }

      const companyRef = db
        .collection("companies")
        .doc(companyId);

      const companySnapshot =
        await transaction.get(companyRef);

      if (!companySnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Firma wurde nicht gefunden.",
        );
      }

      const pendingInvitationCount =
        companySnapshot.get("pendingInvitationCount");

      if (
        !Number.isInteger(pendingInvitationCount) ||
        pendingInvitationCount < 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Anzahl offener Einladungen ist ungültig.",
        );
      }

      const expiresAt =
        invitationSnapshot.get("expiresAt");

      const isExpired =
        !(expiresAt instanceof Timestamp) ||
        expiresAt.toMillis() <= Timestamp.now().toMillis();

      if (isExpired) {
        transaction.update(invitationRef, {
          status: "expired",
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(invitationRef, {
          status: "declined",
          declinedByUid: uid,
          declinedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      transaction.update(companyRef, {
        pendingInvitationCount: Math.max(
          pendingInvitationCount - 1,
          0,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        invitationId,
        companyId,
        status: isExpired ? "expired" : "declined",
      };
    });
  },
);

export const withdrawCompanyInvitation = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const rawInvitationId: unknown =
      request.data?.invitationId;

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

      if (!invitationSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Einladung wurde nicht gefunden.",
        );
      }

      const companyId = userSnapshot.get("companyId");
      const invitationCompanyId =
        invitationSnapshot.get("companyId");

      if (
        typeof companyId !== "string" ||
        companyId.length === 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Der Benutzer gehört keiner Firma an.",
        );
      }

      if (invitationCompanyId !== companyId) {
        throw new HttpsError(
          "permission-denied",
          "Die Einladung gehört zu einer anderen Firma.",
        );
      }

      if (invitationSnapshot.get("status") !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung ist nicht mehr offen.",
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

      if (!memberSnapshot.exists) {
        throw new HttpsError(
          "permission-denied",
          "Die Firmenmitgliedschaft wurde nicht gefunden.",
        );
      }

      if (memberSnapshot.get("status") !== "active") {
        throw new HttpsError(
          "permission-denied",
          "Die Mitgliedschaft ist nicht aktiv.",
        );
      }

      const callerRole = memberSnapshot.get("role");
      const isOwner = callerRole === "owner";
      const isAdmin = callerRole === "admin";

      if (!isOwner && !isAdmin) {
        throw new HttpsError(
          "permission-denied",
          "Du darfst keine Einladungen zurückziehen.",
        );
      }

      const invitationRole =
        invitationSnapshot.get("role");

      if (!isInvitationRole(invitationRole)) {
        throw new HttpsError(
          "failed-precondition",
          "Die Einladung enthält keine gültige Rolle.",
        );
      }

      if (isAdmin && invitationRole === "admin") {
        throw new HttpsError(
          "permission-denied",
          "Nur der Owner darf Admin-Einladungen verwalten.",
        );
      }

      const pendingInvitationCount =
        companySnapshot.get("pendingInvitationCount");

      if (
        !Number.isInteger(pendingInvitationCount) ||
        pendingInvitationCount < 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Die Anzahl offener Einladungen ist ungültig.",
        );
      }

      const expiresAt =
        invitationSnapshot.get("expiresAt");

      const isExpired =
        !(expiresAt instanceof Timestamp) ||
        expiresAt.toMillis() <= Timestamp.now().toMillis();

      if (isExpired) {
        transaction.update(invitationRef, {
          status: "expired",
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(invitationRef, {
          status: "withdrawn",
          withdrawnByUid: uid,
          withdrawnAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      transaction.update(companyRef, {
        pendingInvitationCount: Math.max(
          pendingInvitationCount - 1,
          0,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        invitationId,
        companyId,
        status: isExpired ? "expired" : "withdrawn",
      };
    });
  },
);
