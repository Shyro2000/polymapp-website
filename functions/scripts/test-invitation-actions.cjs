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
  const response = await fetch(
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

  const signUpData = await readResponse(response);
  const uid = signUpData.localId;

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

  return {
    uid,
    idToken: signInData.idToken,
  };
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const ownerEmail =
    `owner-actions-${timestamp}@polymapp.test`;
  const declineEmail =
    `decline-${timestamp}@polymapp.test`;
  const withdrawEmail =
    `withdraw-${timestamp}@polymapp.test`;

  const owner = await createTestUser(
    ownerEmail,
    password,
    false,
  );

  const companyResult = await callFunction(
    "createCompany",
    owner.idToken,
    {
      name: "PolymApp Einladungstest",
    },
  );

  const companyId = companyResult.companyId;

  const declineInvitation = await callFunction(
    "inviteCompanyMember",
    owner.idToken,
    {
      email: declineEmail,
      role: "editor",
    },
  );

  const withdrawInvitation = await callFunction(
    "inviteCompanyMember",
    owner.idToken,
    {
      email: withdrawEmail,
      role: "viewer",
    },
  );

  const decliningUser = await createTestUser(
    declineEmail,
    password,
    true,
  );

  const declineResult = await callFunction(
    "declineCompanyInvitation",
    decliningUser.idToken,
    {
      invitationId: declineInvitation.invitationId,
    },
  );

  const withdrawResult = await callFunction(
    "withdrawCompanyInvitation",
    owner.idToken,
    {
      invitationId: withdrawInvitation.invitationId,
    },
  );

  const companySnapshot = await db
    .collection("companies")
    .doc(companyId)
    .get();

  const declineSnapshot = await db
    .collection("companyInvitations")
    .doc(declineInvitation.invitationId)
    .get();

  const withdrawSnapshot = await db
    .collection("companyInvitations")
    .doc(withdrawInvitation.invitationId)
    .get();

  const decliningUserSnapshot = await db
    .collection("users")
    .doc(decliningUser.uid)
    .get();

  const membershipSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(decliningUser.uid)
    .get();

  const company = companySnapshot.data();
  const declined = declineSnapshot.data();
  const withdrawn = withdrawSnapshot.data();
  const decliningUserData =
    decliningUserSnapshot.data();

  if (declineResult.status !== "declined") {
    throw new Error(
      "Die Ablehnungsfunktion meldet nicht declined.",
    );
  }

  if (declined?.status !== "declined") {
    throw new Error(
      "Die Einladung wurde nicht als declined gespeichert.",
    );
  }

  if (declined?.declinedByUid !== decliningUser.uid) {
    throw new Error(
      "declinedByUid ist nicht korrekt.",
    );
  }

  if (withdrawResult.status !== "withdrawn") {
    throw new Error(
      "Die Rückzugsfunktion meldet nicht withdrawn.",
    );
  }

  if (withdrawn?.status !== "withdrawn") {
    throw new Error(
      "Die Einladung wurde nicht als withdrawn gespeichert.",
    );
  }

  if (withdrawn?.withdrawnByUid !== owner.uid) {
    throw new Error(
      "withdrawnByUid ist nicht korrekt.",
    );
  }

  if (company?.pendingInvitationCount !== 0) {
    throw new Error(
      "Es bestehen noch reservierte Einladungsplätze.",
    );
  }

  if (company?.activeMemberCount !== 1) {
    throw new Error(
      "Die aktive Mitgliederzahl wurde verändert.",
    );
  }

  if (decliningUserData?.companyId !== undefined) {
    throw new Error(
      "Der ablehnende Nutzer wurde einer Firma zugeordnet.",
    );
  }

  if (membershipSnapshot.exists) {
    throw new Error(
      "Für den ablehnenden Nutzer wurde ein Mitglied erstellt.",
    );
  }

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Firma: ${company.name}`);
  console.log(`Ablehnung: ${declined.status}`);
  console.log(`Zurückgezogen: ${withdrawn.status}`);
  console.log(
    `Aktive Mitglieder: ${company.activeMemberCount}`,
  );
  console.log(
    `Offene Einladungen: ` +
      `${company.pendingInvitationCount}`,
  );
  console.log(
    "Der ablehnende Nutzer ist keiner Firma beigetreten.",
  );
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});