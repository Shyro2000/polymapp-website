process.env.GCLOUD_PROJECT = "twyt-80c82";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const {initializeApp} = require("firebase-admin/app");
const {
  Timestamp,
  getFirestore,
} = require("firebase-admin/firestore");

const PROJECT_ID = "twyt-80c82";
const AUTH_EMULATOR_URL = "http://127.0.0.1:9099";
const FUNCTIONS_EMULATOR_URL =
  `http://127.0.0.1:5001/${PROJECT_ID}/europe-west1`;

initializeApp({
  projectId: PROJECT_ID,
});

const db = getFirestore();

function uniqueValue(prefix) {
  return `${prefix}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

async function createTestUser(prefix) {
  const email = `${uniqueValue(prefix)}@polymapp.test`;
  const password = "PolymApp-Test-123!";

  const response = await fetch(
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
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

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      `Testnutzer konnte nicht erstellt werden: ${JSON.stringify(result)}`,
    );
  }

  return {
    uid: result.localId,
    email,
    idToken: result.idToken,
  };
}

async function callDeleteCompany(user) {
  const response = await fetch(
    `${FUNCTIONS_EMULATOR_URL}/deleteCompany`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${user.idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {},
      }),
    },
  );

  const result = await response.json();

  if (!response.ok) {
    const error = new Error(
      result?.error?.message ||
      "Die Cloud Function ist fehlgeschlagen.",
    );

    error.status = result?.error?.status;
    throw error;
  }

  return result.result;
}

async function expectFunctionError(
  user,
  expectedStatus,
  description,
) {
  try {
    await callDeleteCompany(user);
  } catch (error) {
    if (error.status !== expectedStatus) {
      throw new Error(
        `${description}: Erwartet wurde ${expectedStatus}, ` +
        `erhalten wurde ${error.status || error.message}`,
      );
    }

    return;
  }

  throw new Error(
    `${description}: Die Funktion hätte fehlschlagen müssen.`,
  );
}

async function createCompany(
  owner,
  additionalMembers,
  companyName,
) {
  const companyRef = db.collection("companies").doc();
  const batch = db.batch();
  const now = Timestamp.now();

  batch.set(companyRef, {
    name: companyName,
    ownerUid: owner.uid,
    status: "active",
    seatLimit: 10,
    activeMemberCount: 1 + additionalMembers.length,
    pendingInvitationCount: 0,
    logoPath: null,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(
    db.collection("users").doc(owner.uid),
    {
      email: owner.email,
      companyId: companyRef.id,
      companyJoinedAt: now,
    },
    {
      merge: true,
    },
  );

  batch.set(
    companyRef.collection("members").doc(owner.uid),
    {
      role: "owner",
      status: "active",
      addedByUid: owner.uid,
      joinedAt: now,
    },
  );

  batch.set(
    companyRef
      .collection("memberAdminData")
      .doc(owner.uid),
    {
      email: owner.email,
      firstName: "Test",
      lastName: "Inhaber",
      department: "",
      employmentStatus: "",
      notes: "",
      updatedAt: now,
    },
  );

  for (const member of additionalMembers) {
    batch.set(
      db.collection("users").doc(member.uid),
      {
        email: member.email,
        companyId: companyRef.id,
        companyJoinedAt: now,
      },
      {
        merge: true,
      },
    );

    batch.set(
      companyRef.collection("members").doc(member.uid),
      {
        role: "viewer",
        status: "active",
        addedByUid: owner.uid,
        joinedAt: now,
      },
    );

    batch.set(
      companyRef
        .collection("memberAdminData")
        .doc(member.uid),
      {
        email: member.email,
        firstName: "Test",
        lastName: "Mitglied",
        department: "",
        employmentStatus: "",
        notes: "",
        updatedAt: now,
      },
    );
  }

  await batch.commit();

  return companyRef;
}

async function addInvitation(
  companyRef,
  owner,
  status,
  expiresAt,
) {
  const invitationRef = db
    .collection("companyInvitations")
    .doc();

  await invitationRef.set({
    companyId: companyRef.id,
    companyName: "PolymApp Löschtest",
    invitedEmail:
      `${uniqueValue("invitation")}@polymapp.test`,
    role: "viewer",
    status,
    invitedByUid: owner.uid,
    acceptedByUid: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    expiresAt,
  });

  return invitationRef;
}

async function main() {
  const ownerWithMember =
    await createTestUser("delete-owner-member");

  const additionalMember =
    await createTestUser("delete-member");

  const companyWithMember = await createCompany(
    ownerWithMember,
    [additionalMember],
    "PolymApp Firma mit Mitglied",
  );

  await expectFunctionError(
    additionalMember,
    "PERMISSION_DENIED",
    "Ein Mitglied durfte die Firma löschen",
  );

  await expectFunctionError(
    ownerWithMember,
    "FAILED_PRECONDITION",
    "Der Inhaber durfte eine Firma mit Mitglied löschen",
  );

  const companyWithMemberAfterTest =
    await companyWithMember.get();

  if (!companyWithMemberAfterTest.exists) {
    throw new Error(
      "Die Firma mit einem weiteren Mitglied wurde trotzdem gelöscht.",
    );
  }

  const ownerWithInvitation =
    await createTestUser("delete-owner-invitation");

  const companyWithInvitation = await createCompany(
    ownerWithInvitation,
    [],
    "PolymApp Firma mit Einladung",
  );

  await addInvitation(
    companyWithInvitation,
    ownerWithInvitation,
    "pending",
    Timestamp.fromMillis(
      Date.now() + 60 * 60 * 1000,
    ),
  );

  await companyWithInvitation.update({
    pendingInvitationCount: 1,
  });

  await expectFunctionError(
    ownerWithInvitation,
    "FAILED_PRECONDITION",
    "Der Inhaber durfte eine Firma mit aktiver Einladung löschen",
  );

  const companyWithInvitationAfterTest =
    await companyWithInvitation.get();

  if (!companyWithInvitationAfterTest.exists) {
    throw new Error(
      "Die Firma mit aktiver Einladung wurde trotzdem gelöscht.",
    );
  }

  const deletionOwner =
    await createTestUser("delete-owner-success");

  const companyToDelete = await createCompany(
    deletionOwner,
    [],
    "PolymApp Firma zum Löschen",
  );

  const companyMachineRef = companyToDelete
    .collection("machines")
    .doc("test-machine");

  const companyToolRef = companyMachineRef
    .collection("werkzeuge")
    .doc("test-tool");

  const privateMachineRef = db
    .collection("users")
    .doc(deletionOwner.uid)
    .collection("machines")
    .doc("private-test-machine");

  await companyMachineRef.set({
    name: "Firmenmaschine",
    manufacturer: "PolymApp",
  });

  await companyToolRef.set({
    name: "Firmenwerkzeug",
    number: 1,
  });

  await privateMachineRef.set({
    name: "Private Maschine",
    manufacturer: "PolymApp",
  });

  const expiredInvitation = await addInvitation(
    companyToDelete,
    deletionOwner,
    "pending",
    Timestamp.fromMillis(
      Date.now() - 60 * 60 * 1000,
    ),
  );

  const withdrawnInvitation = await addInvitation(
    companyToDelete,
    deletionOwner,
    "withdrawn",
    Timestamp.fromMillis(
      Date.now() + 60 * 60 * 1000,
    ),
  );

  const deletionResult =
    await callDeleteCompany(deletionOwner);

  if (deletionResult?.status !== "deleted") {
    throw new Error(
      "Die Cloud Function meldete keine erfolgreiche Löschung.",
    );
  }

  const [
    deletedCompanySnapshot,
    deletedMachineSnapshot,
    deletedToolSnapshot,
    ownerProfileSnapshot,
    privateMachineSnapshot,
    expiredInvitationSnapshot,
    withdrawnInvitationSnapshot,
  ] = await Promise.all([
    companyToDelete.get(),
    companyMachineRef.get(),
    companyToolRef.get(),
    db.collection("users")
      .doc(deletionOwner.uid)
      .get(),
    privateMachineRef.get(),
    expiredInvitation.get(),
    withdrawnInvitation.get(),
  ]);

  if (deletedCompanySnapshot.exists) {
    throw new Error(
      "Das Firmendokument wurde nicht gelöscht.",
    );
  }

  if (deletedMachineSnapshot.exists) {
    throw new Error(
      "Die Firmenmaschine wurde nicht gelöscht.",
    );
  }

  if (deletedToolSnapshot.exists) {
    throw new Error(
      "Das Firmenwerkzeug wurde nicht gelöscht.",
    );
  }

  if (!ownerProfileSnapshot.exists) {
    throw new Error(
      "Der private Benutzeraccount wurde gelöscht.",
    );
  }

  if (ownerProfileSnapshot.get("companyId") !== undefined) {
    throw new Error(
      "Die companyId wurde nicht aus dem Benutzerprofil entfernt.",
    );
  }

  if (!privateMachineSnapshot.exists) {
    throw new Error(
      "Die private Maschine wurde unerwartet gelöscht.",
    );
  }

  if (
    expiredInvitationSnapshot.exists ||
    withdrawnInvitationSnapshot.exists
  ) {
    throw new Error(
      "Die Firmeneinladungen wurden nicht vollständig gelöscht.",
    );
  }

  console.log("");
  console.log("Test erfolgreich");
  console.log(
    "Nur der Inhaber durfte die Löschung ausführen.",
  );
  console.log(
    "Eine Firma mit weiteren Mitgliedern wurde blockiert.",
  );
  console.log(
    "Eine Firma mit aktiver Einladung wurde blockiert.",
  );
  console.log(
    "Eine abgelaufene Einladung blockierte nicht.",
  );
  console.log(
    "Firma, Maschinen und Werkzeuge wurden gelöscht.",
  );
  console.log(
    "Mitgliederdaten und Einladungsverlauf wurden gelöscht.",
  );
  console.log(
    "Der private Account und private Maschinen blieben erhalten.",
  );
}

main().catch((error) => {
  console.error("");
  console.error("Test fehlgeschlagen");
  console.error(error);
  process.exitCode = 1;
});