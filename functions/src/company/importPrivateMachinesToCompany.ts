import {createHash} from "node:crypto";
import {
  DocumentData,
  DocumentReference,
  FieldValue,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

const MAX_MACHINES_PER_IMPORT = 20;
const MAX_WRITES_PER_IMPORT = 450;

export const importPrivateMachinesToCompany = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const rawMachineIds: unknown = request.data?.machineIds;

    if (!Array.isArray(rawMachineIds)) {
      throw new HttpsError(
        "invalid-argument",
        "Die Maschinen-IDs fehlen.",
      );
    }

    if (
      rawMachineIds.length === 0 ||
      rawMachineIds.length > MAX_MACHINES_PER_IMPORT
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Wähle zwischen 1 und 20 Maschinen aus.",
      );
    }

    if (
      rawMachineIds.some((value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 200 ||
        value.includes("/") ||
        value.trim() !== value
      )
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Mindestens eine Maschinen-ID ist ungültig.",
      );
    }

    const machineIds = Array.from(
      new Set(rawMachineIds as string[]),
    );

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
        throw new HttpsError(
          "not-found",
          "Das Benutzerprofil wurde nicht gefunden.",
        );
      }

      const companyId = userSnapshot.get("companyId");

      if (
        typeof companyId !== "string" ||
        companyId.length === 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Der Benutzer gehört keiner Firma an.",
        );
      }

      const companyRef = db
        .collection("companies")
        .doc(companyId);
      const memberRef = companyRef
        .collection("members")
        .doc(uid);

      const companySnapshot = await transaction.get(companyRef);
      const memberSnapshot = await transaction.get(memberRef);

      if (!companySnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Die Firma wurde nicht gefunden.",
        );
      }

      if (companySnapshot.get("status") !== "active") {
        throw new HttpsError(
          "failed-precondition",
          "Die Firma ist nicht aktiv.",
        );
      }

      if (
        !memberSnapshot.exists ||
        memberSnapshot.get("status") !== "active"
      ) {
        throw new HttpsError(
          "permission-denied",
          "Die Firmenmitgliedschaft ist nicht aktiv.",
        );
      }

      const role = memberSnapshot.get("role");

      if (role !== "owner" && role !== "admin") {
        throw new HttpsError(
          "permission-denied",
          "Nur Owner und Admins dürfen Maschinen importieren.",
        );
      }

      const privateMachinesRef = userRef.collection("machines");
      const companyMachinesRef = companyRef.collection("machines");

      const sourceRefs = machineIds.map((machineId) =>
        privateMachinesRef.doc(machineId)
      );
      const destinationIds = machineIds.map((machineId) =>
        createHash("sha256")
          .update(`${uid}:${machineId}`)
          .digest("hex")
      );
      const destinationRefs = destinationIds.map((machineId) =>
        companyMachinesRef.doc(machineId)
      );

      const sourceSnapshots = await transaction.getAll(
        sourceRefs[0],
        ...sourceRefs.slice(1),
      );
      const destinationSnapshots = await transaction.getAll(
        destinationRefs[0],
        ...destinationRefs.slice(1),
      );

      const missingMachineIds: string[] = [];
      const alreadyImportedMachineIds: string[] = [];
      const machinesToImport: Array<{
        sourceMachineId: string;
        destinationMachineId: string;
        sourceData: DocumentData;
        destinationRef: DocumentReference;
        tools: QueryDocumentSnapshot[];
      }> = [];

      for (let index = 0; index < machineIds.length; index += 1) {
        const sourceSnapshot = sourceSnapshots[index];
        const destinationSnapshot = destinationSnapshots[index];
        const sourceMachineId = machineIds[index];
        const destinationMachineId = destinationIds[index];
        const sourceData = sourceSnapshot.data();

        if (!sourceSnapshot.exists || !sourceData) {
          missingMachineIds.push(sourceMachineId);
          continue;
        }

        if (destinationSnapshot.exists) {
          const importedOwnerUid =
            destinationSnapshot.get("sourceOwnerUid");
          const importedMachineId =
            destinationSnapshot.get("sourceMachineId");

          if (
            importedOwnerUid !== uid ||
            importedMachineId !== sourceMachineId
          ) {
            throw new HttpsError(
              "already-exists",
              "Eine Ziel-ID wird bereits von einer anderen " +
                "Maschine verwendet.",
            );
          }

          alreadyImportedMachineIds.push(sourceMachineId);
          continue;
        }

        const toolsSnapshot = await transaction.get(
          sourceRefs[index].collection("werkzeuge"),
        );

        machinesToImport.push({
          sourceMachineId,
          destinationMachineId,
          sourceData,
          destinationRef: destinationRefs[index],
          tools: toolsSnapshot.docs,
        });
      }

      if (missingMachineIds.length > 0) {
        throw new HttpsError(
          "not-found",
          "Mindestens eine ausgewählte private Maschine wurde nicht gefunden.",
          {machineIds: missingMachineIds},
        );
      }

      const requiredWrites = machinesToImport.reduce(
        (total, machine) => total + 1 + machine.tools.length,
        0,
      );

      if (requiredWrites > MAX_WRITES_PER_IMPORT) {
        throw new HttpsError(
          "resource-exhausted",
          "Die Auswahl enthält zu viele Werkzeuge. " +
            "Importiere weniger Maschinen gleichzeitig.",
        );
      }

      for (const machine of machinesToImport) {
        transaction.set(machine.destinationRef, {
          ...machine.sourceData,
          sourceOwnerUid: uid,
          sourceMachineId: machine.sourceMachineId,
          importedByUid: uid,
          companyImportedAt: FieldValue.serverTimestamp(),
        });

        for (const tool of machine.tools) {
          transaction.set(
            machine.destinationRef
              .collection("werkzeuge")
              .doc(tool.id),
            tool.data(),
          );
        }
      }

      return {
        companyId,
        importedMachines: machinesToImport.map((machine) => ({
          sourceMachineId: machine.sourceMachineId,
          companyMachineId: machine.destinationMachineId,
          name:
            typeof machine.sourceData.name === "string" ?
              machine.sourceData.name :
              "",
          toolCount: machine.tools.length,
        })),
        alreadyImportedMachineIds,
      };
    });
  },
);
