import {onCall} from "firebase-functions/https";
import {readAdminAccess} from "../shared/adminAccess";

// This bootstrap endpoint exposes no business data or authenticator secret.
export const getAdminAccess = onCall(async (request) => {
  return readAdminAccess(request.auth);
});
