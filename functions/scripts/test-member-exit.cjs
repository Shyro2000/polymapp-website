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

async function inviteAndAccept(
  inviterToken,
  email,
  role,
  userToken,
) {
  const invitation = await callFunction(
    "inviteCompanyMember",
    inviterToken,
    {
      email,
      role,
    },
  );

  await callFunction(
    "acceptCompanyInvitation",
    userToken,
    {
      invitationId: invitation.invitationId,
    },
  );
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const ownerEmail =
    `exit-owner-${timestamp}@polymapp.test`;
  const adminOneEmail =
    `exit-admin-one-${timestamp}@polymapp.test`;
  const adminTwoEmail =
    `exit-admin-two-${timestamp}@polymapp.test`;
  const editorEmail =
    `exit-editor-${timestamp}@polymapp.test`;

  const owner = await createTestUser(
    ownerEmail,
    password,
    false,
  );

  const companyResult = await callFunction(
    "createCompany",
    owner.idToken,
    {
      name: "PolymApp Austrittstest",
    },
  );

  const companyId = companyResult.companyId;

  const adminOne = await createTestUser(
    adminOneEmail,
    password,
    true,
  );

  const adminTwo = await createTestUser(
    adminTwoEmail,
    password,
    true,
  );

  const editor = await createTestUser(
    editorEmail,
    password,
    true,
  );

  await inviteAndAccept(
    owner.idToken,
    adminOneEmail,
    "editor",
    adminOne.idToken,
  );

  await inviteAndAccept(
    owner.idToken,
    adminTwoEmail,
    "editor",
    adminTwo.idToken,
  );

  await inviteAndAccept(
    owner.idToken,
    editorEmail,
    "editor",
    editor.idToken,
  );

  await callFunction(
    "updateCompanyMemberRole",
    owner.idToken,
    {
      targetUid: adminOne.uid,
      role: "admin",
    },
  );

  await callFunction(
    "updateCompanyMemberRole",
    owner.idToken,
    {
      targetUid: adminTwo.uid,
      role: "admin",
    },
  );

  await db
    .collection("users")
    .doc(editor.uid)
    .collection("machines")
    .doc("private-editor-machine")
    .set({
      name: "Private Maschine Editor",
    });

  await db
    .collection("users")
    .doc(adminOne.uid)
    .collection("machines")
    .doc("private-admin-machine")
    .set({
      name: "Private Maschine Admin",
    });

  await db
    .collection("companies")
    .doc(companyId)
    .collection("memberAdminData")
    .doc(editor.uid)
    .set({
      department: "Produktion",
    });

  await db
    .collection("companies")
    .doc(companyId)
    .collection("memberAdminData")
    .doc(adminOne.uid)
    .set({
      department: "Administration",
    });

  const removeEditorResult = await callFunction(
    "removeCompanyMember",
    adminOne.idToken,
    {
      targetUid: editor.uid,
    },
  );

  if (removeEditorResult.status !== "removed") {
    throw new Error(
      "Der Editor wurde nicht entfernt.",
    );
  }

  await expectFunctionError(
    "removeCompanyMember",
    adminOne.idToken,
    {
      targetUid: adminTwo.uid,
    },
    "PERMISSION_DENIED",
  );

  await expectFunctionError(
    "removeCompanyMember",
    adminOne.idToken,
    {
      targetUid: owner.uid,
    },
    "PERMISSION_DENIED",
  );

  const removeAdminResult = await callFunction(
    "removeCompanyMember",
    owner.idToken,
    {
      targetUid: adminTwo.uid,
    },
  );

  if (
    removeAdminResult.status !== "removed" ||
    removeAdminResult.removedRole !== "admin"
  ) {
    throw new Error(
      "Der Owner konnte den Admin nicht entfernen.",
    );
  }

  const leaveResult = await callFunction(
    "leaveCompany",
    adminOne.idToken,
  );

  if (
    leaveResult.status !== "left" ||
    leaveResult.previousRole !== "admin"
  ) {
    throw new Error(
      "Der Admin konnte nicht selbständig austreten.",
    );
  }

  await expectFunctionError(
    "leaveCompany",
    owner.idToken,
    {},
    "FAILED_PRECONDITION",
  );

  const companySnapshot = await db
    .collection("companies")
    .doc(companyId)
    .get();

  const editorUserSnapshot = await db
    .collection("users")
    .doc(editor.uid)
    .get();

  const adminOneUserSnapshot = await db
    .collection("users")
    .doc(adminOne.uid)
    .get();

  const adminTwoUserSnapshot = await db
    .collection("users")
    .doc(adminTwo.uid)
    .get();

  const editorMemberSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(editor.uid)
    .get();

  const adminOneMemberSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(adminOne.uid)
    .get();

  const adminTwoMemberSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(adminTwo.uid)
    .get();

  const editorAdminDataSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("memberAdminData")
    .doc(editor.uid)
    .get();

  const adminOneAdminDataSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("memberAdminData")
    .doc(adminOne.uid)
    .get();

  const editorMachineSnapshot = await db
    .collection("users")
    .doc(editor.uid)
    .collection("machines")
    .doc("private-editor-machine")
    .get();

  const adminMachineSnapshot = await db
    .collection("users")
    .doc(adminOne.uid)
    .collection("machines")
    .doc("private-admin-machine")
    .get();

  const company = companySnapshot.data();

  if (company?.activeMemberCount !== 1) {
    throw new Error(
      "Die Firma hat nicht genau einen aktiven Owner.",
    );
  }

  if (
    editorUserSnapshot.get("companyId") !== undefined ||
    adminOneUserSnapshot.get("companyId") !== undefined ||
    adminTwoUserSnapshot.get("companyId") !== undefined
  ) {
    throw new Error(
      "Bei einem ehemaligen Mitglied besteht noch companyId.",
    );
  }

  if (
    editorMemberSnapshot.exists ||
    adminOneMemberSnapshot.exists ||
    adminTwoMemberSnapshot.exists
  ) {
    throw new Error(
      "Ein ehemaliges Mitgliederdokument besteht noch.",
    );
  }

  if (
    editorAdminDataSnapshot.exists ||
    adminOneAdminDataSnapshot.exists
  ) {
    throw new Error(
      "Administrative Mitgliederdaten wurden nicht gelöscht.",
    );
  }

  if (
    !editorMachineSnapshot.exists ||
    !adminMachineSnapshot.exists
  ) {
    throw new Error(
      "Private Maschinen wurden unerwartet gelöscht.",
    );
  }

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Firma: ${company.name}`);
  console.log(
    `Verbleibende Mitglieder: ${company.activeMemberCount}`,
  );
  console.log(
    "Admin konnte einen Editor entfernen.",
  );
  console.log(
    "Admin konnte weder Admin noch Owner entfernen.",
  );
  console.log(
    "Owner konnte einen Admin entfernen.",
  );
  console.log(
    "Admin konnte selbständig austreten.",
  );
  console.log(
    "Owner konnte nicht ohne Übertragung austreten.",
  );
  console.log(
    "Private Maschinen sind erhalten geblieben.",
  );
  console.log(
    "Administrative Mitgliederdaten wurden gelöscht.",
  );
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});