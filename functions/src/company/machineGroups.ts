import {FieldValue} from "firebase-admin/firestore";
import type {
  DocumentReference,
  Transaction,
} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {requireCompanyAccess} from "../shared/companyAccess";

/**
 * Validates a directory document ID.
 * @param {unknown} value Candidate ID.
 * @param {string} label Field name for validation errors.
 * @return {string} Validated ID.
 */
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new HttpsError("invalid-argument", `${label} ist ungültig.`);
  }
  return value;
}
/**
 * Normalizes and validates a group name.
 * @param {unknown} value Candidate name.
 * @return {string} Normalized name.
 */
function name(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "Der Gruppenname fehlt.");
  }
  const result = value.trim().replace(/\s+/g, " ");
  if (!result || result.length > 80) {
    throw new HttpsError(
      "invalid-argument",
      "Der Gruppenname muss 1–80 Zeichen enthalten.",
    );
  }
  return result;
}
/**
 * Reads an integer ordering value from stored data.
 * @param {unknown} value Stored ordering value.
 * @return {number} Safe ordering value.
 */
function rank(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ?
    value :
    0;
}

/**
 * Verifies the account scope, membership and required role.
 * @param {Transaction} tx Current transaction.
 * @param {string} uid Authenticated user ID.
 * @param {string|null} companyId Selected company or private scope.
 * @param {boolean} manage Whether administrative permissions are required.
 * @return {Promise<DocumentReference>} Authorized owner document.
 */
async function authorize(
  tx: Transaction,
  uid: string,
  companyId: string | null,
  manage: boolean,
): Promise<DocumentReference> {
  const user = await tx.get(db.collection("users").doc(uid));
  if (!user.exists || (user.get("companyId") || null) !== companyId) {
    throw new HttpsError(
      "permission-denied",
      "Der Accountbereich hat sich geändert.",
    );
  }
  if (!companyId) return user.ref;
  const companyRef = db.collection("companies").doc(companyId);
  const [company, member] = await tx.getAll(
    companyRef,
    companyRef.collection("members").doc(uid),
  );
  requireCompanyAccess(company.data() || {});
  if (
    !member.exists ||
    member.get("status") !== "active" ||
    !["owner", "admin", "editor", "viewer"].includes(member.get("role")) ||
    (manage && !["owner", "admin"].includes(member.get("role")))
  ) {
    throw new HttpsError(
      "permission-denied",
      "Nur Inhaber und Administratoren dürfen Gruppen verwalten.",
    );
  }
  return companyRef;
}

/**
 * Backfills stored null group IDs so equality queries include old machines.
 */
export const prepareMachineGroups = onCall(
  {timeoutSeconds: 180},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bitte anmelden.");
    }
    const uid = request.auth.uid;
    const companyId =
      request.data?.companyId == null ?
        null :
        id(request.data.companyId, "Firma");
    const owner = await db.runTransaction((tx) =>
      authorize(tx, uid, companyId, false),
    );
      // Creates/imports require groupId; a completed backfill stays valid.
    if ((await owner.get()).get("machineGroupsSchemaVersion") === 1) {
      return {ready: true};
    }
    const machines = await owner.collection("machines").get();
    const names: string[] =
      !companyId && Array.isArray(request.data?.legacyNames) ?
        request.data.legacyNames
          .filter((value: unknown) => typeof value === "string")
          .slice(0, 10000) :
        [];
    const oldOrder = new Map(names.map((value, index) => [value, index]));
    const ordered = machines.docs
      .slice()
      .sort(
        (a, b) =>
          (oldOrder.get(a.get("name")) ?? Number.MAX_SAFE_INTEGER) -
            (oldOrder.get(b.get("name")) ?? Number.MAX_SAFE_INTEGER) ||
          String(a.get("name")).localeCompare(String(b.get("name")), "de"),
      );
    const missing = ordered.filter(
      (doc) =>
        doc.get("groupId") === undefined ||
        doc.get("sortOrder") === undefined,
    );
    for (let offset = 0; offset < missing.length; offset += 200) {
      await db.runTransaction(async (tx) => {
        await authorize(tx, uid, companyId, false);
        const docs = await tx.getAll(
          ...missing.slice(offset, offset + 200).map((doc) => doc.ref),
        );
        docs.forEach((doc, index) => {
          if (!doc.exists) return;
          const update: Record<string, unknown> = {};
          if (doc.get("groupId") === undefined) update.groupId = null;
          if (doc.get("sortOrder") === undefined) {
            update.sortOrder = offset + index;
          }
          if (Object.keys(update).length) tx.update(doc.ref, update);
        });
      });
    }
    await db.runTransaction(async (tx) => {
      await authorize(tx, uid, companyId, false);
      tx.update(owner, {machineGroupsSchemaVersion: 1});
    });
    return {ready: true};
  },
);

