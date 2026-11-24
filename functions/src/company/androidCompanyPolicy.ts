import {Timestamp} from "firebase-admin/firestore";
import {getRemoteConfig} from "firebase-admin/remote-config";
import {HttpsError} from "firebase-functions/https";
import {warn} from "firebase-functions/logger";
import {db} from "../firebase";
import {hasCompanyAccess} from "../shared/companyAccess";

const KEY = "company_paywall_active";
const MINUTE = 60_000;
const ROLES = ["owner", "admin", "editor", "viewer"];
type Switch = {required: boolean | null; until: number};
let cached: Switch | undefined;
let reading: Promise<Switch> | undefined;

/**
 * Read the server template shared by the function instances' callers.
 * A fetch error must never turn a required subscription into a free pilot.
 * @return {Promise<Switch>} Switch value, or null on a temporary error.
 */
async function readSwitch(): Promise<Switch> {
  if (cached && Date.now() < cached.until) return cached;
  if (!reading) {
    reading = (async () => {
      try {
        const t = await getRemoteConfig().getServerTemplate({
          defaultConfig: {[KEY]: false},
        });
        const value = t.evaluate().getString(KEY).toLowerCase();
        if (value !== "true" && value !== "false") {
          throw new Error("Invalid boolean: " + KEY);
        }
        return {required: value === "true", until: Date.now() + MINUTE};
      } catch (error) {
        warn("Firmenabo-Schalter nicht verfügbar.", error);
        return {required: null, until: Date.now() + 15_000};
      }
    })().then((s) => {
      cached = s;
      return s;
    }).finally(() => {
      reading = undefined;
    });
  }
  return reading;
}

/**
 * Policy v2 for Android. Neither UID, role, price nor dates come from the app.
 * The expected company only binds a response to the current client session.
 * @param {string} uid Firebase Auth UID.
 * @param {unknown} expected Company ID the client is currently displaying.
 * @return {*} Session-bound decision with a short maximum lifetime.
 */
export async function androidCompanyPolicy(uid: string, expected: unknown) {
  if (typeof expected !== "string" || !/^[\w-]{1,128}$/.test(expected)) {
    throw new HttpsError("invalid-argument", "Invalid company context.");
  }
  const snapshot = await db.runTransaction(async (tx) => {
    const user = await tx.get(db.collection("users").doc(uid));
    if (!user.exists || user.get("companyId") !== expected) {
      throw new HttpsError("failed-precondition", "Company changed.");
    }
    const ref = db.collection("companies").doc(expected);
    const [company, member] = await Promise.all([
      tx.get(ref), tx.get(ref.collection("members").doc(uid)),
    ]);
    return {
      data: company.data(),
      member: member.get("status") === "active" &&
        ROLES.includes(member.get("role")),
    };
  });
  const data = snapshot.data;
  const reply = (decision: string, ttlMs: number) => ({
    policyVersion: 2, uid, companyId: expected, decision, ttlMs,
  });
  if (!snapshot.member || !data || data.status !== "active" ||
      data.billingStatus === "suspended") {
    return reply("unavailable_membership", 2 * MINUTE);
  }
  // Paid access is valid with either switch position. An open renewal does
  // not cancel the already paid term. End-of-term notices cap that term.
  const now = Date.now();
  if (data.accessMode === "paid" && hasCompanyAccess(data, now) &&
      data.billingValidUntil instanceof Timestamp) {
    const cancellation = data.subscriptionEndsAt;
    const end = Math.min(data.billingValidUntil.toMillis(),
      cancellation == null ? Infinity :
        cancellation instanceof Timestamp ? cancellation.toMillis() : 0);
    if (now <= end) return reply("paid", Math.min(2 * MINUTE, end - now + 1));
  }
  const flag = await readSwitch();
  if (flag.required === null) {
    throw new HttpsError("unavailable", "Company policy unavailable.");
  }
  return reply(flag.required ? "subscription_required" : "company_free",
    2 * MINUTE);
}
