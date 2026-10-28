import {DecodedIdToken, getAuth} from "firebase-admin/auth";
import {HttpsError} from "firebase-functions/https";
import {db} from "../firebase";

interface Caller {
  uid: string;
  token: DecodedIdToken;
}

/**
 * Reads the protected admin role and current MFA/session state.
 * @param {Caller | undefined} caller Verified callable authentication.
 * @return {Promise<object>} Minimal access state, never company data.
 */
export async function readAdminAccess(caller: Caller | undefined) {
  if (!caller) {
    throw new HttpsError("unauthenticated", "Bitte zuerst anmelden.");
  }
  const profile = await db.collection("users").doc(caller.uid).get();
  if (profile.get("systemAdmin") !== true) {
    return {isAdmin: false, emailVerified: false,
      totpEnrolled: false, mfaVerified: false};
  }
  const user = await getAuth().getUser(caller.uid);
  const validAfter = user.tokensValidAfterTime ?
    Math.floor(Date.parse(user.tokensValidAfterTime) / 1000) : 0;
  if (user.disabled || !Number.isFinite(validAfter) ||
      !Number.isFinite(caller.token.auth_time) ||
      caller.token.auth_time < validAfter) {
    throw new HttpsError("unauthenticated", "Bitte erneut anmelden.");
  }
  const factors = user.multiFactor?.enrolledFactors || [];
  const totp = factors.filter((factor) => factor.factorId === "totp");
  const firebase = caller.token.firebase;
  const mfaVerified = user.emailVerified &&
    caller.token.email_verified === true &&
    firebase.sign_in_provider !== "custom" &&
    firebase.sign_in_second_factor === "totp" &&
    totp.some((factor) => factor.uid === firebase.second_factor_identifier);
  return {isAdmin: true, emailVerified: user.emailVerified,
    totpEnrolled: totp.length > 0, mfaVerified};
}

/**
 * Enforces TOTP on every platform-admin operation, including old sessions.
 * @param {Caller | undefined} caller Verified callable authentication.
 * @return {Promise<void>} Resolves only for an MFA-authenticated admin.
 */
export async function requireAdminMfa(
  caller: Caller | undefined,
): Promise<void> {
  const access = await readAdminAccess(caller);
  if (!access.isAdmin) {
    throw new HttpsError("permission-denied", "Kein Administratorzugriff.");
  }
  if (!access.mfaVerified) {
    throw new HttpsError("permission-denied",
      "Bitte mit Google Authenticator anmelden.",
      {reason: "admin_mfa_required"});
  }
}
