import {createHash} from "node:crypto";
import {FieldValue} from "firebase-admin/firestore";
import type {DocumentReference} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {requireCompanyAccess} from "../shared/companyAccess";

const MAX_LISTS = 20;
const MAX_CHANGES_PER_LIST = 200;
const MAX_WRITES = 450;

/**
 * Checks whether a member may import private code lists into the company.
 * @param {string} uid Firebase user ID.
 * @return {Promise<object>} Company ID and company reference.
 */
async function permittedCompany(uid: string) {
  const user = await db.collection("users").doc(uid).get();
  const companyId = user.get("companyId");
  if (typeof companyId !== "string" || !companyId) {
    throw new HttpsError("failed-precondition", "Keine Firma vorhanden.");
  }
  const companyRef = db.collection("companies").doc(companyId);
  const [company, member] = await Promise.all([
    companyRef.get(), companyRef.collection("members").doc(uid).get(),
  ]);
  if (!company.exists || company.get("status") !== "active") {
    throw new HttpsError("failed-precondition", "Firma nicht aktiv.");
  }
  requireCompanyAccess(company.data() || {});
  if (member.get("status") !== "active" ||
      !["owner", "admin"].includes(member.get("role"))) {
    throw new HttpsError("permission-denied", "Keine Importberechtigung.");
  }
  return {companyId, companyRef};
}

// listDocuments includes older parents with a changes subcollection but no
// parent document, as created by the previous Android implementation.
export const listPrivateCodeListsForImport = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }
  const uid = request.auth.uid;
  const {companyRef} = await permittedCompany(uid);
  const refs = await db.collection("users").doc(uid)
    .collection("code_changes").listDocuments();
  if (refs.length > 500) {
    throw new HttpsError("resource-exhausted", "Zu viele Codelisten.");
  }
  const result = await Promise.all(refs.map(async (ref) => {
    const destinationRef = companyRef.collection("code_changes").doc(ref.id);
    const [changes, companyList, companyChanges] = await Promise.all([
      ref.collection("changes").limit(MAX_CHANGES_PER_LIST + 1).get(),
      destinationRef.get(),
      destinationRef.collection("changes").limit(1).get(),
    ]);
    return {
      filename: ref.id,
      changeCount: changes.size,
      tooManyChanges: changes.size > MAX_CHANGES_PER_LIST,
      alreadyImported: companyList.exists || !companyChanges.empty,
    };
  }));
  return {lists: result.filter((entry) => entry.changeCount > 0)};
});

