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
    throw new Error(
      `${name}: ${JSON.stringify(body)}`,
    );
  }

  return body.result ?? body.data;
}

async function firestoreRequest(
  method,
  documentPath,
  idToken,
  fields = null,
  query = "",
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
    `${firestoreUrl}/${documentPath}${query}`,
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

async function createTestUser(
  email,
  password,
  emailVerified,
  testProtectedCreate = false,
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
  let idToken = signUpBody.idToken;

  if (emailVerified) {
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
      throw new Error(
        `Token konnte nicht erstellt werden: ${email}`,
      );
    }

    idToken = signInBody.idToken;
  }

  if (testProtectedCreate) {
    const forbiddenCreate = await firestoreRequest(
      "PATCH",
      `users/${uid}`,
      idToken,
      {
        email: {stringValue: email},
        companyId: {stringValue: "forged-company"},
      },
    );

    expectDenied(
      forbiddenCreate,
      "Benutzerprofil mit selbst gesetzter companyId",
    );
  }

  const profileCreate = await firestoreRequest(
    "PATCH",
    `users/${uid}`,
    idToken,
    {
      email: {stringValue: email},
      is_premium: {booleanValue: false},
    },
  );

  expectAllowed(
    profileCreate,
    "Normales eigenes Benutzerprofil erstellen",
  );

  return {uid, idToken, email};
}

