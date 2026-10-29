import {DecodedIdToken, getAuth} from "firebase-admin/auth";
import {HttpsError} from "firebase-functions/https";
import {db} from "../firebase";
import {createHash} from "node:crypto";

const ADMIN_IDLE_MS = 30 * 60 * 1000;

interface Caller {
  uid: string;
  token: DecodedIdToken;
}

/**
 * Checks an MFA session against a server-owned activity record.
 * @param {Caller} caller Verified Firebase identity.
 * @param {boolean} activity Whether this request records admin activity.
 * @return {Promise<number>} Server expiry time in milliseconds.
 */
async function checkSession(caller: Caller, activity: boolean) {
  const started = caller.token.auth_time * 1000;
  const key = createHash("sha256").update(JSON.stringify([
    caller.uid, started, caller.token.firebase.second_factor_identifier,
  ])).digest("hex");
  const ref = db.collection("_adminSessions").doc(key);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const now = Date.now();
    const previous = snap.exists ? snap.get("lastActivityAt") : started;
    if (!Number.isFinite(previous) || previous < started ||
        previous > now + 60000 || now - previous >= ADMIN_IDLE_MS) {
      throw new HttpsError("unauthenticated",
        "Admin-Sitzung abgelaufen. Bitte erneut anmelden.",
        {reason: "admin_session_expired"});
    }
    const last = activity ? Math.max(previous, now) : previous;
    if (!snap.exists || last !== previous) {
      transaction.set(ref, {uid: caller.uid, authTime: started,
        lastActivityAt: last});
    }
    return last + ADMIN_IDLE_MS;
  });
}

/**
 * Reads the protected admin role and current MFA/session state.
 * @param {Caller | undefined} caller Verified callable authentication.
 * @param {boolean} activity Record activity only after verified MFA.
 * @return {Promise<object>} Minimal access state, never company data.
 */
export async function readAdminAccess(
  caller: Caller | undefined, activity = false,
) {
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
  const idleExpiresAt = mfaVerified ?
    await checkSession(caller, activity) : null;
  return {isAdmin: true, emailVerified: user.emailVerified,
    totpEnrolled: totp.length > 0, mfaVerified,
    idleExpiresAt, serverTime: Date.now()};
}

/**
 * Enforces TOTP on every platform-admin operation, including old sessions.
 * @param {Caller | undefined} caller Verified callable authentication.
 * @return {Promise<object>} Access state for a current MFA admin session.
 */
export async function requireAdminMfa(
  caller: Caller | undefined,
) {
  const access = await readAdminAccess(caller, true);
  if (!access.isAdmin) {
    throw new HttpsError("permission-denied", "Kein Administratorzugriff.");
  }
  if (!access.mfaVerified) {
    throw new HttpsError("permission-denied",
      "Bitte mit Google Authenticator anmelden.",
      {reason: "admin_mfa_required"});
  }
  return access;
}