export const importPrivateCodeListsToCompany = onCall({
  timeoutSeconds: 180,
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Du musst angemeldet sein.");
  }
  const raw: unknown = request.data?.codeFilenames;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LISTS ||
      raw.some((value) => typeof value !== "string" ||
        !/^[a-zA-Z0-9_.-]{1,200}$/.test(value)) ||
      new Set(raw).size !== raw.length) {
    throw new HttpsError("invalid-argument", "Ungültige Codelisten-Auswahl.");
  }
  const filenames = raw as string[];
  // Old clients omit this option. The safe default preserves company changes.
  const existingMode: unknown = request.data?.existingMode ?? "merge";
  if (existingMode !== "merge" && existingMode !== "replace") {
    throw new HttpsError("invalid-argument", "Importmodus ungültig.");
  }
  const uid = request.auth.uid;
  const {companyId} = await permittedCompany(uid);
  const userRef = db.collection("users").doc(uid);
  const companyRef = db.collection("companies").doc(companyId);

  return db.runTransaction(async (transaction) => {
    // Recheck identity and permissions inside the write transaction.
    const [user, company, member] = await transaction.getAll(
      userRef, companyRef, companyRef.collection("members").doc(uid));
    if (user.get("companyId") !== companyId ||
        company.get("status") !== "active" ||
        member.get("status") !== "active" ||
        !["owner", "admin"].includes(member.get("role"))) {
      throw new HttpsError("permission-denied", "Firmenzugriff geändert.");
    }
    requireCompanyAccess(company.data() || {});
    const destinationRefs = filenames.map((name) =>
      companyRef.collection("code_changes").doc(name));
    const destinations = await transaction.getAll(
      destinationRefs[0], ...destinationRefs.slice(1));
    const pending: Array<{
      filename: string;
      ref: DocumentReference;
      existing: boolean;
      parentExists: boolean;
      entries: Array<{
        id: string;
        data: {
          action: string;
          originalCode: string;
          code: string;
          function: string;
          example: string;
        };
      }>;
      companyEntries: Array<{
        id: string;
      }>;
    }> = [];
    let writeCount = 0;

    for (let i = 0; i < filenames.length; i += 1) {
      const changes = await transaction.get(userRef.collection("code_changes")
        .doc(filenames[i]).collection("changes")
        .limit(MAX_CHANGES_PER_LIST + 1));
      if (changes.empty) {
        throw new HttpsError("not-found", "Private Codeliste fehlt.");
      }
      if (changes.size > MAX_CHANGES_PER_LIST) {
        throw new HttpsError("resource-exhausted", "Codeliste zu gross.");
      }
      const entries = changes.docs.map((change) => {
        const data = change.data();
        const original = data.originalCode;
        const code = data.code;
        const action = data.action;
        const functionText = data.function ?? "";
        const exampleText = data.example ?? "";
        if (typeof original !== "string" || !original ||
            original.length > 100 || typeof code !== "string" ||
            code.length > 100 ||
            !["add", "update", "delete"].includes(action) ||
            typeof functionText !== "string" ||
            functionText.length > 4000 ||
            typeof exampleText !== "string" ||
            exampleText.length > 4000) {
          throw new HttpsError("invalid-argument", "Ungültiger Codeeintrag.");
        }
        return {
          id: createHash("sha256")
            .update(original.toUpperCase()).digest("hex"),
          data: {
            action, originalCode: original, code,
            function: functionText, example: exampleText,
          },
        };
      });
      const ids = entries.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) {
        throw new HttpsError(
          "invalid-argument", "Private Codeliste enthält doppelte Codes.",
        );
      }

      // A parent can be missing while changes still exist underneath it.
      const companyChanges = await transaction.get(destinationRefs[i]
        .collection("changes").limit(MAX_WRITES + 1));
      if (companyChanges.size > MAX_WRITES) {
        throw new HttpsError("resource-exhausted", "Firmenliste zu gross.");
      }
      const existing = destinations[i].exists || !companyChanges.empty;
      const companyEntries = companyChanges.docs.map((doc) => ({id: doc.id}));
      const companyIds = new Set(companyEntries.map((entry) => entry.id));
      const sourceIds = new Set(ids);
      const added = entries.filter((entry) => !companyIds.has(entry.id));
      const removed = companyEntries.filter((entry) =>
        !sourceIds.has(entry.id));

      const writes = !existing ? 1 + entries.length :
        existingMode === "merge" ?
          added.length + (destinations[i].exists ? 0 : 1) :
          1 + entries.length + removed.length;
      writeCount += writes;
      if (writeCount > MAX_WRITES) {
        throw new HttpsError(
          "resource-exhausted",
          "Zu viele Codeeinträge. Wähle weniger Listen gleichzeitig.",
        );
      }
      pending.push({
        filename: filenames[i], ref: destinationRefs[i], entries,
        companyEntries, existing,
        parentExists: destinations[i].exists,
      });
    }

    const importedCodeFilenames: string[] = [];
    const mergedCodeFilenames: string[] = [];
    const replacedCodeFilenames: string[] = [];
    const unchangedCodeFilenames: string[] = [];
    const alreadyImportedCodeFilenames: string[] = [];
    let addedEntries = 0;
    let updatedEntries = 0;
    let removedEntries = 0;

    // Firestore requires all transaction reads before any writes.
    for (const list of pending) {
      const oldIds = new Set(list.companyEntries.map((entry) => entry.id));
      const sourceIds = new Set(list.entries.map((entry) => entry.id));
      if (!list.existing) {
        transaction.create(list.ref, {
          filename: list.filename,
          sourceOwnerUid: uid,
          companyImportedAt: FieldValue.serverTimestamp(),
        });
        for (const entry of list.entries) {
          transaction.create(list.ref.collection("changes").doc(entry.id),
            entry.data);
        }
        addedEntries += list.entries.length;
        importedCodeFilenames.push(list.filename);
        continue;
      }

      alreadyImportedCodeFilenames.push(list.filename);
      if (existingMode === "merge") {
        if (!list.parentExists) {
          transaction.create(list.ref, {
            filename: list.filename,
            sourceOwnerUid: uid,
            companyImportedAt: FieldValue.serverTimestamp(),
          });
        }
        const missing = list.entries.filter((entry) => !oldIds.has(entry.id));
        for (const entry of missing) {
          transaction.create(list.ref.collection("changes").doc(entry.id),
            entry.data);
        }
        addedEntries += missing.length;
        if (missing.length) mergedCodeFilenames.push(list.filename);
        else unchangedCodeFilenames.push(list.filename);
        continue;
      }

      // Replace the overlay for this one file, not the app's bundled codes.
      transaction.set(list.ref, {
        filename: list.filename,
        codeReimportedByUid: uid,
        codeReimportedAt: FieldValue.serverTimestamp(),
      }, {merge: true});
      for (const entry of list.companyEntries) {
        if (!sourceIds.has(entry.id)) {
          transaction.delete(list.ref.collection("changes").doc(entry.id));
          removedEntries++;
        }
      }
      for (const entry of list.entries) {
        transaction.set(list.ref.collection("changes").doc(entry.id),
          entry.data);
        if (oldIds.has(entry.id)) updatedEntries++;
        else addedEntries++;
      }
      replacedCodeFilenames.push(list.filename);
    }
    return {
      companyId,
      importedCodeFilenames,
      mergedCodeFilenames,
      replacedCodeFilenames,
      unchangedCodeFilenames,
      alreadyImportedCodeFilenames,
      addedEntries,
      updatedEntries,
      removedEntries,
    };
  });
});
