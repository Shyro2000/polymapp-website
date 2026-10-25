import {Timestamp} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/https";

/**
 * Returns whether the server has explicitly granted company feature access.
 * @param {*} company Company document or its stored fields.
 * @param {*} nowMs Current server time in milliseconds.
 * @return {*} Calculated result or verified server context.
 */
export function hasCompanyAccess(
  company: Record<string, unknown>,
  nowMs = Date.now(),
): boolean {
  if (company.status !== "active" || company.billingStatus === "suspended") {
    return false;
  }
  if (company.accessMode === "pilot") {
    return (
      !(company.pilotValidUntil instanceof Timestamp) ||
      company.pilotValidUntil.toMillis() >= nowMs
    );
  }
  return (
    company.accessMode === "paid" &&
    company.billingValidFrom instanceof Timestamp &&
    company.billingValidUntil instanceof Timestamp &&
    company.billingValidFrom.toMillis() <= nowMs &&
    company.billingValidUntil.toMillis() >= nowMs
  );
}

/**
 * Enforces the same licence policy used by the Firestore rules.
 * @param {*} company Company document or its stored fields.
 */
export function requireCompanyAccess(company: Record<string, unknown>): void {
  if (!hasCompanyAccess(company)) {
    throw new HttpsError(
      "failed-precondition",
      "Die Firmenfunktionen sind derzeit nicht freigeschaltet.",
      {reason: "company_access_inactive"},
    );
  }
}
