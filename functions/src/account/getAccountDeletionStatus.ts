import {Timestamp} from "firebase-admin/firestore";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";

export const getAccountDeletionStatus = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Du musst angemeldet sein.",
      );
    }

    const uid = request.auth.uid;
    const userRef = db.collection("users").doc(uid);
    const userSnapshot = await userRef.get();

    if (!userSnapshot.exists) {
      throw new HttpsError(
        "not-found",
        "Das Benutzerprofil wurde nicht gefunden.",
      );
    }

    const companyId = userSnapshot.get("companyId");

    if (
      companyId === undefined ||
      companyId === null
    ) {
      return {
        canDeleteAccount: true,
        membership: "none",
        role: null,
        companyId: null,
        companyName: null,
        activeMemberCount: 0,
        otherActiveMemberCount: 0,
        activePendingInvitationCount: 0,
        expiredPendingInvitationCount: 0,
        willDissolveCompany: false,
        requiredAction: "none",
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

    const companySnapshot = await companyRef.get();
    const memberSnapshot = await memberRef.get();

    if (!companySnapshot.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Die zugeordnete Firma wurde nicht gefunden.",
      );
    }

    if (!memberSnapshot.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Die Firmenmitgliedschaft wurde nicht gefunden.",
      );
    }

    const companyStatus = companySnapshot.get("status");

    if (companyStatus !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "Die Firma kann momentan nicht bearbeitet werden.",
      );
    }

    if (memberSnapshot.get("status") !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "Die Firmenmitgliedschaft ist nicht aktiv.",
      );
    }

    const role = memberSnapshot.get("role");

    if (
      role !== "owner" &&
      role !== "admin" &&
      role !== "editor" &&
      role !== "viewer"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Die Firmenrolle ist ungültig.",
      );
    }

    if (role !== "owner") {
      return {
        canDeleteAccount: false,
        membership: "member",
        role,
        companyId,
        companyName: companySnapshot.get("name") ?? null,
        activeMemberCount:
          companySnapshot.get("activeMemberCount") ?? null,
        otherActiveMemberCount: null,
        activePendingInvitationCount: null,
        expiredPendingInvitationCount: null,
        willDissolveCompany: false,
        requiredAction: "leave_company",
      };
    }

    const membersQuery = companyRef
      .collection("members")
      .where("status", "==", "active");
    const pendingInvitationsQuery = db
      .collection("companyInvitations")
      .where("companyId", "==", companyId)
      .where("status", "==", "pending");

    const membersSnapshot = await membersQuery.get();
    const pendingInvitationsSnapshot =
      await pendingInvitationsQuery.get();

    const otherActiveMemberCount =
      membersSnapshot.docs.filter(
        (document) => document.id !== uid,
      ).length;
    const nowMilliseconds = Timestamp.now().toMillis();
    let activePendingInvitationCount = 0;
    let expiredPendingInvitationCount = 0;

    for (const invitation of pendingInvitationsSnapshot.docs) {
      const expiresAt = invitation.get("expiresAt");

      if (
        expiresAt instanceof Timestamp &&
        expiresAt.toMillis() > nowMilliseconds
      ) {
        activePendingInvitationCount += 1;
      } else {
        expiredPendingInvitationCount += 1;
      }
    }

    const hasOtherMembers = otherActiveMemberCount > 0;
    const hasActiveInvitations =
      activePendingInvitationCount > 0;
    const canDeleteAccount =
      !hasOtherMembers && !hasActiveInvitations;

    let requiredAction = "none";

    if (hasOtherMembers && hasActiveInvitations) {
      requiredAction =
        "remove_members_and_withdraw_invitations";
    } else if (hasOtherMembers) {
      requiredAction =
        "transfer_ownership_or_remove_members";
    } else if (hasActiveInvitations) {
      requiredAction = "withdraw_invitations";
    }

    return {
      canDeleteAccount,
      membership: "owner",
      role,
      companyId,
      companyName: companySnapshot.get("name") ?? null,
      activeMemberCount: membersSnapshot.size,
      otherActiveMemberCount,
      activePendingInvitationCount,
      expiredPendingInvitationCount,
      willDissolveCompany: canDeleteAccount,
      requiredAction,
    };
  },
);
