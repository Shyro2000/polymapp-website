import {
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";
import {
  HttpsError,
  onCall,
} from "firebase-functions/https";
import {db} from "../firebase";

export const deleteCompany = onCall(
  {
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const uid = request.auth.uid;
    const userRef = db.collection("users").doc(uid);

    const preparation = await db.runTransaction(
      async (transaction) => {
        const userSnapshot =
          await transaction.get(userRef);

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

        const ownerMemberRef = companyRef
          .collection("members")
          .doc(uid);

        const activeMembersQuery = companyRef
          .collection("members")
          .where("status", "==", "active");

        const pendingInvitationsQuery = db
          .collection("companyInvitations")
          .where("companyId", "==", companyId)
          .where("status", "==", "pending");

        const companySnapshot =
          await transaction.get(companyRef);

        if (!companySnapshot.exists) {
          transaction.update(userRef, {
            companyId: FieldValue.delete(),
            companyJoinedAt: FieldValue.delete(),
            companyMembershipUpdatedAt:
              FieldValue.serverTimestamp(),
          });

          return {
            companyId,
            alreadyDeleted: true,
          };
        }

        const ownerUid = companySnapshot.get("ownerUid");
        const companyStatus =
          companySnapshot.get("status");

        if (ownerUid !== uid) {
          throw new HttpsError(
            "permission-denied",
            "Nur der Inhaber darf die Firma löschen.",
          );
        }

        if (
          companyStatus !== "active" &&
          companyStatus !== "deleting"
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Die Firma kann in ihrem aktuellen Zustand nicht gelöscht werden.",
          );
        }

        const ownerMemberSnapshot =
          await transaction.get(ownerMemberRef);

        const activeMembersSnapshot =
          await transaction.get(activeMembersQuery);

        const pendingInvitationsSnapshot =
          await transaction.get(
            pendingInvitationsQuery,
          );

        const otherActiveMemberExists =
          activeMembersSnapshot.docs.some(
            (document) => document.id !== uid,
          );

        if (otherActiveMemberExists) {
          throw new HttpsError(
            "failed-precondition",
            "Entferne zuerst alle anderen Firmenmitglieder.",
          );
        }

        if (companyStatus === "active") {
          if (
            !ownerMemberSnapshot.exists ||
            ownerMemberSnapshot.get("status") !== "active" ||
            ownerMemberSnapshot.get("role") !== "owner"
          ) {
            throw new HttpsError(
              "failed-precondition",
              "Die Inhaber-Mitgliedschaft ist ungültig.",
            );
          }

          if (activeMembersSnapshot.size !== 1) {
            throw new HttpsError(
              "failed-precondition",
              "Die Firma enthält noch weitere aktive Mitglieder.",
            );
          }
        }

        const nowMilliseconds =
          Timestamp.now().toMillis();

        const activeInvitationExists =
          pendingInvitationsSnapshot.docs.some(
            (document) => {
              const expiresAt =
                document.get("expiresAt");

              return (
                !(expiresAt instanceof Timestamp) ||
                expiresAt.toMillis() > nowMilliseconds
              );
            },
          );

        if (activeInvitationExists) {
          throw new HttpsError(
            "failed-precondition",
            "Ziehe zuerst alle gültigen offenen Einladungen zurück.",
          );
        }

        transaction.update(companyRef, {
          status: "deleting",
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          companyId,
          alreadyDeleted: false,
        };
      },
    );

    if (preparation.alreadyDeleted) {
      return {
        companyId: preparation.companyId,
        status: "deleted",
      };
    }

    const companyRef = db
      .collection("companies")
      .doc(preparation.companyId);

    const invitationsSnapshot = await db
      .collection("companyInvitations")
      .where(
        "companyId",
        "==",
        preparation.companyId,
      )
      .get();

    if (!invitationsSnapshot.empty) {
      const bulkWriter = db.bulkWriter();

      for (const invitation of invitationsSnapshot.docs) {
        bulkWriter.delete(invitation.ref);
      }

      await bulkWriter.close();
    }

    await db.recursiveDelete(companyRef);

    await userRef.update({
      companyId: FieldValue.delete(),
      companyJoinedAt: FieldValue.delete(),
      companyMembershipUpdatedAt:
        FieldValue.serverTimestamp(),
    });

    return {
      companyId: preparation.companyId,
      status: "deleted",
    };
  },
);