async function inviteAndAccept(
  inviterToken,
  user,
  role,
) {
  const invitation = await callFunction(
    "inviteCompanyMember",
    inviterToken,
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

  return invitation;
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const owner = await createTestUser(
    `rules-owner-${timestamp}@polymapp.test`,
    password,
    false,
  );

  const admin = await createTestUser(
    `rules-admin-${timestamp}@polymapp.test`,
    password,
    true,
  );

  const editor = await createTestUser(
    `rules-editor-${timestamp}@polymapp.test`,
    password,
    true,
  );

  const viewer = await createTestUser(
    `rules-viewer-${timestamp}@polymapp.test`,
    password,
    true,
  );

  const outsider = await createTestUser(
    `rules-outsider-${timestamp}@polymapp.test`,
    password,
    true,
    true,
  );

  const company = await callFunction(
    "createCompany",
    owner.idToken,
    {
      name: "PolymApp Regeltest",
    },
  );

  const companyId = company.companyId;

  await inviteAndAccept(owner.idToken, admin, "editor");

  await callFunction(
    "updateCompanyMemberRole",
    owner.idToken,
    {
      targetUid: admin.uid,
      role: "admin",
    },
  );

  const editorInvitation = await inviteAndAccept(
    owner.idToken,
    editor,
    "editor",
  );

  await inviteAndAccept(
    owner.idToken,
    viewer,
    "viewer",
  );

  const normalUserUpdate = await firestoreRequest(
    "PATCH",
    `users/${owner.uid}`,
    owner.idToken,
    {
      platform: {stringValue: "rules-test"},
    },
    "?updateMask.fieldPaths=platform",
  );

  expectAllowed(
    normalUserUpdate,
    "Normales Feld im eigenen Benutzerprofil ändern",
  );

  const forgedCompanyUpdate = await firestoreRequest(
    "PATCH",
    `users/${owner.uid}`,
    owner.idToken,
    {
      companyId: {stringValue: "forged-company"},
    },
    "?updateMask.fieldPaths=companyId",
  );

  expectDenied(
    forgedCompanyUpdate,
    "companyId im eigenen Benutzerprofil verändern",
  );

  const memberCompanyRead = await firestoreRequest(
    "GET",
    `companies/${companyId}`,
    viewer.idToken,
  );

  expectAllowed(
    memberCompanyRead,
    "Viewer liest eigene Firma",
  );

  const outsiderCompanyRead = await firestoreRequest(
    "GET",
    `companies/${companyId}`,
    outsider.idToken,
  );

  expectDenied(
    outsiderCompanyRead,
    "Firmenfremder Nutzer liest Firma",
  );

  const ownerMachinePath =
    `companies/${companyId}/machines/owner-machine`;

  const ownerMachineCreate = await firestoreRequest(
    "PATCH",
    ownerMachinePath,
    owner.idToken,
    {
      name: {stringValue: "Owner Maschine"},
      details: {stringValue: "Regeltest"},
    },
  );

  expectAllowed(
    ownerMachineCreate,
    "Owner erstellt Firmenmaschine",
  );

  const adminMachineCreate = await firestoreRequest(
    "PATCH",
    `companies/${companyId}/machines/admin-machine`,
    admin.idToken,
    {
      name: {stringValue: "Admin Maschine"},
    },
  );

  expectAllowed(
    adminMachineCreate,
    "Admin erstellt Firmenmaschine",
  );

  const editorMachineCreate = await firestoreRequest(
    "PATCH",
    `companies/${companyId}/machines/editor-machine`,
    editor.idToken,
    {
      name: {stringValue: "Editor Maschine"},
    },
  );

  expectDenied(
    editorMachineCreate,
    "Editor erstellt Firmenmaschine",
  );

  const editorMachineUpdate = await firestoreRequest(
    "PATCH",
    ownerMachinePath,
    editor.idToken,
    {
      name: {stringValue: "Manipulierte Maschine"},
    },
    "?updateMask.fieldPaths=name",
  );

  expectDenied(
    editorMachineUpdate,
    "Editor verändert Maschineninformationen",
  );

  const viewerMachineCreate = await firestoreRequest(
    "PATCH",
    `companies/${companyId}/machines/viewer-machine`,
    viewer.idToken,
    {
      name: {stringValue: "Viewer Maschine"},
    },
  );

  expectDenied(
    viewerMachineCreate,
    "Viewer erstellt Firmenmaschine",
  );

  const viewerMachineRead = await firestoreRequest(
    "GET",
    ownerMachinePath,
    viewer.idToken,
  );

  expectAllowed(
    viewerMachineRead,
    "Viewer liest Firmenmaschine",
  );

  const outsiderMachineRead = await firestoreRequest(
    "GET",
    ownerMachinePath,
    outsider.idToken,
  );

  expectDenied(
    outsiderMachineRead,
    "Firmenfremder Nutzer liest Firmenmaschine",
  );

  const toolPath = `${ownerMachinePath}/werkzeuge/editor-tool`;

  const editorToolCreate = await firestoreRequest(
    "PATCH",
    toolPath,
    editor.idToken,
    {
      name: {stringValue: "Editor Werkzeug"},
      number: {integerValue: "1"},
    },
  );

  expectAllowed(
    editorToolCreate,
    "Editor erstellt Werkzeug",
  );

  const viewerToolRead = await firestoreRequest(
    "GET",
    toolPath,
    viewer.idToken,
  );

  expectAllowed(
    viewerToolRead,
    "Viewer liest Werkzeug",
  );

  const viewerToolUpdate = await firestoreRequest(
    "PATCH",
    toolPath,
    viewer.idToken,
    {
      name: {stringValue: "Viewer Änderung"},
    },
    "?updateMask.fieldPaths=name",
  );

  expectDenied(
    viewerToolUpdate,
    "Viewer verändert Werkzeug",
  );

  const roleUpdate = await firestoreRequest(
    "PATCH",
    `companies/${companyId}/members/${editor.uid}`,
    owner.idToken,
    {
      role: {stringValue: "admin"},
    },
    "?updateMask.fieldPaths=role",
  );

  expectDenied(
    roleUpdate,
    "Owner verändert Rolle direkt in Firestore",
  );

  const recipientInvitationRead = await firestoreRequest(
    "GET",
    `companyInvitations/${editorInvitation.invitationId}`,
    editor.idToken,
  );

  expectAllowed(
    recipientInvitationRead,
    "Empfänger liest eigene Einladung",
  );

  const ownerInvitationRead = await firestoreRequest(
    "GET",
    `companyInvitations/${editorInvitation.invitationId}`,
    owner.idToken,
  );

  expectAllowed(
    ownerInvitationRead,
    "Owner liest Firmeneinladung",
  );

  const outsiderInvitationRead = await firestoreRequest(
    "GET",
    `companyInvitations/${editorInvitation.invitationId}`,
    outsider.idToken,
  );

  expectDenied(
    outsiderInvitationRead,
    "Firmenfremder Nutzer liest Einladung",
  );

  const invitationStatusUpdate = await firestoreRequest(
    "PATCH",
    `companyInvitations/${editorInvitation.invitationId}`,
    owner.idToken,
    {
      status: {stringValue: "pending"},
    },
    "?updateMask.fieldPaths=status",
  );

  expectDenied(
    invitationStatusUpdate,
    "Owner verändert Einladungsstatus direkt",
  );

  const privateMachinePath =
    `users/${editor.uid}/machines/private-machine`;

  const privateMachineCreate = await firestoreRequest(
    "PATCH",
    privateMachinePath,
    editor.idToken,
    {
      name: {stringValue: "Private Maschine"},
    },
  );

  expectAllowed(
    privateMachineCreate,
    "Firmenmitglied erstellt weiterhin private Maschine",
  );

  const ownPrivateMachineRead = await firestoreRequest(
    "GET",
    privateMachinePath,
    editor.idToken,
  );

  expectAllowed(
    ownPrivateMachineRead,
    "Nutzer liest eigene private Maschine",
  );

  const foreignPrivateMachineRead = await firestoreRequest(
    "GET",
    privateMachinePath,
    outsider.idToken,
  );

  expectDenied(
    foreignPrivateMachineRead,
    "Fremder Nutzer liest private Maschine",
  );

  const ownerUserDelete = await firestoreRequest(
    "DELETE",
    `users/${owner.uid}`,
    owner.idToken,
  );

  expectDenied(
    ownerUserDelete,
    "Owner löscht Benutzerprofil trotz Firma",
  );

  const viewerUserDelete = await firestoreRequest(
    "DELETE",
    `users/${viewer.uid}`,
    viewer.idToken,
  );

  expectDenied(
    viewerUserDelete,
    "Mitglied löscht Benutzerprofil trotz Firma",
  );

  const outsiderUserDelete = await firestoreRequest(
    "DELETE",
    `users/${outsider.uid}`,
    outsider.idToken,
  );

  expectAllowed(
    outsiderUserDelete,
    "Nutzer ohne Firma löscht eigenes Benutzerprofil",
  );

  console.log("");
  console.log("Test erfolgreich");
  console.log("companyId ist vor Client-Manipulation geschützt.");
  console.log("Firmenfremde Nutzer wurden abgewiesen.");
  console.log("Viewer kann nur lesen.");
  console.log("Editor kann Werkzeuge, aber keine Maschinen ändern.");
  console.log("Admin und Owner können Maschinen verwalten.");
  console.log("Rollen und Einladungen sind direkt unveränderbar.");
  console.log("Private Maschinen bleiben nur dem Besitzer zugänglich.");
  console.log("Account-Löschung ist bei Mitgliedschaft blockiert.");
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});
