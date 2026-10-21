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
            archiveData: null,
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

        const rawName = companySnapshot.get("name");
        const rawSeatLimit = companySnapshot.get("seatLimit");
        const rawActiveMemberCount =
          companySnapshot.get("activeMemberCount");
        const rawPendingInvitationCount =
          companySnapshot.get("pendingInvitationCount");
        const rawBillingStatus =
          companySnapshot.get("billingStatus");
        const rawCreatedAt =
          companySnapshot.get("createdAt");

        const archiveData = {
          name:
            typeof rawName === "string" ?
              rawName :
              "",
          seatLimit:
            typeof rawSeatLimit === "number" ?
              rawSeatLimit :
              0,
          activeMemberCount:
            typeof rawActiveMemberCount === "number" ?
              rawActiveMemberCount :
              activeMembersSnapshot.size,
          pendingInvitationCount:
            typeof rawPendingInvitationCount === "number" ?
              rawPendingInvitationCount :
              pendingInvitationsSnapshot.size,
          billingStatus:
            typeof rawBillingStatus === "string" ?
              rawBillingStatus :
              "not_configured",
          createdAt:
            rawCreatedAt instanceof Timestamp ?
              rawCreatedAt :
              null,
        };

        transaction.update(companyRef, {
          status: "deleting",
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          companyId,
          alreadyDeleted: false,
          archiveData,
        };
      },
    );

    if (
      preparation.alreadyDeleted ||
      preparation.archiveData === null
    ) {
      return {
        companyId: preparation.companyId,
        status: "deleted",
      };
    }

    const companyRef = db
      .collection("companies")
      .doc(preparation.companyId);

    const archiveRef = db
      .collection("companyArchive")
      .doc(preparation.companyId);
    const billingDetailsRef = db
      .collection("companyBillingDetails")
      .doc(preparation.companyId);

    await archiveRef.set(
      {
        companyId: preparation.companyId,
        ...preparation.archiveData,
        archiveStatus: "deletion_pending",
        deletionStartedAt:
          FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    try {
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
      await billingDetailsRef.delete().catch(() => undefined);

      await archiveRef.set(
        {
          archiveStatus: "deleted",
          deletedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
    } catch (error) {
      await archiveRef.set(
        {
          archiveStatus: "deletion_failed",
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true},
      ).catch(() => undefined);

      throw error;
    }

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
