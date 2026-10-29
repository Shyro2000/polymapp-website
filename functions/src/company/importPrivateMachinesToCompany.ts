import {createHash} from "node:crypto";
import {FieldValue} from "firebase-admin/firestore";
import type {
  DocumentData,
  DocumentReference,
  QueryDocumentSnapshot,
  Transaction,
} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {requireCompanyAccess} from "../shared/companyAccess";

const MAX_MACHINES_PER_IMPORT = 20;
const MAX_WRITES_PER_IMPORT = 450;
const MAINTENANCE_COLLECTIONS = [
  "maintenanceSettings",
  "maintenancePlans",
  "maintenanceEvents",
  "maintenanceLocks",
] as const;

type MaintenanceDocuments = {
  maintenanceSettings: QueryDocumentSnapshot[];
  maintenancePlans: QueryDocumentSnapshot[];
  maintenanceEvents: QueryDocumentSnapshot[];
  maintenanceLocks: QueryDocumentSnapshot[];
};

type MachineImport = {
  sourceMachineId: string;
  destinationMachineId: string;
  sourceData: DocumentData;
  destinationRef: DocumentReference;
  tools: QueryDocumentSnapshot[];
  maintenance: MaintenanceDocuments;
  isNewMachine: boolean;
};

/**
 * Checks whether the destination already contains maintenance data.
 * @param {Transaction} transaction Firestore transaction.
 * @param {DocumentReference} machineRef Machine document.
 * @return {Promise<boolean>} Whether maintenance data exists.
 */
async function hasMaintenance(
  transaction: Transaction,
  machineRef: DocumentReference,
): Promise<boolean> {
  const snapshots = await Promise.all(
    MAINTENANCE_COLLECTIONS.map((name) =>
      transaction.get(machineRef.collection(name).limit(1)),
    ),
  );
  return snapshots.some((snapshot) => !snapshot.empty);
}

/**
 * Reads every maintenance document for one private machine.
 * @param {Transaction} transaction Firestore transaction.
 * @param {DocumentReference} machineRef Source machine document.
 * @return {Promise<MaintenanceDocuments>} Plans and complete history.
 */
async function readMaintenance(
  transaction: Transaction,
  machineRef: DocumentReference,
): Promise<MaintenanceDocuments> {
  // Limit + 1 ensures an oversized history fails instead of being truncated.
  const maxRead = MAX_WRITES_PER_IMPORT + 1;
  const [settings, plans, events, locks] = await Promise.all([
    transaction.get(machineRef.collection("maintenanceSettings")
      .limit(maxRead)),
    transaction.get(machineRef.collection("maintenancePlans")
      .limit(maxRead)),
    transaction.get(machineRef.collection("maintenanceEvents")
      .limit(maxRead)),
    transaction.get(machineRef.collection("maintenanceLocks")
      .limit(maxRead)),
  ]);
  return {
    maintenanceSettings: settings.docs,
    maintenancePlans: plans.docs,
    maintenanceEvents: events.docs,
    maintenanceLocks: locks.docs,
  };
}

/**
 * Counts maintenance documents to keep the import atomic and bounded.
 * @param {MaintenanceDocuments} data Documents to import.
 * @return {number} Number of Firestore writes required.
 */
function maintenanceCount(data: MaintenanceDocuments): number {
  return MAINTENANCE_COLLECTIONS.reduce(
    (count, name) => count + data[name].length,
    0,
  );
}

