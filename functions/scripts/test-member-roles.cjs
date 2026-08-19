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

async function callFunction(name, idToken, data) {
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

  if (!signInResponse.ok || !signInBody.idToken) {
    throw new Error(
      `Für ${email} konnte kein Token erstellt werden.`,
    );
  }

  return {
    uid,
    idToken: signInBody.idToken,
  };
}

async function inviteAndAccept(
  ownerToken,
  email,
  role,
  user,
) {
  const invitation = await callFunction(
    "inviteCompanyMember",
    ownerToken,
    {
      email,
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

  const ownerEmail =
    `role-owner-${timestamp}@polymapp.test`;
  const adminEmail =
    `role-admin-${timestamp}@polymapp.test`;
  const employeeEmail =
    `role-employee-${timestamp}@polymapp.test`;

  const owner = await createTestUser(
    ownerEmail,
    password,
    false,
  );

  const companyResult = await callFunction(
    "createCompany",
    owner.idToken,
    {
      name: "PolymApp Rollentest",
    },
  );

  const companyId = companyResult.companyId;

  const admin = await createTestUser(
    adminEmail,
    password,
    true,
  );

  await inviteAndAccept(
    owner.idToken,
    adminEmail,
    "editor",
    admin,
  );

  const promoteAdminResult = await callFunction(
    "updateCompanyMemberRole",
    owner.idToken,
    {
      targetUid: admin.uid,
      role: "admin",
    },
  );

  if (
    promoteAdminResult.changed !== true ||
    promoteAdminResult.role !== "admin"
  ) {
    throw new Error(
      "Der Owner konnte den Admin nicht ernennen.",
    );
  }

  const employee = await createTestUser(
    employeeEmail,
    password,
    true,
  );

  await inviteAndAccept(
    admin.idToken,
    employeeEmail,
    "editor",
    employee,
  );

  const viewerResult = await callFunction(
    "updateCompanyMemberRole",
    admin.idToken,
    {
      targetUid: employee.uid,
      role: "viewer",
    },
  );

  if (
    viewerResult.changed !== true ||
    viewerResult.role !== "viewer"
  ) {
    throw new Error(
      "Der Admin konnte editor nicht zu viewer ändern.",
    );
  }

  await expectFunctionError(
    "updateCompanyMemberRole",
    admin.idToken,
    {
      targetUid: employee.uid,
      role: "admin",
    },
    "PERMISSION_DENIED",
  );

  await expectFunctionError(
    "updateCompanyMemberRole",
    admin.idToken,
    {
      targetUid: admin.uid,
      role: "editor",
    },
    "PERMISSION_DENIED",
  );

  const secondAdminResult = await callFunction(
    "updateCompanyMemberRole",
    owner.idToken,
    {
      targetUid: employee.uid,
      role: "admin",
    },
  );

  if (
    secondAdminResult.changed !== true ||
    secondAdminResult.role !== "admin"
  ) {
    throw new Error(
      "Der Owner konnte viewer nicht zu admin ändern.",
    );
  }

  await expectFunctionError(
    "updateCompanyMemberRole",
    admin.idToken,
    {
      targetUid: employee.uid,
      role: "editor",
    },
    "PERMISSION_DENIED",
  );

  await expectFunctionError(
    "updateCompanyMemberRole",
    owner.idToken,
    {
      targetUid: owner.uid,
      role: "viewer",
    },
    "PERMISSION_DENIED",
  );

  const companySnapshot = await db
    .collection("companies")
    .doc(companyId)
    .get();

  const adminSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(admin.uid)
    .get();

  const employeeSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(employee.uid)
    .get();

  const company = companySnapshot.data();
  const adminMember = adminSnapshot.data();
  const employeeMember = employeeSnapshot.data();

  if (company?.activeMemberCount !== 3) {
    throw new Error(
      "Die Mitgliederzahl der Firma ist nicht 3.",
    );
  }

  if (adminMember?.role !== "admin") {
    throw new Error(
      "Das erste Mitglied ist nicht admin.",
    );
  }

  if (employeeMember?.role !== "admin") {
    throw new Error(
      "Das zweite Mitglied ist nicht admin.",
    );
  }

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Firma: ${company.name}`);
  console.log(`Mitglieder: ${company.activeMemberCount}`);
  console.log(`Erster Admin: ${adminMember.role}`);
  console.log(`Zweiter Admin: ${employeeMember.role}`);
  console.log(
    "Admin konnte editor zu viewer ändern.",
  );
  console.log(
    "Admin konnte keine Admin-Rechte vergeben.",
  );
  console.log(
    "Admin konnte keine Admin-Rolle verändern.",
  );
  console.log(
    "Owner-Rolle konnte nicht direkt verändert werden.",
  );
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});