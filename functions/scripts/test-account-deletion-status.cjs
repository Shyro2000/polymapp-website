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

async function getDeletionStatus(user) {
  return callFunction(
    "getAccountDeletionStatus",
    user.idToken,
  );
}

async function main() {
  const timestamp = Date.now();
  const password = "Test123456!";

  const standalone = await createTestUser(
    `delete-standalone-${timestamp}@polymapp.test`,
    password,
  );
  const owner = await createTestUser(
    `delete-owner-${timestamp}@polymapp.test`,
    password,
  );
  const editor = await createTestUser(
    `delete-editor-${timestamp}@polymapp.test`,
    password,
  );
  const pendingUser = await createTestUser(
    `delete-pending-${timestamp}@polymapp.test`,
    password,
  );
  const expiredUser = await createTestUser(
    `delete-expired-${timestamp}@polymapp.test`,
    password,
  );
  const secondPendingUser = await createTestUser(
    `delete-pending-2-${timestamp}@polymapp.test`,
    password,
  );

  const standaloneStatus = await getDeletionStatus(standalone);

  assert(
    standaloneStatus.canDeleteAccount === true,
    "Nutzer ohne Firma müsste den Account löschen dürfen.",
  );
  assert(
    standaloneStatus.membership === "none",
    "Nutzer ohne Firma hat einen falschen Mitgliedschaftsstatus.",
  );

  const company = await callFunction(
    "createCompany",
    owner.idToken,
    {name: "PolymApp Löschstatustest"},
  );

  const soleOwnerStatus = await getDeletionStatus(owner);

  assert(
    soleOwnerStatus.canDeleteAccount === true,
    "Alleiniger Owner müsste die Firma auflösen dürfen.",
  );
  assert(
    soleOwnerStatus.willDissolveCompany === true,
    "Die Firmenauflösung wurde nicht angekündigt.",
  );

  const firstPendingInvitation = await callFunction(
    "inviteCompanyMember",
    owner.idToken,
    {
      email: pendingUser.email,
      role: "viewer",
    },
  );

  const pendingStatus = await getDeletionStatus(owner);

  assert(
    pendingStatus.canDeleteAccount === false,
    "Eine aktive Einladung müsste die Löschung blockieren.",
  );
  assert(
    pendingStatus.requiredAction === "withdraw_invitations",
    "Für eine offene Einladung wurde die falsche Aktion gemeldet.",
  );

  await callFunction(
    "withdrawCompanyInvitation",
    owner.idToken,
    {invitationId: firstPendingInvitation.invitationId},
  );

  const expiredInvitation = await callFunction(
    "inviteCompanyMember",
    owner.idToken,
    {
      email: expiredUser.email,
      role: "viewer",
    },
  );

  await adminDb
    .collection("companyInvitations")
    .doc(expiredInvitation.invitationId)
    .update({
      expiresAt: Timestamp.fromMillis(Date.now() - 60000),
    });

  const expiredStatus = await getDeletionStatus(owner);

  assert(
    expiredStatus.canDeleteAccount === true,
    "Eine abgelaufene Einladung blockiert die Löschung.",
  );
  assert(
    expiredStatus.expiredPendingInvitationCount === 1,
    "Die abgelaufene Einladung wurde nicht erkannt.",
  );

  await inviteAndAccept(owner.idToken, editor, "editor");

  const ownerWithMemberStatus = await getDeletionStatus(owner);
  const memberStatus = await getDeletionStatus(editor);

  assert(
    ownerWithMemberStatus.canDeleteAccount === false,
    "Ein aktives Mitglied müsste den Owner blockieren.",
  );
  assert(
    ownerWithMemberStatus.requiredAction ===
      "transfer_ownership_or_remove_members",
    "Für vorhandene Mitglieder wurde die falsche Aktion gemeldet.",
  );
  assert(
    memberStatus.canDeleteAccount === false,
    "Ein Firmenmitglied dürfte den Account nicht direkt löschen.",
  );
  assert(
    memberStatus.requiredAction === "leave_company",
    "Das Mitglied wurde nicht zum Austritt aufgefordert.",
  );

  const secondPendingInvitation = await callFunction(
    "inviteCompanyMember",
    owner.idToken,
    {
      email: secondPendingUser.email,
      role: "viewer",
    },
  );

  const combinedStatus = await getDeletionStatus(owner);

  assert(
    combinedStatus.requiredAction ===
      "remove_members_and_withdraw_invitations",
    "Die kombinierte Sperre wurde nicht korrekt gemeldet.",
  );

  await callFunction(
    "withdrawCompanyInvitation",
    owner.idToken,
    {invitationId: secondPendingInvitation.invitationId},
  );
  await callFunction(
    "removeCompanyMember",
    owner.idToken,
    {targetUid: editor.uid},
  );

  const finalOwnerStatus = await getDeletionStatus(owner);

  assert(
    finalOwnerStatus.canDeleteAccount === true,
    "Nach Bereinigung müsste der Owner löschen dürfen.",
  );
  assert(
    finalOwnerStatus.otherActiveMemberCount === 0,
    "Es wurden weiterhin andere Mitglieder gemeldet.",
  );
  assert(
    finalOwnerStatus.activePendingInvitationCount === 0,
    "Es wurden weiterhin aktive Einladungen gemeldet.",
  );

  console.log("");
  console.log("Test erfolgreich");
  console.log("Nutzer ohne Firma kann löschen.");
  console.log("Alleiniger Owner kann die Firma auflösen.");
  console.log("Aktive Einladung blockiert die Löschung.");
  console.log("Abgelaufene Einladung blockiert nicht.");
  console.log("Aktives Mitglied blockiert den Owner.");
  console.log("Mitglied muss vor der Account-Löschung austreten.");
  console.log("Mitglied plus Einladung wird kombiniert gemeldet.");
  console.log(`Geprüfte Firma: ${company.name}`);
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});
