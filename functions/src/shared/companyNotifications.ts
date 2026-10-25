import {FieldValue, Transaction} from "firebase-admin/firestore";
import {db} from "../firebase";

/**
 * Queues a deduplicated admin alert and an email for Firebase Trigger Email.
 * @param {Transaction} tx Transaction containing the related reads and writes.
 * @param {string} id Deduplicated notification identifier.
 * @param {string} companyId Validated company identifier.
 * @param {string} title Admin notification title.
 * @param {string} text Plain-text notification body.
 */
export function queueCompanyNotification(
  tx: Transaction,
  id: string,
  companyId: string,
  title: string,
  text: string,
): void {
  tx.set(db.collection("adminNotifications").doc(id), {
    companyId,
    title,
    text,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  tx.set(db.collection("mail").doc(id), {
    to: ["info@polymapp.ch"],
    message: {subject: `PolymApp: ${title}`, text},
    createdAt: FieldValue.serverTimestamp(),
  });
}
