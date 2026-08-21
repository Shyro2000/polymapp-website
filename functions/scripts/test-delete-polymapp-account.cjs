const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {
  Timestamp,
  getFirestore,
} = require("firebase-admin/firestore");

const projectId = "twyt-80c82";
const authUrl =
  "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const functionsUrl =
  "http://127.0.0.1:5001/twyt-80c82/europe-west1";
const firestoreUrl =
  `http://127.0.0.1:8080/v1/projects/${projectId}` +
  "/databases/(default)/documents";

process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

initializeApp({projectId});

const auth = getAuth();
const adminDb = getFirestore();

async function getResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return {text};
  }
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
    throw new Error(`${name}: ${JSON.stringify(body)}`);
  }

  return body.result ?? body.data;
}

async function expectFunctionError(
  name,
  idToken,
  data,
  expectedStatus,
  expectedReason,
) {
  const response = await fetch(`${functionsUrl}/${name}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({data}),
  });

  const body = await getResponseBody(response);

  if (
    response.ok ||
    body.error?.status !== expectedStatus
  ) {
    throw new Error(
      `${name} hätte mit ${expectedStatus} scheitern müssen. ` +
      `Erhalten: ${JSON.stringify(body)}`,
    );
  }

  if (
    expectedReason &&
    body.error?.details?.reason !== expectedReason
  ) {
    throw new Error(
      `${name} meldete den falschen Sperrgrund. ` +
      `Erhalten: ${JSON.stringify(body)}`,
    );
  }
}

async function firestoreRequest(
  method,
  documentPath,
  idToken,
  fields = null,
) {
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
  };

  if (fields !== null) {
    options.body = JSON.stringify({fields});
  }

  const response = await fetch(
    `${firestoreUrl}/${documentPath}`,
    options,
  );

  return {
    ok: response.ok,
    status: response.status,
    body: await getResponseBody(response),
  };
}

function expectAllowed(result, description) {
  if (!result.ok) {
    throw new Error(
      `${description} hätte erlaubt sein müssen. ` +
      `HTTP ${result.status}: ${JSON.stringify(result.body)}`,
    );
  }
}

function expectDenied(result, description) {
  if (result.status !== 403) {
    throw new Error(
      `${description} hätte mit HTTP 403 scheitern müssen. ` +
      `Erhalten: HTTP ${result.status}: ` +
      `${JSON.stringify(result.body)}`,
    );
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function createTestUser(email, password) {
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

  const signUpBody = await getResponseBody(signUpResponse);

  if (
    !signUpResponse.ok ||
    !signUpBody.localId ||
    !signUpBody.idToken
  ) {
    throw new Error(
      `Testnutzer konnte nicht erstellt werden: ${email}`,
    );
  }

  const uid = signUpBody.localId;

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

  const signInBody = await getResponseBody(signInResponse);

  if (!signInResponse.ok || !signInBody.idToken) {
    throw new Error(`Token konnte nicht erstellt werden: ${email}`);
  }

  const profile = await firestoreRequest(
    "PATCH",
    `users/${uid}`,
    signInBody.idToken,
    {
      email: {stringValue: email},
      is_premium: {booleanValue: false},
    },
  );

  expectAllowed(profile, "Benutzerprofil erstellen");

  return {
    uid,
    email,
    idToken: signInBody.idToken,
  };
}

async function inviteAndAccept(ownerToken, user, role) {
  const invitation = await callFunction(
    "inviteCompanyMember",
    ownerToken,
    {
      email: user.email,
      role,
    },
  );

  await callFunction(
    "acceptCompanyInvitation",
    user.idToken,
    {
      invitationId: invitation.invitationId,
    },
  );
}

async function createPrivateTestData(user, prefix) {
  const preference = await firestoreRequest(
    "PATCH",
    `users/${user.uid}/preferences/${prefix}-preference`,
    user.idToken,
    {
      value: {stringValue: "private preference"},
    },
  );
  const machine = await firestoreRequest(
    "PATCH",
    `users/${user.uid}/machines/${prefix}-machine`,
    user.idToken,
    {
      name: {stringValue: "Private Testmaschine"},
      manufacturer: {stringValue: "PolymApp"},
    },
  );
  const tool = await firestoreRequest(
    "PATCH",
    `users/${user.uid}/machines/${prefix}-machine` +
      `/werkzeuge/${prefix}-tool`,
    user.idToken,
    {
      name: {stringValue: "Privates Testwerkzeug"},
      number: {integerValue: "1"},
    },
  );
  const codeFile = await firestoreRequest(
    "PATCH",
    `users/${user.uid}/code_changes/${prefix}-file`,
    user.idToken,
    {
      name: {stringValue: "Testdatei"},
    },
  );
  const codeChange = await firestoreRequest(
    "PATCH",
    `users/${user.uid}/code_changes/${prefix}-file` +
      `/changes/${prefix}-change`,
    user.idToken,
    {
      value: {stringValue: "G01"},
    },
  );

  expectAllowed(preference, "Private Präferenz erstellen");
  expectAllowed(machine, "Private Maschine erstellen");
  expectAllowed(tool, "Privates Werkzeug erstellen");
  expectAllowed(codeFile, "Private Code-Datei erstellen");
  expectAllowed(codeChange, "Private Code-Änderung erstellen");
}

async function createTrialDevice(user, deviceId) {
  const startedAt = Timestamp.now();

  await adminDb
    .collection("trial_devices")
    .doc(deviceId)
    .set({
      deviceId,
      uid: user.uid,
      mode: "registered",
      trialStartedAt: startedAt,
      trialEndsAt: Timestamp.fromMillis(
        startedAt.toMillis() + 86400000,
      ),
      availableTrialDays: 1,
      createdAt: startedAt,
    });
}

async function expectAuthUserMissing(uid, description) {
  try {
    await auth.getUser(uid);
    throw new Error(`${description}: Auth-Nutzer existiert weiterhin.`);
  } catch (error) {
    if (error.code !== "auth/user-not-found") {
      throw error;
    }
  }
}

async function verifyPrivateDataDeleted(user, prefix) {
  const paths = [
    `users/${user.uid}`,
    `users/${user.uid}/preferences/${prefix}-preference`,
    `users/${user.uid}/machines/${prefix}-machine`,
    `users/${user.uid}/machines/${prefix}-machine` +
      `/werkzeuge/${prefix}-tool`,
    `users/${user.uid}/code_changes/${prefix}-file`,
    `users/${user.uid}/code_changes/${prefix}-file` +
      `/changes/${prefix}-change`,
  ];

  for (const path of paths) {
    const snapshot = await adminDb.doc(path).get();

    assert(!snapshot.exists, `Nicht gelöscht: ${path}`);
  }
}

async function verifyTrialDeviceAnonymized(deviceId) {
  const snapshot = await adminDb
    .collection("trial_devices")
    .doc(deviceId)
    .get();

  assert(snapshot.exists, "Trial-Gerät wurde unerwartet gelöscht.");
  assert(
    snapshot.get("uid") === null,
    "UID wurde im Trial-Gerät nicht entfernt.",
  );
  assert(
    snapshot.get("mode") === "deleted_account",
    "Trial-Gerät wurde nicht als gelöschter Account markiert.",
  );
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const standalone = await createTestUser(
    `real-delete-standalone-${timestamp}@polymapp.test`,
    password,
  );
  const standalonePrefix = `standalone-${timestamp}`;
  const standaloneDevice = `device-standalone-${timestamp}`;

  await createPrivateTestData(standalone, standalonePrefix);
  await createTrialDevice(standalone, standaloneDevice);

  const directDelete = await firestoreRequest(
    "DELETE",
    `users/${standalone.uid}`,
    standalone.idToken,
  );

  expectDenied(
    directDelete,
    "Direkte Löschung eines privaten Benutzerprofils",
  );

  const standaloneDeletion = await callFunction(
    "deletePolymAppAccount",
    standalone.idToken,
  );

  assert(
    standaloneDeletion.deleted === true,
    "Der private Account wurde nicht gelöscht.",
  );
  assert(
    standaloneDeletion.dissolvedCompany === false,
    "Beim privaten Account wurde eine Firma gemeldet.",
  );

  await expectAuthUserMissing(
    standalone.uid,
    "Privater Account",
  );
  await verifyPrivateDataDeleted(standalone, standalonePrefix);
  await verifyTrialDeviceAnonymized(standaloneDevice);

  const blockingOwner = await createTestUser(
    `blocked-owner-${timestamp}@polymapp.test`,
    password,
  );
  const blockingMember = await createTestUser(
    `blocked-member-${timestamp}@polymapp.test`,
    password,
  );

  await callFunction(
    "createCompany",
    blockingOwner.idToken,
    {name: "PolymApp blockierte Löschung"},
  );
  await inviteAndAccept(
    blockingOwner.idToken,
    blockingMember,
    "editor",
  );

  await expectFunctionError(
    "deletePolymAppAccount",
    blockingMember.idToken,
    {},
    "FAILED_PRECONDITION",
    "leave_company_first",
  );
  await expectFunctionError(
    "deletePolymAppAccount",
    blockingOwner.idToken,
    {},
    "FAILED_PRECONDITION",
    "company_has_members",
  );

  await auth.getUser(blockingOwner.uid);
  await auth.getUser(blockingMember.uid);

  const invitationOwner = await createTestUser(
    `invitation-owner-${timestamp}@polymapp.test`,
    password,
  );
  const invitationRecipient = await createTestUser(
    `invitation-recipient-${timestamp}@polymapp.test`,
    password,
  );

  await callFunction(
    "createCompany",
    invitationOwner.idToken,
    {name: "PolymApp Einladungssperre"},
  );
  await callFunction(
    "inviteCompanyMember",
    invitationOwner.idToken,
    {
      email: invitationRecipient.email,
      role: "viewer",
    },
  );

  await expectFunctionError(
    "deletePolymAppAccount",
    invitationOwner.idToken,
    {},
    "FAILED_PRECONDITION",
    "company_has_pending_invitations",
  );

  await auth.getUser(invitationOwner.uid);

  const dissolvingOwner = await createTestUser(
    `dissolve-owner-${timestamp}@polymapp.test`,
    password,
  );
  const expiredRecipient = await createTestUser(
    `dissolve-expired-${timestamp}@polymapp.test`,
    password,
  );
  const dissolvingPrefix = `dissolve-${timestamp}`;
  const dissolvingDevice = `device-dissolve-${timestamp}`;

  const dissolvingCompany = await callFunction(
    "createCompany",
    dissolvingOwner.idToken,
    {name: "PolymApp vollständige Auflösung"},
  );

  await createPrivateTestData(
    dissolvingOwner,
    dissolvingPrefix,
  );
  await createTrialDevice(dissolvingOwner, dissolvingDevice);

  const companyMachine = await firestoreRequest(
    "PATCH",
    `companies/${dissolvingCompany.companyId}` +
      `/machines/company-machine`,
    dissolvingOwner.idToken,
    {
      name: {stringValue: "Firmenmaschine"},
    },
  );
  const companyTool = await firestoreRequest(
    "PATCH",
    `companies/${dissolvingCompany.companyId}` +
      `/machines/company-machine/werkzeuge/company-tool`,
    dissolvingOwner.idToken,
    {
      name: {stringValue: "Firmenwerkzeug"},
    },
  );

  expectAllowed(companyMachine, "Firmenmaschine erstellen");
  expectAllowed(companyTool, "Firmenwerkzeug erstellen");

  const expiredInvitation = await callFunction(
    "inviteCompanyMember",
    dissolvingOwner.idToken,
    {
      email: expiredRecipient.email,
      role: "viewer",
    },
  );

  await adminDb
    .collection("companyInvitations")
    .doc(expiredInvitation.invitationId)
    .update({
      expiresAt: Timestamp.fromMillis(Date.now() - 60000),
    });

  const companyDeletion = await callFunction(
    "deletePolymAppAccount",
    dissolvingOwner.idToken,
  );

  assert(
    companyDeletion.deleted === true,
    "Der Owner-Account wurde nicht gelöscht.",
  );
  assert(
    companyDeletion.dissolvedCompany === true,
    "Die Firmenauflösung wurde nicht gemeldet.",
  );

  await expectAuthUserMissing(
    dissolvingOwner.uid,
    "Owner-Account",
  );
  await verifyPrivateDataDeleted(
    dissolvingOwner,
    dissolvingPrefix,
  );
  await verifyTrialDeviceAnonymized(dissolvingDevice);

  const companyPaths = [
    `companies/${dissolvingCompany.companyId}`,
    `companies/${dissolvingCompany.companyId}` +
      `/members/${dissolvingOwner.uid}`,
    `companies/${dissolvingCompany.companyId}` +
      `/memberAdminData/${dissolvingOwner.uid}`,
    `companies/${dissolvingCompany.companyId}` +
      "/machines/company-machine",
    `companies/${dissolvingCompany.companyId}` +
      "/machines/company-machine/werkzeuge/company-tool",
  ];

  for (const path of companyPaths) {
    const snapshot = await adminDb.doc(path).get();

    assert(!snapshot.exists, `Firmendokument nicht gelöscht: ${path}`);
  }

  const invitationAfterDeletion = await adminDb
    .collection("companyInvitations")
    .doc(expiredInvitation.invitationId)
    .get();

  assert(
    !invitationAfterDeletion.exists,
    "Firmeneinladung wurde bei der Auflösung nicht gelöscht.",
  );

  console.log("");
  console.log("Test erfolgreich");
  console.log("Direkte Client-Löschung wurde blockiert.");
  console.log("Privater Account wurde vollständig gelöscht.");
  console.log("Private Unterordner wurden vollständig gelöscht.");
  console.log("Trial-Geräte wurden anonymisiert.");
  console.log("Mitglied musste zuerst austreten.");
  console.log("Owner mit Mitglied wurde blockiert.");
  console.log("Owner mit aktiver Einladung wurde blockiert.");
  console.log("Abgelaufene Einladung blockierte nicht.");
  console.log("Firma, Maschinen und Werkzeuge wurden gelöscht.");
  console.log("Firebase-Auth-Accounts wurden zuletzt gelöscht.");
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});
