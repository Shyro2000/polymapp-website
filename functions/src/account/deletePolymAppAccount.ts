import {getAuth} from "firebase-admin/auth";
import {
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

const MAX_SECONDS_SINCE_LOGIN = 5 * 60;

export const deletePolymAppAccount = onCall(
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

    const authTime = request.auth.token.auth_time;
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (
      typeof authTime !== "number" ||
      authTime > nowSeconds + 60 ||
      nowSeconds - authTime > MAX_SECONDS_SINCE_LOGIN
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Bitte bestätige zuerst erneut dein Passwort.",
        {reason: "recent_login_required"},
      );
    }

    const uid = request.auth.uid;
    const userRef = db.collection("users").doc(uid);

    const deletionPlan = await db.runTransaction(
      async (transaction) => {
        const userSnapshot = await transaction.get(userRef);

        if (!userSnapshot.exists) {
          return {
            companyId: null,
            companyName: null,
          };
        }

        const companyId = userSnapshot.get("companyId");

        if (
          companyId === undefined ||
          companyId === null
        ) {
          transaction.update(userRef, {
            accountDeletionStatus: "deleting",
            accountDeletionCompanyId: null,
            accountDeletionStartedAt:
              FieldValue.serverTimestamp(),
          });

          return {
            companyId: null,
            companyName: null,
          };
        }

        if (
          typeof companyId !== "string" ||
          companyId.length === 0
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Die Firmenzuordnung ist ungültig.",
          );
        }

        const companyRef = db
          .collection("companies")
          .doc(companyId);
        const memberRef = companyRef
          .collection("members")
          .doc(uid);

        const companySnapshot =
          await transaction.get(companyRef);

        if (!companySnapshot.exists) {
          const deletionStatus = userSnapshot.get(
            "accountDeletionStatus",
          );
          const deletionCompanyId = userSnapshot.get(
            "accountDeletionCompanyId",
          );

          if (
            deletionStatus === "deleting" &&
            deletionCompanyId === companyId
          ) {
            return {
              companyId,
              companyName: null,
            };
          }

          throw new HttpsError(
            "failed-precondition",
            "Die zugeordnete Firma wurde nicht gefunden.",
          );
        }

        const companyStatus = companySnapshot.get("status");

        if (
          companyStatus !== "active" &&
          companyStatus !== "deleting"
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Die Firma kann momentan nicht aufgelöst werden.",
          );
        }

        const memberSnapshot =
          await transaction.get(memberRef);

        if (
          !memberSnapshot.exists ||
          memberSnapshot.get("status") !== "active"
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Die Firmenmitgliedschaft ist nicht aktiv.",
          );
        }

        if (
          memberSnapshot.get("role") !== "owner" ||
          companySnapshot.get("ownerUid") !== uid
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Du musst zuerst aus der Firma austreten.",
            {reason: "leave_company_first"},
          );
        }

        if (companyStatus === "deleting") {
          return {
            companyId,
            companyName: companySnapshot.get("name") ?? null,
          };
        }

        const membersSnapshot = await transaction.get(
          companyRef.collection("members"),
        );
        const otherMembers = membersSnapshot.docs.filter(
          (document) => document.id !== uid,
        );

        if (otherMembers.length > 0) {
          throw new HttpsError(
            "failed-precondition",
            "Übertrage zuerst die Rechte oder entferne alle Mitglieder.",
            {
              reason: "company_has_members",
              memberCount: otherMembers.length,
            },
          );
        }

        const pendingInvitationsQuery = db
          .collection("companyInvitations")
          .where("companyId", "==", companyId)
          .where("status", "==", "pending");
        const pendingInvitationsSnapshot =
          await transaction.get(pendingInvitationsQuery);
        const nowMilliseconds = Timestamp.now().toMillis();
        const activeInvitations = [];
        const expiredInvitations = [];

        for (const invitation of pendingInvitationsSnapshot.docs) {
          const expiresAt = invitation.get("expiresAt");

          if (
            expiresAt instanceof Timestamp &&
            expiresAt.toMillis() > nowMilliseconds
          ) {
            activeInvitations.push(invitation);
          } else {
            expiredInvitations.push(invitation);
          }
        }

        if (activeInvitations.length > 0) {
          throw new HttpsError(
            "failed-precondition",
            "Ziehe zuerst alle offenen Einladungen zurück.",
            {
              reason: "company_has_pending_invitations",
              invitationCount: activeInvitations.length,
            },
          );
        }

        for (const invitation of expiredInvitations) {
          transaction.update(invitation.ref, {
            status: "expired",
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        transaction.update(companyRef, {
          status: "deleting",
          pendingInvitationCount: 0,
          deletionStartedAt: FieldValue.serverTimestamp(),
          deletionStartedByUid: uid,
          updatedAt: FieldValue.serverTimestamp(),
        });

        transaction.update(userRef, {
          accountDeletionStatus: "deleting",
          accountDeletionCompanyId: companyId,
          accountDeletionStartedAt:
            FieldValue.serverTimestamp(),
        });

        return {
          companyId,
          companyName: companySnapshot.get("name") ?? null,
        };
      },
    );

    if (deletionPlan.companyId !== null) {
      const invitationsSnapshot = await db
        .collection("companyInvitations")
        .where("companyId", "==", deletionPlan.companyId)
        .get();
      const invitationWriter = db.bulkWriter();

      for (const invitation of invitationsSnapshot.docs) {
        invitationWriter.delete(invitation.ref);
      }

      await invitationWriter.close();

      await db.recursiveDelete(
        db.collection("companies").doc(deletionPlan.companyId),
      );
    }

    const trialDevicesSnapshot = await db
      .collection("trial_devices")
      .where("uid", "==", uid)
      .get();
    const trialDeviceWriter = db.bulkWriter();

    for (const trialDevice of trialDevicesSnapshot.docs) {
      trialDeviceWriter.update(trialDevice.ref, {
        uid: null,
        mode: "deleted_account",
        accountDeletedAt: FieldValue.serverTimestamp(),
      });
    }

    await trialDeviceWriter.close();

    await db.recursiveDelete(userRef);
    await getAuth().deleteUser(uid);

    return {
      deleted: true,
      dissolvedCompany:
        deletionPlan.companyId !== null,
      companyId: deletionPlan.companyId,
      companyName: deletionPlan.companyName,
    };
  },
);
