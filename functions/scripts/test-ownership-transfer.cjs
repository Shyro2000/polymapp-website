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

async function getResponseBody(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function callFunction(name, idToken, data = {}) {
  const response = await fetch(`${functionsUrl}/${name}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({data}),
  });

  const body = await getResponseBody(response);

  if (!response.ok || body.error) {
    const error = new Error(
      body.error?.message ??
      `HTTP-Fehler ${response.status}`,
    );

    error.functionStatus =
      body.error?.status ?? "UNKNOWN";

    throw error;
  }

  return body.result ?? body.data;
}

async function expectFunctionError(
  name,
  idToken,
  data,
  expectedStatus,
) {
  try {
    await callFunction(name, idToken, data);
  } catch (error) {
    if (error.functionStatus === expectedStatus) {
      return;
    }

    throw new Error(
      `Erwartet: ${expectedStatus}, ` +
      `erhalten: ${error.functionStatus}. ` +
      `${error.message}`,
    );
  }

  throw new Error(
    `${name} hätte mit ${expectedStatus} scheitern müssen.`,
  );
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

  const body = await getResponseBody(response);

  if (!response.ok || !body.localId || !body.idToken) {
    throw new Error(
      `Der Testnutzer ${email} konnte nicht erstellt werden.`,
    );
  }

  const uid = body.localId;

  await db.collection("users").doc(uid).set({
    email,
    is_premium: false,
  });

  if (!emailVerified) {
    return {
      uid,
      idToken: body.idToken,
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

  const signInBody =
    await getResponseBody(signInResponse);

  return {
    uid,
    idToken: signInBody.idToken,
  };
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const ownerEmail =
    `transfer-owner-${timestamp}@polymapp.test`;
  const newOwnerEmail =
    `transfer-target-${timestamp}@polymapp.test`;
  const outsiderEmail =
    `transfer-outsider-${timestamp}@polymapp.test`;

  const oldOwner = await createTestUser(
    ownerEmail,
    password,
    false,
  );

  const newOwner = await createTestUser(
    newOwnerEmail,
    password,
    true,
  );

  const outsider = await createTestUser(
    outsiderEmail,
    password,
    true,
  );

  const companyResult = await callFunction(
    "createCompany",
    oldOwner.idToken,
    {
      name: "PolymApp Übergabetest",
    },
  );

  const companyId = companyResult.companyId;

  const invitation = await callFunction(
    "inviteCompanyMember",
    oldOwner.idToken,
    {
      email: newOwnerEmail,
      role: "viewer",
    },
  );

  await callFunction(
    "acceptCompanyInvitation",
    newOwner.idToken,
    {
      invitationId: invitation.invitationId,
    },
  );

  await db
    .collection("users")
    .doc(oldOwner.uid)
    .collection("machines")
    .doc("private-owner-machine")
    .set({
      name: "Private Maschine bisheriger Owner",
    });

  await expectFunctionError(
    "transferCompanyOwnership",
    newOwner.idToken,
    {
      targetUid: oldOwner.uid,
    },
    "PERMISSION_DENIED",
  );

  await expectFunctionError(
    "transferCompanyOwnership",
    oldOwner.idToken,
    {
      targetUid: outsider.uid,
    },
    "NOT_FOUND",
  );

  const transferResult = await callFunction(
    "transferCompanyOwnership",
    oldOwner.idToken,
    {
      targetUid: newOwner.uid,
    },
  );

  if (
    transferResult.status !== "transferred" ||
    transferResult.previousOwnerRole !== "admin" ||
    transferResult.newOwnerRole !== "owner"
  ) {
    throw new Error(
      "Die Owner-Rechte wurden nicht korrekt übertragen.",
    );
  }

  const companyAfterTransferSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .get();

  const oldOwnerMemberAfterTransfer = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(oldOwner.uid)
    .get();

  const newOwnerMemberAfterTransfer = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(newOwner.uid)
    .get();

  if (
    companyAfterTransferSnapshot.get("ownerUid") !==
    newOwner.uid
  ) {
    throw new Error(
      "ownerUid wurde nicht auf den neuen Owner gesetzt.",
    );
  }

  if (
    oldOwnerMemberAfterTransfer.get("role") !== "admin"
  ) {
    throw new Error(
      "Der bisherige Owner wurde nicht admin.",
    );
  }

  if (
    newOwnerMemberAfterTransfer.get("role") !== "owner"
  ) {
    throw new Error(
      "Das Ziel wurde nicht zum Owner.",
    );
  }

  await expectFunctionError(
    "transferCompanyOwnership",
    oldOwner.idToken,
    {
      targetUid: newOwner.uid,
    },
    "PERMISSION_DENIED",
  );

  const leaveResult = await callFunction(
    "leaveCompany",
    oldOwner.idToken,
  );

  if (
    leaveResult.status !== "left" ||
    leaveResult.previousRole !== "admin"
  ) {
    throw new Error(
      "Der bisherige Owner konnte nicht austreten.",
    );
  }

  await expectFunctionError(
    "leaveCompany",
    newOwner.idToken,
    {},
    "FAILED_PRECONDITION",
  );

  const finalCompanySnapshot = await db
    .collection("companies")
    .doc(companyId)
    .get();

  const oldOwnerUserSnapshot = await db
    .collection("users")
    .doc(oldOwner.uid)
    .get();

  const oldOwnerMemberSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(oldOwner.uid)
    .get();

  const newOwnerMemberSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(newOwner.uid)
    .get();

  const privateMachineSnapshot = await db
    .collection("users")
    .doc(oldOwner.uid)
    .collection("machines")
    .doc("private-owner-machine")
    .get();

  const finalCompany = finalCompanySnapshot.data();

  if (finalCompany?.ownerUid !== newOwner.uid) {
    throw new Error(
      "Die Firma besitzt nicht den neuen Owner.",
    );
  }

  if (finalCompany?.activeMemberCount !== 1) {
    throw new Error(
      "Die Firma hat nicht genau ein Mitglied.",
    );
  }

  if (
    oldOwnerUserSnapshot.get("companyId") !== undefined
  ) {
    throw new Error(
      "Beim bisherigen Owner besteht noch companyId.",
    );
  }

  if (oldOwnerMemberSnapshot.exists) {
    throw new Error(
      "Die alte Owner-Mitgliedschaft wurde nicht gelöscht.",
    );
  }

  if (
    !newOwnerMemberSnapshot.exists ||
    newOwnerMemberSnapshot.get("role") !== "owner"
  ) {
    throw new Error(
      "Die neue Owner-Mitgliedschaft ist ungültig.",
    );
  }

  if (!privateMachineSnapshot.exists) {
    throw new Error(
      "Die private Maschine wurde unerwartet gelöscht.",
    );
  }

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Firma: ${finalCompany.name}`);
  console.log(
    `Neuer Owner: ${finalCompany.ownerUid}`,
  );
  console.log(
    `Verbleibende Mitglieder: ` +
      `${finalCompany.activeMemberCount}`,
  );
  console.log(
    "Nur der bisherige Owner konnte übertragen.",
  );
  console.log(
    "Ein firmenfremder Nutzer konnte nicht gewählt werden.",
  );
  console.log(
    "Der bisherige Owner wurde zunächst Admin.",
  );
  console.log(
    "Der bisherige Owner konnte danach austreten.",
  );
  console.log(
    "Der neue Owner konnte nicht ohne Übertragung austreten.",
  );
  console.log(
    "Private Maschinen sind erhalten geblieben.",
  );
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});