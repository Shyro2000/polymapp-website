import {createHash} from "node:crypto";
import {DocumentReference, FieldValue} from "firebase-admin/firestore";
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
    const [changes, companyList] = await Promise.all([
      ref.collection("changes").limit(MAX_CHANGES_PER_LIST + 1).get(),
      companyRef.collection("code_changes").doc(ref.id).get(),
    ]);
    return {
      filename: ref.id,
      changeCount: changes.size,
      tooManyChanges: changes.size > MAX_CHANGES_PER_LIST,
      alreadyImported: companyList.exists,
    };
  }));
  return {lists: result.filter((entry) => entry.changeCount > 0)};
});

export const importPrivateCodeListsToCompany = onCall(async (request) => {
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
    const toImport: Array<{
      filename: string;
      ref: DocumentReference;
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
    }> = [];
    const alreadyImportedCodeFilenames: string[] = [];
    let writeCount = 0;

    for (let i = 0; i < filenames.length; i += 1) {
      if (destinations[i].exists) {
        alreadyImportedCodeFilenames.push(filenames[i]);
        continue;
      }
      const changes = await transaction.get(userRef.collection("code_changes")
        .doc(filenames[i]).collection("changes"));
      if (changes.empty) {
        throw new HttpsError("not-found", "Private Codeliste fehlt.");
      }
      if (changes.size > MAX_CHANGES_PER_LIST) {
        throw new HttpsError("resource-exhausted", "Codeliste zu gross.");
      }
      writeCount += 1 + changes.size;
      if (writeCount > MAX_WRITES) {
        throw new HttpsError("resource-exhausted", "Zu viele Codeeinträge.");
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
      toImport.push({filename: filenames[i], ref: destinationRefs[i], entries});
    }

    for (const list of toImport) {
      transaction.set(list.ref, {
        filename: list.filename,
        sourceOwnerUid: uid,
        companyImportedAt: FieldValue.serverTimestamp(),
      });
      for (const entry of list.entries) {
        transaction.set(list.ref.collection("changes").doc(entry.id),
          entry.data);
      }
    }
    return {
      companyId,
      importedCodeFilenames: toImport.map((list) => list.filename),
      alreadyImportedCodeFilenames,
    };
  });
});
