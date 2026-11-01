import {createHash} from "node:crypto";
import {FieldValue} from "firebase-admin/firestore";
import {planCodeImport} from "./codeImportPlan";
import type {CodeEntry} from "./codeImportPlan";
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
  const updateExisting = request.data?.updateExisting ?? false;
  if (typeof updateExisting !== "boolean") {
    throw new HttpsError("invalid-argument", "Importoption ungültig.");
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
      existing: boolean;
      parentExists: boolean;
      ref: typeof destinationRefs[number];
      report: ReturnType<typeof planCodeImport>;
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
      const companyEntries: CodeEntry[] = companyChanges.docs.map((doc) => ({
        id: doc.id, data: doc.data() as CodeEntry["data"],
      }));
      const report = planCodeImport(entries, companyEntries,
        existingMode === "replace", updateExisting);
      const writes = 1 + report.filter((entry) =>
        entry.write || entry.remove).length;
      writeCount += writes;
      if (writeCount > MAX_WRITES) {
        throw new HttpsError(
          "resource-exhausted",
          "Zu viele Codeeinträge. Wähle weniger Listen gleichzeitig.",
        );
      }
      pending.push({
        filename: filenames[i], ref: destinationRefs[i], report, existing,
        parentExists: destinations[i].exists,
      });
    }

    // Bound the callable response before committing any writes.
    if (Buffer.byteLength(JSON.stringify(pending.map((list) => ({
      filename: list.filename, entries: list.report,
    }))), "utf8") > 7 * 1024 * 1024) {
      throw new HttpsError("resource-exhausted",
        "Importbericht zu gross. Wähle weniger Listen gleichzeitig.");
    }

    const importedCodeFilenames: string[] = [];
    const mergedCodeFilenames: string[] = [];
    const replacedCodeFilenames: string[] = [];
    const unchangedCodeFilenames: string[] = [];
    const alreadyImportedCodeFilenames: string[] = [];
    let addedEntries = 0;
    let updatedEntries = 0;
    let removedEntries = 0;

    let restoredEntries = 0;
    const changeReport: Array<{
      filename: string;
      entries: ReturnType<typeof planCodeImport>;
    }> = [];
    // Firestore requires all transaction reads before any writes.
    for (const list of pending) {
      const changed = list.report.some((entry) => entry.write || entry.remove);
      if (changed || !list.parentExists) {
        transaction.set(list.ref, {
          filename: list.filename,
          codeReimportedByUid: uid,
          codeReimportedAt: FieldValue.serverTimestamp(),
          ...(!list.parentExists ? {
            sourceOwnerUid: uid,
            companyImportedAt: FieldValue.serverTimestamp(),
          } : {}),
        }, {merge: true});
      }
      for (const entry of list.report) {
        const ref = list.ref.collection("changes").doc(entry.id);
        if (entry.remove) {
          transaction.delete(ref);
          removedEntries++;
        } else if (entry.write && entry.after) {
          transaction.set(ref, entry.after);
          if (entry.status === "added") addedEntries++;
          else if (entry.status === "restored") restoredEntries++;
          else updatedEntries++;
        }
      }
      if (!list.existing) importedCodeFilenames.push(list.filename);
      else {
        alreadyImportedCodeFilenames.push(list.filename);
        if (!changed) unchangedCodeFilenames.push(list.filename);
        else if (existingMode === "replace") {
          replacedCodeFilenames.push(list.filename);
        } else mergedCodeFilenames.push(list.filename);
      }
      changeReport.push({filename: list.filename, entries: list.report});
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
      restoredEntries,
      changeReport,
    };
  });
});
