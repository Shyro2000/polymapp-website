const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

const projectId = "twyt-80c82";

const authUrl =
  "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const functionUrl =
  "http://127.0.0.1:5001/twyt-80c82/europe-west1/createCompany";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

initializeApp({projectId});

const db = getFirestore();

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

async function main() {
  const timestamp = Date.now();
  const email = `owner-${timestamp}@polymapp.test`;
  const password = "Test123456!";

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

  const signUpData = await readResponse(signUpResponse);
  const uid = signUpData.localId;
  const idToken = signUpData.idToken;

  if (!uid || !idToken) {
    throw new Error("Der Testnutzer konnte nicht erstellt werden.");
  }

  await db.collection("users").doc(uid).set({
    email,
    is_premium: false,
  });

  const functionResponse = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        name: "PolymApp Testfirma",
      },
    }),
  });

  const functionBody = await readResponse(functionResponse);

  if (functionBody.error) {
    throw new Error(JSON.stringify(functionBody.error));
  }

  const result = functionBody.result ?? functionBody.data;
  const companyId = result?.companyId;

  if (!companyId) {
    throw new Error(
      `Keine companyId erhalten: ${JSON.stringify(functionBody)}`,
    );
  }

  const userSnapshot = await db
    .collection("users")
    .doc(uid)
    .get();

  const companySnapshot = await db
    .collection("companies")
    .doc(companyId)
    .get();

  const memberSnapshot = await db
    .collection("companies")
    .doc(companyId)
    .collection("members")
    .doc(uid)
    .get();

  const user = userSnapshot.data();
  const company = companySnapshot.data();
  const member = memberSnapshot.data();

  if (!companySnapshot.exists) {
    throw new Error("Das Firmendokument fehlt.");
  }

  if (!memberSnapshot.exists) {
    throw new Error("Das Owner-Mitglied fehlt.");
  }

  if (user?.companyId !== companyId) {
    throw new Error("companyId fehlt im Benutzerprofil.");
  }

  if (company?.ownerUid !== uid) {
    throw new Error("ownerUid ist nicht korrekt.");
  }

  if (company?.activeMemberCount !== 1) {
    throw new Error("activeMemberCount ist nicht 1.");
  }

  if (member?.role !== "owner") {
    throw new Error("Die Mitgliederrolle ist nicht owner.");
  }

  console.log("");
  console.log("Test erfolgreich");
  console.log(`Testnutzer: ${email}`);
  console.log(`UID: ${uid}`);
  console.log(`Company ID: ${companyId}`);
  console.log(`Firmenname: ${company.name}`);
  console.log(`Rolle: ${member.role}`);
  console.log(
    `Belegte Plätze: ${company.activeMemberCount}` +
      ` / ${company.seatLimit}`,
  );
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});