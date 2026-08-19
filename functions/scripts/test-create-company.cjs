const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");

const projectId = "twyt-80c82";
const authUrl =
  "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const functionsUrl =
  "http://127.0.0.1:5001/twyt-80c82/europe-west1";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

initializeApp({projectId});

const db = getFirestore();
const auth = getAuth();

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

async function createTestUser(
  email,
  password,
  emailVerified,
) {
  const signUpResponse = await fetch(
    `${authUrl}/accounts:signUp?key=fake-api-key`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    },
  );

  const signUpData = await readResponse(signUpResponse);
  const uid = signUpData.localId;

  if (!uid || !signUpData.idToken) {
    throw new Error(
      `Der Testnutzer ${email} konnte nicht erstellt werden.`,
    );
  }

  await db.collection("users").doc(uid).set({
    email,
    is_premium: false,
  });

  if (!emailVerified) {
    return {
      uid,
      idToken: signUpData.idToken,
    };
  }

  await auth.updateUser(uid, {
    emailVerified: true,
  });

  const signInResponse = await fetch(
    `${authUrl}/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    },
  );

  const signInData = await readResponse(signInResponse);

  if (!signInData.idToken) {
    throw new Error(
      `Für ${email} konnte kein neues Token erstellt werden.`,
    );
  }

  return {
    uid,
    idToken: signInData.idToken,
  };
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const ownerAEmail =
    `owner-a-${timestamp}@polymapp.test`;
  const ownerBEmail =
    `owner-b-${timestamp}@polymapp.test`;
  const memberEmail =
    `member-${timestamp}@polymapp.test`;

  const ownerA = await createTestUser(
    ownerAEmail,
    password,
    false,
  );

  const companyAResult = await callFunction(
    "createCompany",
    ownerA.idToken,
    {
      name: "PolymApp Testfirma A",
    },
  );

  const companyAId = companyAResult.companyId;

  const invitationAResult = await callFunction(
    "inviteCompanyMember",
    ownerA.idToken,
    {
      email: memberEmail,
      role: "editor",
    },
  );

  const ownerB = await createTestUser(
    ownerBEmail,
    password,
    false,
  );

  const companyBResult = await callFunction(
    "createCompany",
    ownerB.idToken,
    {
      name: "PolymApp Testfirma B",
    },
  );

  const companyBId = companyBResult.companyId;

  const invitationBResult = await callFunction(
    "inviteCompanyMember",
    ownerB.idToken,
    {
      email: memberEmail,
      role: "viewer",
    },
  );

  const member = await createTestUser(
    memberEmail,
    password,
    true,
  );

  const acceptanceResult = await callFunction(
    "acceptCompanyInvitation",
    member.idToken,
    {
      invitationId: invitationAResult.invitationId,
    },
  );

  const memberUserSnapshot = await db
    .collection("users")
    .doc(member.uid)
    .get();

  const companyASnapshot = await db
    .collection("companies")
    .doc(companyAId)
    .get();

  const companyBSnapshot = await db
    .collection("companies")
    .doc(companyBId)
    .get();

  const memberSnapshot = await db
    .collection("companies")
    .doc(companyAId)
    .collection("members")
    .doc(member.uid)
    .get();

  const invitationASnapshot = await db
    .collection("companyInvitations")
    .doc(invitationAResult.invitationId)
    .get();

  const invitationBSnapshot = await db
    .collection("companyInvitations")
    .doc(invitationBResult.invitationId)
    .get();

  const memberUser = memberUserSnapshot.data();
  const companyA = companyASnapshot.data();
  const companyB = companyBSnapshot.data();
  const companyMember = memberSnapshot.data();
  const invitationA = invitationASnapshot.data();
  const invitationB = invitationBSnapshot.data();

  if (memberUser?.companyId !== companyAId) {
    throw new Error(
      "Die Firma wurde beim Mitglied nicht gespeichert.",
    );
  }

  if (!memberSnapshot.exists) {
    throw new Error(
      "Das Firmenmitglied wurde nicht erstellt.",
    );
  }

  if (companyMember?.role !== "editor") {
    throw new Error(
      "Die Rolle des Mitglieds ist nicht editor.",
    );
  }

  if (companyMember?.status !== "active") {
    throw new Error(
      "Das Firmenmitglied ist nicht aktiv.",
    );
  }

  if (companyA?.activeMemberCount !== 2) {
    throw new Error(
      "Firma A hat nicht zwei aktive Mitglieder.",
    );
  }

  if (companyA?.pendingInvitationCount !== 0) {
    throw new Error(
      "Firma A hat noch eine offene Einladung.",
    );
  }

  if (invitationA?.status !== "accepted") {
    throw new Error(
      "Die angenommene Einladung ist nicht accepted.",
    );
  }

  if (invitationA?.acceptedByUid !== member.uid) {
    throw new Error(
      "acceptedByUid ist nicht korrekt.",
    );
  }

  if (companyB?.activeMemberCount !== 1) {
    throw new Error(
      "Firma B hat eine falsche Mitgliederzahl.",
    );
  }

  if (companyB?.pendingInvitationCount !== 0) {
    throw new Error(
      "Firma B hat noch eine offene Einladung.",
    );
  }

  if (invitationB?.status !== "invalidated") {
    throw new Error(
      "Die zweite Einladung wurde nicht ungültig.",
    );
  }

  if (
    invitationB?.invalidatedReason !==
    "joined_another_company"
  ) {
    throw new Error(
      "Der Ungültigkeitsgrund ist nicht korrekt.",
    );
  }

  if (acceptanceResult.companyId !== companyAId) {
    throw new Error(
      "Die Annahme enthält die falsche Firma.",
    );
  }

  if (acceptanceResult.role !== "editor") {
    throw new Error(
      "Die Annahme enthält die falsche Rolle.",
    );
  }

  if (
    acceptanceResult.invalidatedInvitationCount !== 1
  ) {
    throw new Error(
      "Die zweite Einladung wurde nicht mitgezählt.",
    );
  }

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Mitglied: ${memberEmail}`);
  console.log(`Beigetretene Firma: ${companyA.name}`);
  console.log(`Rolle: ${companyMember.role}`);
  console.log(
    `Mitglieder Firma A: ${companyA.activeMemberCount}`,
  );
  console.log(
    `Offene Einladungen Firma A: ` +
      `${companyA.pendingInvitationCount}`,
  );
  console.log(
    `Status Einladung A: ${invitationA.status}`,
  );
  console.log(
    `Status Einladung B: ${invitationB.status}`,
  );
  console.log(
    `Offene Einladungen Firma B: ` +
      `${companyB.pendingInvitationCount}`,
  );
  console.log(
    `Automatisch ungültig gemacht: ` +
      `${acceptanceResult.invalidatedInvitationCount}`,
  );
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});