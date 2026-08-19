const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");

const projectId = "twyt-80c82";
const authUrl =
  "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const functionsUrl =
  "http://127.0.0.1:5001/twyt-80c82/europe-west1";
const firestoreUrl =
  `http://127.0.0.1:8080/v1/projects/${projectId}` +
  "/databases/(default)/documents";

process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

initializeApp({projectId});

const auth = getAuth();

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
  const receivedStatus = body.error?.status;

  if (response.ok || receivedStatus !== expectedStatus) {
    throw new Error(
      `${name} hätte mit ${expectedStatus} scheitern müssen. ` +
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

async function createPrivateMachine(
  user,
  machineId,
  machineName,
  toolCount,
) {
  const machine = await firestoreRequest(
    "PATCH",
    `users/${user.uid}/machines/${machineId}`,
    user.idToken,
    {
      name: {stringValue: machineName},
      details: {stringValue: `Details ${machineName}`},
      manufacturer: {stringValue: "PolymApp Test"},
      type: {stringValue: "Drehmaschine"},
      maxSpeedMainSpindle: {integerValue: "6000"},
    },
  );

  expectAllowed(machine, `Private Maschine ${machineName} erstellen`);

  for (let index = 0; index < toolCount; index += 1) {
    const toolId = `tool-${index + 1}`;
    const tool = await firestoreRequest(
      "PATCH",
      `users/${user.uid}/machines/${machineId}` +
        `/werkzeuge/${toolId}`,
      user.idToken,
      {
        name: {stringValue: `Werkzeug ${index + 1}`},
        number: {integerValue: `${index + 1}`},
        notes: {stringValue: `Notiz ${index + 1}`},
        sortOrder: {integerValue: `${index}`},
      },
    );

    expectAllowed(tool, `Privates Werkzeug ${toolId} erstellen`);
  }
}

async function verifyImportedMachine(
  user,
  companyId,
  companyMachineId,
  expectedName,
  expectedToolCount,
) {
  const machine = await firestoreRequest(
    "GET",
    `companies/${companyId}/machines/${companyMachineId}`,
    user.idToken,
  );

  expectAllowed(machine, `Firmenmaschine ${expectedName} lesen`);
  assert(
    machine.body.fields?.name?.stringValue === expectedName,
    `Name der Firmenmaschine ${expectedName} wurde nicht kopiert.`,
  );
  assert(
    machine.body.fields?.sourceOwnerUid?.stringValue === user.uid,
    `Quellbenutzer der Firmenmaschine ${expectedName} ist falsch.`,
  );

  for (let index = 0; index < expectedToolCount; index += 1) {
    const toolId = `tool-${index + 1}`;
    const tool = await firestoreRequest(
      "GET",
      `companies/${companyId}/machines/${companyMachineId}` +
        `/werkzeuge/${toolId}`,
      user.idToken,
    );

    expectAllowed(tool, `Importiertes Werkzeug ${toolId} lesen`);
    assert(
      tool.body.fields?.name?.stringValue ===
        `Werkzeug ${index + 1}`,
      `Werkzeug ${toolId} wurde nicht korrekt kopiert.`,
    );
  }
}

async function verifyPrivateMachineStillExists(user, machineId) {
  const machine = await firestoreRequest(
    "GET",
    `users/${user.uid}/machines/${machineId}`,
    user.idToken,
  );

  expectAllowed(machine, "Private Originalmaschine lesen");
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const owner = await createTestUser(
    `import-owner-${timestamp}@polymapp.test`,
    password,
  );
  const admin = await createTestUser(
    `import-admin-${timestamp}@polymapp.test`,
    password,
  );
  const editor = await createTestUser(
    `import-editor-${timestamp}@polymapp.test`,
    password,
  );

  const company = await callFunction(
    "createCompany",
    owner.idToken,
    {name: "PolymApp Maschinenimporttest"},
  );

  await inviteAndAccept(owner.idToken, admin, "admin");
  await inviteAndAccept(owner.idToken, editor, "editor");

  const ownerMachineId = "owner-private-machine";
  const adminMachineId = "admin-private-machine";
  const editorMachineId = "editor-private-machine";

  await createPrivateMachine(
    owner,
    ownerMachineId,
    "Owner Maschine",
    2,
  );
  await createPrivateMachine(
    admin,
    adminMachineId,
    "Admin Maschine",
    1,
  );
  await createPrivateMachine(
    editor,
    editorMachineId,
    "Editor Maschine",
    1,
  );

  const ownerImport = await callFunction(
    "importPrivateMachinesToCompany",
    owner.idToken,
    {machineIds: [ownerMachineId]},
  );
  const adminImport = await callFunction(
    "importPrivateMachinesToCompany",
    admin.idToken,
    {machineIds: [adminMachineId]},
  );

  assert(
    ownerImport.importedMachines?.length === 1,
    "Die Owner-Maschine wurde nicht importiert.",
  );
  assert(
    adminImport.importedMachines?.length === 1,
    "Die Admin-Maschine wurde nicht importiert.",
  );

  const ownerCompanyMachineId =
    ownerImport.importedMachines[0].companyMachineId;
  const adminCompanyMachineId =
    adminImport.importedMachines[0].companyMachineId;

  await verifyImportedMachine(
    owner,
    company.companyId,
    ownerCompanyMachineId,
    "Owner Maschine",
    2,
  );
  await verifyImportedMachine(
    admin,
    company.companyId,
    adminCompanyMachineId,
    "Admin Maschine",
    1,
  );

  await verifyPrivateMachineStillExists(owner, ownerMachineId);
  await verifyPrivateMachineStillExists(admin, adminMachineId);

  const duplicateImport = await callFunction(
    "importPrivateMachinesToCompany",
    owner.idToken,
    {machineIds: [ownerMachineId]},
  );

  assert(
    duplicateImport.importedMachines?.length === 0,
    "Der zweite Import hat eine doppelte Maschine erstellt.",
  );
  assert(
    duplicateImport.alreadyImportedMachineIds?.includes(
      ownerMachineId,
    ),
    "Der bereits erfolgte Import wurde nicht erkannt.",
  );

  await expectFunctionError(
    "importPrivateMachinesToCompany",
    editor.idToken,
    {machineIds: [editorMachineId]},
    "PERMISSION_DENIED",
  );

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Firma: ${company.name}`);
  console.log("Owner konnte Maschine und 2 Werkzeuge importieren.");
  console.log("Admin konnte Maschine und Werkzeug importieren.");
  console.log("Editor konnte keine Maschine importieren.");
  console.log("Private Originalmaschinen sind erhalten geblieben.");
  console.log("Ein erneuter Import erzeugte kein Duplikat.");
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});