export const manageMachineGroups = onCall(
  {timeoutSeconds: 180},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bitte anmelden.");
    }
    const uid = request.auth.uid;
    const data = request.data || {};
    const companyId =
      data.companyId == null ? null : id(data.companyId, "Firma");
    const operation: string = data.operation;
    const groupId =
      operation === "create" ?
        id(data.groupId, "Gruppe") :
        data.groupId == null ?
          null :
          id(data.groupId, "Gruppe");

    if (operation === "delete") {
      if (!groupId) {
        throw new HttpsError("invalid-argument", "Die Gruppe fehlt.");
      }
      // A tombstone blocks assignments while chunks are removed or retried.
      const owner = await db.runTransaction(async (tx) => {
        const ref = await authorize(tx, uid, companyId, true);
        const group = await tx.get(
          ref.collection("machineGroups").doc(groupId),
        );
        if (group.exists) tx.update(group.ref, {deleting: true});
        return ref;
      });
      let remaining = true;
      while (remaining) {
        const count = await db.runTransaction(async (tx) => {
          await authorize(tx, uid, companyId, true);
          const rows = await tx.get(
            owner
              .collection("machines")
              .where("groupId", "==", groupId)
              .limit(200),
          );
          const ungrouped = await tx.get(
            owner.collection("machines").where("groupId", "==", null),
          );
          const last = Math.max(
            -1,
            ...ungrouped.docs.map((doc) => rank(doc.get("sortOrder"))),
          );
          rows.docs.forEach((doc, index) =>
            tx.update(doc.ref, {
              groupId: null,
              sortOrder: last + index + 1,
            }),
          );
          return rows.size;
        });
        remaining = count > 0;
      }
      await db.runTransaction(async (tx) => {
        await authorize(tx, uid, companyId, true);
        tx.delete(owner.collection("machineGroups").doc(groupId));
      });
      return {groupId};
    }

    return db.runTransaction(async (tx) => {
      const owner = await authorize(tx, uid, companyId, true);
      const groupsRef = owner.collection("machineGroups");
      const groups = await tx.get(groupsRef);
      const group = groups.docs.find((doc) => doc.id === groupId);
      if (
        groupId &&
        operation !== "create" &&
        (!group || group.get("deleting") === true)
      ) {
        throw new HttpsError(
          "not-found",
          "Die Gruppe ist nicht mehr verfügbar.",
        );
      }
      if (operation === "create" || operation === "rename") {
        const groupName = name(data.name);
        if (
          groups.docs.some(
            (doc) =>
              doc.id !== groupId &&
              String(doc.get("name"))
                .normalize("NFKC")
                .toLocaleLowerCase("de") ===
                groupName.normalize("NFKC").toLocaleLowerCase("de"),
          )
        ) {
          throw new HttpsError(
            "already-exists",
            "Eine Gruppe mit diesem Namen existiert bereits.",
          );
        }
        if (operation === "rename") {
          if (!group) {
            throw new HttpsError("not-found", "Die Gruppe fehlt.");
          }
          tx.update(group.ref, {name: groupName});
        } else {
          if (group) {
            throw new HttpsError(
              "already-exists",
              "Diese Gruppen-ID existiert bereits.",
            );
          }
          const members = companyId ?
            await tx.get(
              owner.collection("members").where("status", "==", "active"),
            ) :
            null;
          const sortOrder =
            Math.max(
              -1,
              ...groups.docs.map((doc) => rank(doc.get("sortOrder"))),
            ) + 1;
          tx.create(groupsRef.doc(id(groupId, "Gruppe")), {
            name: groupName,
            sortOrder,
            visibleTo: members ? members.docs.map((doc) => doc.id) : [uid],
            deleting: false,
          });
        }
        return {groupId, name: groupName};
      }
      if (operation === "setVisibility") {
        if (!companyId || !group || typeof data.visible !== "boolean") {
          throw new HttpsError(
            "invalid-argument",
            "Ungültige Sichtbarkeit.",
          );
        }
        const memberId = id(data.memberId, "Mitglied");
        const member = await tx.get(
          owner.collection("members").doc(memberId),
        );
        if (!member.exists || member.get("status") !== "active") {
          throw new HttpsError(
            "not-found",
            "Das Mitglied ist nicht aktiv.",
          );
        }
        tx.update(group.ref, {
          visibleTo: data.visible ?
            FieldValue.arrayUnion(memberId) :
            FieldValue.arrayRemove(memberId),
        });
        return {groupId, memberId, visible: data.visible};
      }
      if (operation === "assign") {
        const machineId = id(data.machineId, "Maschine");
        const machineRef = owner.collection("machines").doc(machineId);
        const machine = await tx.get(machineRef);
        if (!machine.exists) {
          throw new HttpsError("not-found", "Die Maschine fehlt.");
        }
        const rows = await tx.get(
          owner.collection("machines").where("groupId", "==", groupId),
        );
        if ((machine.get("groupId") || null) !== groupId) {
          const sortOrder =
            Math.max(
              -1,
              ...rows.docs.map((doc) => rank(doc.get("sortOrder"))),
            ) + 1;
          tx.update(machineRef, {groupId, sortOrder});
        }
        return {machineId, groupId};
      }
      if (operation === "moveGroup" || operation === "moveMachine") {
        if (data.direction !== -1 && data.direction !== 1) {
          throw new HttpsError("invalid-argument", "Ungültige Richtung.");
        }
        const machineId =
          operation === "moveMachine" ?
            id(data.machineId, "Maschine") :
            null;
        const rows =
          operation === "moveGroup" ?
            groups.docs.filter((doc) => !doc.get("deleting")) :
            (
              await tx.get(
                owner
                  .collection("machines")
                  .where("groupId", "==", groupId),
              )
            ).docs;
        const sorted = rows
          .slice()
          .sort(
            (a, b) =>
              rank(a.get("sortOrder")) - rank(b.get("sortOrder")) ||
              String(a.get("name")).localeCompare(
                String(b.get("name")),
                "de",
              ) ||
              a.id.localeCompare(b.id),
          );
        const index = sorted.findIndex(
          (doc) => doc.id === (machineId || groupId),
        );
        if (index < 0) {
          throw new HttpsError("not-found", "Der Eintrag fehlt.");
        }
        const other =
          data.otherMachineId == null ?
            sorted[index + data.direction] :
            sorted.find(
              (doc) => doc.id === id(data.otherMachineId, "Zielmaschine"),
            );
        const otherIndex = other ? sorted.indexOf(other) : -1;
        if (!other) return {changed: false};
        // Reindex legacy ties; normally only two documents change.
        const ranks = sorted.map((doc) => rank(doc.get("sortOrder")));
        if (new Set(ranks).size !== ranks.length) {
          if (sorted.length > 450) {
            throw new HttpsError(
              "resource-exhausted",
              "Die Reihenfolge muss zuerst bereinigt werden.",
            );
          }
          [sorted[index], sorted[otherIndex]] = [other, sorted[index]];
          sorted.forEach((doc, order) =>
            tx.update(doc.ref, {sortOrder: order}),
          );
        } else {
          tx.update(sorted[index].ref, {
            sortOrder: rank(other.get("sortOrder")),
          });
          tx.update(other.ref, {
            sortOrder: rank(sorted[index].get("sortOrder")),
          });
        }
        return {changed: true};
      }
      throw new HttpsError("invalid-argument", "Unbekannte Gruppenaktion.");
    });
  },
);
