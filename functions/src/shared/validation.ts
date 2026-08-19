export const DEFAULT_SEAT_LIMIT = 10;
export const INVITATION_VALIDITY_MS = 72 * 60 * 60 * 1000;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const INVITATION_ID_PATTERN = /^[a-f0-9]{64}$/;

export type InvitationRole = "admin" | "editor" | "viewer";

/**
 * Normalisiert eine E-Mail-Adresse für Vergleiche.
 *
 * @param {string} value Die ursprüngliche E-Mail-Adresse.
 * @return {string} Die normalisierte E-Mail-Adresse.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Prüft, ob ein Wert eine erlaubte Einladungsrolle ist.
 *
 * @param {*} value Der zu prüfende Wert.
 * @return {boolean} True, wenn die Rolle erlaubt ist.
 */
export function isInvitationRole(
  value: unknown,
): value is InvitationRole {
  return (
    value === "admin" ||
    value === "editor" ||
    value === "viewer"
  );
}
