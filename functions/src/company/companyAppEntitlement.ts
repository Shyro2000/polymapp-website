import {Timestamp} from "firebase-admin/firestore";
import {getRemoteConfig} from "firebase-admin/remote-config";
import {warn} from "firebase-functions/logger";
import {HttpsError, onCall} from "firebase-functions/https";
import {db} from "../firebase";
import {hasCompanyAccess} from "../shared/companyAccess";

const FLAG = "company_subscription_unlocks_all_features";
const FLAG_TTL_MS = 60_000;
const RETRY_MS = 15_000;
const ROLES = ["owner", "admin", "editor", "viewer"];
interface SwitchState {
  enabled: boolean;
  expiresMs: number;
}
let cached: SwitchState | undefined;
let inFlight: Promise<SwitchState> | undefined;

/**
 * Loads the SERVER template. An unavailable template never grants access.
 * @return {Promise<SwitchState>} Switch and its in-process cache deadline.
 */
async function loadSwitch(): Promise<SwitchState> {
  try {
    const template = await getRemoteConfig().getServerTemplate({
      defaultConfig: {[FLAG]: false},
    });
    return {
      enabled: template.evaluate().getBoolean(FLAG),
      expiresMs: Date.now() + FLAG_TTL_MS,
    };
  } catch (error) {
    warn("Remote Config: Firmenfreischaltung inaktiv.", error);
    return {enabled: false, expiresMs: Date.now() + RETRY_MS};
  }
}

/**
 * Coalesces concurrent flag reads; membership is never cached here.
 * @return {Promise<SwitchState>} Current flag with a bounded lifetime.
 */
async function readSwitch(): Promise<SwitchState> {
  if (cached && cached.expiresMs > Date.now()) return cached;
  if (!inFlight) {
    inFlight = loadSwitch().then((state) => {
      cached = state;
      return state;
    }).finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

/** Additive app benefit only. Never sets a personal subscription or role. */
export const getCompanyAppEntitlement = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Bitte anmelden.");
  }
  const uid = request.auth.uid;
  const flag = await readSwitch();
  const denied = {
    grantsAllFeatures: false, validUntilMs: null, recheckAtMs: flag.expiresMs,
  };
  if (!flag.enabled) return denied;
  return db.runTransaction(async (tx) => {
    const profile = await tx.get(db.collection("users").doc(uid));
    const id = profile.get("companyId");
    if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) return denied;
    const ref = db.collection("companies").doc(id);
    const [company, member] = await Promise.all([
      tx.get(ref), tx.get(ref.collection("members").doc(uid)),
    ]);
    const data = company.data();
    const now = Date.now();
    if (
      !data || member.get("status") !== "active" ||
      !ROLES.includes(member.get("role")) || data.accessMode !== "paid" ||
      !hasCompanyAccess(data, now) ||
      !(data.billingValidUntil instanceof Timestamp)
    ) {
      return denied;
    }
    let end = data.billingValidUntil.toMillis();
    if (data.subscriptionEndsAt != null) {
      if (!(data.subscriptionEndsAt instanceof Timestamp)) return denied;
      end = Math.min(end, data.subscriptionEndsAt.toMillis());
    }
    if (now > end) return denied;
    if (now >= flag.expiresMs) return {...denied, recheckAtMs: now + 1000};
    return {
      grantsAllFeatures: true,
      validUntilMs: end,
      recheckAtMs: Math.min(end + 1, flag.expiresMs),
    };
  });
});