// Website calls this function with a 210-second client timeout.
export const importPrivateMachinesToCompany = onCall({
  timeoutSeconds: 180,
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }

  const rawMachineIds: unknown = request.data?.machineIds;
  if (!Array.isArray(rawMachineIds) ||
      rawMachineIds.length === 0 ||
      rawMachineIds.length > MAX_MACHINES_PER_IMPORT) {
    throw new HttpsError(
      "invalid-argument",
      "Wähle zwischen 1 und 20 Maschinen aus.",
    );
  }

  if (rawMachineIds.some((value) =>
    typeof value !== "string" ||
    value.length === 0 || value.length > 200 ||
    value.includes("/") || value.trim() !== value,
  )) {
    throw new HttpsError(
      "invalid-argument",
      "Mindestens eine Maschinen-ID ist ungültig.",
    );
  }

  const machineIds = Array.from(new Set(rawMachineIds as string[]));
  if (machineIds.length !== rawMachineIds.length) {
    throw new HttpsError(
      "invalid-argument",
      "Eine Maschine wurde mehrfach ausgewählt.",
    );
  }

  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) {
      throw new HttpsError("not-found", "Das Benutzerprofil fehlt.");
    }

    const companyId = userSnapshot.get("companyId");
    if (typeof companyId !== "string" || !companyId) {
      throw new HttpsError(
        "failed-precondition",
        "Der Benutzer gehört keiner Firma an.",
      );
    }

    const companyRef = db.collection("companies").doc(companyId);
    const memberRef = companyRef.collection("members").doc(uid);
    const [companySnapshot, memberSnapshot] = await transaction.getAll(
      companyRef, memberRef,
    );

    if (!companySnapshot.exists) {
      throw new HttpsError("not-found", "Die Firma wurde nicht gefunden.");
    }
    requireCompanyAccess(companySnapshot.data() || {});
    if (companySnapshot.get("status") !== "active") {
      throw new HttpsError("failed-precondition", "Die Firma ist nicht aktiv.");
    }
    if (!memberSnapshot.exists || memberSnapshot.get("status") !== "active") {
      throw new HttpsError(
        "permission-denied", "Die Firmenmitgliedschaft ist nicht aktiv.",
      );
    }
    if (!["owner", "admin"].includes(memberSnapshot.get("role"))) {
      throw new HttpsError(
        "permission-denied", "Nur Owner und Admins dürfen importieren.",
      );
    }

    const privateMachinesRef = userRef.collection("machines");
    const companyMachinesRef = companyRef.collection("machines");
    const sourceRefs = machineIds.map((id) => privateMachinesRef.doc(id));
    const destinationIds = machineIds.map((id) =>
      createHash("sha256").update(`${uid}:${id}`).digest("hex"),
    );
    const destinationRefs = destinationIds.map((id) =>
      companyMachinesRef.doc(id),
    );
    const sourceSnapshots = await transaction.getAll(
      sourceRefs[0], ...sourceRefs.slice(1),
    );
    const destinationSnapshots = await transaction.getAll(
      destinationRefs[0], ...destinationRefs.slice(1),
    );

    const missingMachineIds: string[] = [];
    const alreadyImportedMachineIds: string[] = [];
    const maintenanceAlreadyPresentMachineIds: string[] = [];
    const maintenanceBackfilledMachineIds: string[] = [];
    const machinesToCopy: MachineImport[] = [];
    let requiredWrites = 0;

    for (let index = 0; index < machineIds.length; index += 1) {
      const source = sourceSnapshots[index];
      const destination = destinationSnapshots[index];
      const sourceData = source.data();
      const sourceMachineId = machineIds[index];
      const destinationRef = destinationRefs[index];

      if (!source.exists || !sourceData) {
        missingMachineIds.push(sourceMachineId);
        continue;
      }

      if (destination.exists) {
        if (destination.get("sourceOwnerUid") !== uid ||
            destination.get("sourceMachineId") !== sourceMachineId) {
          throw new HttpsError(
            "already-exists",
            "Die Ziel-ID wird bereits von einer anderen Maschine verwendet.",
          );
        }
        alreadyImportedMachineIds.push(sourceMachineId);
      }

      const destinationHasMaintenance = await hasMaintenance(
        transaction, destinationRef,
      );
      if (destinationHasMaintenance) {
        if (destination.exists) {
          maintenanceAlreadyPresentMachineIds.push(sourceMachineId);
          continue;
        }
        throw new HttpsError(
          "failed-precondition",
          "Unter einer Ziel-ID existieren bereits Wartungsdaten.",
        );
      }

      const maintenance = await readMaintenance(
        transaction, sourceRefs[index],
      );
      const count = maintenanceCount(maintenance);
      if (count > 0 && !maintenance.maintenanceSettings.some(
        (document) => document.id === "config",
      )) {
        throw new HttpsError(
          "failed-precondition",
          "Private Wartungsdaten haben keine gültige Konfiguration.",
        );
      }

      const tools = destination.exists ? [] :
        (await transaction.get(sourceRefs[index].collection("werkzeuge")
          .limit(MAX_WRITES_PER_IMPORT + 1))).docs;
      const additions = (destination.exists ? 0 : 1 + tools.length) + count;
      requiredWrites += additions;
      if (requiredWrites > MAX_WRITES_PER_IMPORT) {
        throw new HttpsError(
          "resource-exhausted",
          "Die Auswahl enthält zu viele Werkzeuge oder Wartungseinträge. " +
          "Importiere weniger Maschinen gleichzeitig.",
        );
      }

      if (destination.exists && count === 0) continue;
      machinesToCopy.push({
        sourceMachineId,
        destinationMachineId: destinationIds[index],
        sourceData,
        destinationRef,
        tools,
        maintenance,
        isNewMachine: !destination.exists,
      });
    }

    if (missingMachineIds.length > 0) {
      throw new HttpsError(
        "not-found",
        "Mindestens eine private Maschine wurde nicht gefunden.",
        {machineIds: missingMachineIds},
      );
    }

    // Every read above is complete before the first write below.
    for (const machine of machinesToCopy) {
      if (machine.isNewMachine) {
        transaction.create(machine.destinationRef, {
          ...machine.sourceData,
          sourceOwnerUid: uid,
          sourceMachineId: machine.sourceMachineId,
          importedByUid: uid,
          companyImportedAt: FieldValue.serverTimestamp(),
        });
        for (const tool of machine.tools) {
          transaction.create(
            machine.destinationRef.collection("werkzeuge").doc(tool.id),
            tool.data(),
          );
        }
      } else {
        maintenanceBackfilledMachineIds.push(machine.sourceMachineId);
      }

      for (const name of MAINTENANCE_COLLECTIONS) {
        for (const document of machine.maintenance[name]) {
          transaction.create(
            machine.destinationRef.collection(name).doc(document.id),
            document.data(),
          );
        }
      }
    }

    return {
      companyId,
      importedMachines: machinesToCopy.filter((machine) =>
        machine.isNewMachine).map((machine) => ({
        sourceMachineId: machine.sourceMachineId,
        companyMachineId: machine.destinationMachineId,
        name: typeof machine.sourceData.name === "string" ?
          machine.sourceData.name : "",
        toolCount: machine.tools.length,
        maintenancePlanCount: machine.maintenance.maintenancePlans.length,
        maintenanceEventCount: machine.maintenance.maintenanceEvents.length,
      })),
      alreadyImportedMachineIds,
      maintenanceBackfilledMachineIds,
      maintenanceAlreadyPresentMachineIds,
    };
  });
});
