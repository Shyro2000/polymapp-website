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

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const owner = await createTestUser(
    `name-owner-${timestamp}@polymapp.test`,
    password,
  );
  const admin = await createTestUser(
    `name-admin-${timestamp}@polymapp.test`,
    password,
  );
  const invitedUser = await createTestUser(
    `name-invited-${timestamp}@polymapp.test`,
    password,
  );

  const company = await callFunction(
    "createCompany",
    owner.idToken,
    {name: "Alter Firmenname"},
  );

  await inviteAndAccept(owner.idToken, admin, "admin");

  const pendingInvitation = await callFunction(
    "inviteCompanyMember",
    owner.idToken,
    {
      email: invitedUser.email,
      role: "viewer",
    },
  );

  const updateResult = await callFunction(
    "updateCompanyName",
    owner.idToken,
    {name: "  Neue   PolymApp   Firma  "},
  );

  assert(updateResult.changed === true, "Änderung wurde nicht erkannt.");
  assert(
    updateResult.name === "Neue PolymApp Firma",
    "Der Firmenname wurde nicht normalisiert.",
  );
  assert(
    updateResult.updatedInvitationCount === 1,
    "Die offene Einladung wurde nicht aktualisiert.",
  );

  const companyDocument = await firestoreRequest(
    "GET",
    `companies/${company.companyId}`,
    owner.idToken,
  );

  expectAllowed(companyDocument, "Geänderte Firma lesen");
  assert(
    companyDocument.body.fields?.name?.stringValue ===
      "Neue PolymApp Firma",
    "Im Firmendokument steht noch der alte Name.",
  );

  const invitationDocument = await firestoreRequest(
    "GET",
    `companyInvitations/${pendingInvitation.invitationId}`,
    invitedUser.idToken,
  );

  expectAllowed(
    invitationDocument,
    "Aktualisierte Einladung als Empfänger lesen",
  );
  assert(
    invitationDocument.body.fields?.companyName?.stringValue ===
      "Neue PolymApp Firma",
    "Die offene Einladung enthält noch den alten Firmennamen.",
  );

  const unchangedResult = await callFunction(
    "updateCompanyName",
    owner.idToken,
    {name: "Neue PolymApp Firma"},
  );

  assert(
    unchangedResult.changed === false,
    "Ein unveränderter Name wurde als Änderung behandelt.",
  );

  await expectFunctionError(
    "updateCompanyName",
    admin.idToken,
    {name: "Unerlaubter Admin-Name"},
    "PERMISSION_DENIED",
  );

  await expectFunctionError(
    "updateCompanyName",
    owner.idToken,
    {name: "A"},
    "INVALID_ARGUMENT",
  );

  await expectFunctionError(
    "updateCompanyName",
    owner.idToken,
    {name: "x".repeat(81)},
    "INVALID_ARGUMENT",
  );

  const directWrite = await firestoreRequest(
    "PATCH",
    `companies/${company.companyId}`,
    owner.idToken,
    {
      name: {stringValue: "Direkte Manipulation"},
    },
  );

  expectDenied(directWrite, "Direkte Änderung des Firmennamens");

  console.log("");
  console.log("Test erfolgreich");
  console.log("Alter Name: Alter Firmenname");
  console.log("Neuer Name: Neue PolymApp Firma");
  console.log("Offene Einladung wurde ebenfalls aktualisiert.");
  console.log("Admin konnte den Firmennamen nicht ändern.");
  console.log("Ungültige Firmennamen wurden abgewiesen.");
  console.log("Direkte Firestore-Änderung wurde abgewiesen.");
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});
