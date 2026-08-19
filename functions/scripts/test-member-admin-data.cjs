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

  if (
    response.ok ||
    body.error?.status !== expectedStatus
  ) {
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

function expectDenied(result, description) {
  if (result.status !== 403) {
    throw new Error(
      `${description} hätte mit HTTP 403 scheitern müssen. ` +
      `Erhalten: HTTP ${result.status}: ` +
      `${JSON.stringify(result.body)}`,
    );
  }
}

function expectMissing(result, description) {
  if (result.status !== 404) {
    throw new Error(
      `${description} hätte mit HTTP 404 fehlen müssen. ` +
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

async function readAdminData(reader, companyId, memberUid) {
  return firestoreRequest(
    "GET",
    `companies/${companyId}/memberAdminData/${memberUid}`,
    reader.idToken,
  );
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const owner = await createTestUser(
    `data-owner-${timestamp}@polymapp.test`,
    password,
  );
  const admin = await createTestUser(
    `data-admin-${timestamp}@polymapp.test`,
    password,
  );
  const editor = await createTestUser(
    `data-editor-${timestamp}@polymapp.test`,
    password,
  );
  const viewer = await createTestUser(
    `data-viewer-${timestamp}@polymapp.test`,
    password,
  );

  const company = await callFunction(
    "createCompany",
    owner.idToken,
    {name: "PolymApp Mitgliederdatentest"},
  );

  await inviteAndAccept(owner.idToken, admin, "admin");
  await inviteAndAccept(owner.idToken, editor, "editor");
  await inviteAndAccept(owner.idToken, viewer, "viewer");

  const ownerData = await readAdminData(
    owner,
    company.companyId,
    owner.uid,
  );
  const editorData = await readAdminData(
    owner,
    company.companyId,
    editor.uid,
  );

  expectAllowed(ownerData, "Owner-Datensatz lesen");
  expectAllowed(editorData, "Editor-Datensatz als Owner lesen");
  assert(
    ownerData.body.fields?.email?.stringValue === owner.email,
    "Die E-Mail des Owners wurde nicht gespeichert.",
  );
  assert(
    editorData.body.fields?.email?.stringValue === editor.email,
    "Die E-Mail des Editors wurde nicht gespeichert.",
  );

  await callFunction(
    "updateCompanyMemberAdminData",
    admin.idToken,
    {
      memberUid: editor.uid,
      profile: {
        firstName: "Erika",
        lastName: "Muster",
        department: "CNC-Dreherei",
        employmentStatus: "2. Lehrjahr",
        notes: "Benötigt Einführung an Maschine 4.",
      },
    },
  );

  const updatedEditorData = await readAdminData(
    admin,
    company.companyId,
    editor.uid,
  );

  expectAllowed(
    updatedEditorData,
    "Aktualisierte Mitgliederdaten als Admin lesen",
  );
  assert(
    updatedEditorData.body.fields?.firstName?.stringValue ===
      "Erika",
    "Der Vorname wurde nicht gespeichert.",
  );
  assert(
    updatedEditorData.body.fields?.department?.stringValue ===
      "CNC-Dreherei",
    "Die Abteilung wurde nicht gespeichert.",
  );
  assert(
    updatedEditorData.body.fields?.notes?.stringValue ===
      "Benötigt Einführung an Maschine 4.",
    "Die Notiz wurde nicht gespeichert.",
  );

  const editorRead = await readAdminData(
    editor,
    company.companyId,
    editor.uid,
  );
  const viewerRead = await readAdminData(
    viewer,
    company.companyId,
    editor.uid,
  );

  expectDenied(editorRead, "Editor liest administrative Daten");
  expectDenied(viewerRead, "Viewer liest administrative Daten");

  await expectFunctionError(
    "updateCompanyMemberAdminData",
    editor.idToken,
    {
      memberUid: editor.uid,
      profile: {notes: "Unerlaubte Änderung"},
    },
    "PERMISSION_DENIED",
  );

  await expectFunctionError(
    "updateCompanyMemberAdminData",
    owner.idToken,
    {
      memberUid: editor.uid,
      profile: {email: "manipuliert@polymapp.test"},
    },
    "INVALID_ARGUMENT",
  );

  await expectFunctionError(
    "updateCompanyMemberAdminData",
    owner.idToken,
    {
      memberUid: editor.uid,
      profile: {notes: "x".repeat(2001)},
    },
    "INVALID_ARGUMENT",
  );

  const directWrite = await firestoreRequest(
    "PATCH",
    `companies/${company.companyId}` +
      `/memberAdminData/${editor.uid}`,
    owner.idToken,
    {
      notes: {stringValue: "Direkte Manipulation"},
    },
  );

  expectDenied(
    directWrite,
    "Direkte Änderung administrativer Mitgliederdaten",
  );

  await callFunction(
  "removeCompanyMember",
  admin.idToken,
  {targetUid: editor.uid},
);

  const removedEditorData = await readAdminData(
    owner,
    company.companyId,
    editor.uid,
  );

  expectMissing(
    removedEditorData,
    "Administrative Daten des entfernten Editors",
  );

  await callFunction(
    "leaveCompany",
    viewer.idToken,
  );

  const departedViewerData = await readAdminData(
    owner,
    company.companyId,
    viewer.uid,
  );

  expectMissing(
    departedViewerData,
    "Administrative Daten des ausgetretenen Viewers",
  );

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Firma: ${company.name}`);
  console.log("Datensätze für Owner und Mitglieder wurden angelegt.");
  console.log("Admin konnte Mitgliederdaten bearbeiten.");
  console.log("Editor und Viewer konnten die Daten nicht lesen.");
  console.log("Editor konnte die Daten nicht bearbeiten.");
  console.log("E-Mail und überlange Notiz waren unveränderbar.");
  console.log("Direkte Client-Änderungen wurden abgewiesen.");
  console.log("Daten wurden bei Entfernung und Austritt gelöscht.");
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});
