import {getFirestore} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";

// Als functions/src/maintenanceActor.ts neben index.ts ablegen.
// In index.ts ergänzen:
// export {getMaintenanceActor} from "./maintenanceActor";
// Die bestehende zentrale Initialisierung in firebase.ts beibehalten.

interface MaintenanceActorSnapshot {
  uid: string;
  email: string;
  firstName: string;
  lastName: string;
  nameSource: "company";
}

export const getMaintenanceActor = onCall(
  {region: "europe-west1"},
  async (request): Promise<MaintenanceActorSnapshot> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Bitte zuerst anmelden.");
    }

    const input: unknown = request.data;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpsError("invalid-argument", "Ungültige Firmenzuordnung.");
    }

    const payload = input as Record<string, unknown>;
    const companyId = payload.companyId;
    if (
      Object.keys(payload).some((key) => key !== "companyId") ||
      typeof companyId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(companyId)
    ) {
      throw new HttpsError("invalid-argument", "Ungültige Firmenzuordnung.");
    }

    // UID und E-Mail stammen nur aus dem geprüften Anmeldetoken.
    // Andere Mitglieder oder eigene Namen können nicht angefordert werden.
    const uid = request.auth.uid;
    const email = typeof request.auth.token.email === "string" ?
      request.auth.token.email : "";

    // Erst beim Aufruf abrufen: Die bestehenden Functions haben dann die
    // gemeinsame firebase.ts bereits geladen und Firebase initialisiert.
    // Kein zweites initializeApp() in diesem Modul.
    const db = getFirestore();
    const company = db.collection("companies").doc(companyId);

    return db.runTransaction<MaintenanceActorSnapshot>(async (tx) => {
      const member = await tx.get(company.collection("members").doc(uid));
      const membership = member.data() || {};
      if (
        !member.exists ||
        membership.status !== "active" ||
        typeof membership.role !== "string" ||
        !["owner", "admin", "editor", "viewer"].includes(membership.role)
      ) {
        throw new HttpsError(
          "permission-denied",
          "Keine aktive Mitgliedschaft in dieser Firma."
        );
      }

      const profileDocument = await tx.get(
        company.collection("memberAdminData").doc(uid)
      );
      const profile = profileDocument.data() || {};

      // Unverändert übernehmen, damit die Firestore-Regeln diese Werte beim
      // Speichern der Bestätigung prüfen können. Die Anzeige trimmt Leerraum.
      const firstName = typeof profile.firstName === "string" ?
        profile.firstName : "";
      const lastName = typeof profile.lastName === "string" ?
        profile.lastName : "";
      if (email.length > 320 || firstName.length > 200 || lastName.length > 200) {
        throw new HttpsError(
          "failed-precondition",
          "Die gespeicherten Namens- oder E-Mail-Felder sind zu lang."
        );
      }

      // Nur die eigene Identität, keine internen Notizen oder Personaldaten.
      // Diese Funktion liest nur. Die App speichert die Rückgabe direkt im
      // Wartungsereignis; spätere Profiländerungen ändern alte Ereignisse nicht.
      return {uid, email, firstName, lastName, nameSource: "company"};
    });
  }
);
