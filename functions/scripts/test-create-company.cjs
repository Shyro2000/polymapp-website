const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

const projectId = "twyt-80c82";
const authUrl =
  "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const functionsUrl =
  "http://127.0.0.1:5001/twyt-80c82/europe-west1";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

initializeApp({projectId});

const db = getFirestore();

async function readResponse(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }

  return body;
}

async function callFunction(name, idToken, data) {
  const response = await fetch(`${functionsUrl}/${name}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({data}),
  });

  const body = await readResponse(response);

  if (body.error) {
    throw new Error(JSON.stringify(body.error));
  }

  return body.result ?? body.data;
}

async function main() {
  const timestamp = Date.now();
  const ownerEmail =
    `owner-${timestamp}@polymapp.test`;
  const invitedEmail =
    `member-${timestamp}@polymapp.test`;
  const password = "Test123456!";

  const signUpResponse = await fetch(
    `${authUrl}/accounts:signUp?key=fake-api-key`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: ownerEmail,
        password,
        returnSecureToken: true,
      }),
    },
  );

  const signUpData = await readResponse(signUpResponse);
  const uid = signUpData.localId;
  const idToken = signUpData.idToken;

  if (!uid || !idToken) {
    throw new Error(
      "Der Testnutzer konnte nicht erstellt werden.",
    );
  }

  await db.collection("users").doc(uid).set({
    email: ownerEmail,
    is_premium: false,
  });

  const companyResult = await callFunction(
    "createCompany",
    idToken,
    {
      name: "PolymApp Testfirma",
    },
  );

  const companyId = companyResult?.companyId;

  if (!companyId) {
    throw new Error("Keine companyId erhalten.");
  }

  const invitationResult = await callFunction(
    "inviteCompanyMember",
    idToken,
    {
      email: invitedEmail,
      role: "editor",
    },
  );

  const invitationId = invitationResult?.invitationId;

  if (!invitationId) {
    throw new Error("Keine invitationId erhalten.");
  }

  const userSnapshot = await db
    .collection("users")
    .doc(uid)
    .get();

  const companySnapshot = await db
    .collection("companies")
    .doc(companyId)
    .get();

  const memberSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(uid)
    .get();

  const invitationSnapshot = await db
    .collection("companyInvitations")
    .doc(invitationId)
    .get();

  const user = userSnapshot.data();
  const company = companySnapshot.data();
  const member = memberSnapshot.data();
  const invitation = invitationSnapshot.data();

  if (!companySnapshot.exists) {
    throw new Error("Das Firmendokument fehlt.");
  }

  if (!memberSnapshot.exists) {
    throw new Error("Das Owner-Mitglied fehlt.");
  }

  if (!invitationSnapshot.exists) {
    throw new Error("Das Einladungsdokument fehlt.");
  }

  if (user?.companyId !== companyId) {
    throw new Error(
      "companyId fehlt im Benutzerprofil.",
    );
  }

  if (company?.ownerUid !== uid) {
    throw new Error("ownerUid ist nicht korrekt.");
  }

  if (company?.activeMemberCount !== 1) {
    throw new Error(
      "activeMemberCount ist nicht 1.",
    );
  }

  if (company?.pendingInvitationCount !== 1) {
    throw new Error(
      "pendingInvitationCount ist nicht 1.",
    );
  }

  if (member?.role !== "owner") {
    throw new Error(
      "Die Mitgliederrolle ist nicht owner.",
    );
  }

  if (invitation?.companyId !== companyId) {
    throw new Error(
      "Die companyId der Einladung ist falsch.",
    );
  }

  if (invitation?.invitedEmail !== invitedEmail) {
    throw new Error(
      "Die E-Mail-Adresse der Einladung ist falsch.",
    );
  }

  if (invitation?.role !== "editor") {
    throw new Error(
      "Die Einladungsrolle ist nicht editor.",
    );
  }

  if (invitation?.status !== "pending") {
    throw new Error(
      "Der Einladungsstatus ist nicht pending.",
    );
  }

  if (invitation?.invitedByUid !== uid) {
    throw new Error(
      "invitedByUid ist nicht korrekt.",
    );
  }

  const remainingValidity =
    invitation.expiresAt.toMillis() - Date.now();

  const minimumValidity =
    72 * 60 * 60 * 1000 - 60 * 1000;

  const maximumValidity =
    72 * 60 * 60 * 1000 + 60 * 1000;

  if (
    remainingValidity < minimumValidity ||
    remainingValidity > maximumValidity
  ) {
    throw new Error(
      "Die Einladung ist nicht ungefähr 72 Stunden gültig.",
    );
  }

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Owner: ${ownerEmail}`);
  console.log(`UID: ${uid}`);
  console.log(`Company ID: ${companyId}`);
  console.log(`Firmenname: ${company.name}`);
  console.log(`Owner-Rolle: ${member.role}`);
  console.log(
    `Mitglieder: ${company.activeMemberCount}`,
  );
  console.log(
    `Offene Einladungen: ` +
      `${company.pendingInvitationCount}`,
  );
  console.log(`Eingeladen: ${invitedEmail}`);
  console.log(`Einladungsrolle: ${invitation.role}`);
  console.log(`Einladungsstatus: ${invitation.status}`);
  console.log(`Gültig bis: ${invitationResult.expiresAt}`);
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});