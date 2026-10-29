import {onCall} from "firebase-functions/https";
import {
  readAdminAccess,
  requireAdminMfa,
} from "../shared/adminAccess";

export const getAdminAccess = onCall(async (request) => {
  return readAdminAccess(request.auth);
});

export const touchAdminSession = onCall(async (request) => {
  return requireAdminMfa(request.auth);
});
