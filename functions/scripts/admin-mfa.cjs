"use strict";
// Run only from a trusted Google Cloud Shell. Token arrives on stdin, not in files.
const fs = require("node:fs");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const PROJECT_ID = "twyt-80c82";
async function main() {
  const action = process.argv[2];
  const uid = process.argv[3];
  if (!["status", "enable", "reset"].includes(action)) {
    throw new Error("Use status, enable, or reset UID --confirm-reset.");
  }
  if (action === "reset" && (!uid || process.argv[4] !== "--confirm-reset")) {
    throw new Error("Reset requires the admin UID and --confirm-reset.");
  }
  const token = fs.readFileSync(0, "utf8").trim();
  if (!token) throw new Error("A Google Cloud access token is required on stdin.");
  initializeApp({projectId: PROJECT_ID, credential: {
    getAccessToken: async () => ({access_token: token, expires_in: 3600}),
  }});
  const auth = getAuth();
  if (action === "reset") {
    const url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
      "/databases/(default)/documents/users/" + encodeURIComponent(uid);
    const response = await fetch(url, {
      headers: {Authorization: "Bearer " + token},
    });
    if (!response.ok) throw new Error("Admin profile could not be verified.");
    const profile = await response.json();
    if (profile.fields?.systemAdmin?.booleanValue !== true) {
      throw new Error("This UID is not a PolymApp system administrator.");
    }
    await auth.updateUser(uid, {multiFactor: {enrolledFactors: null}});
    await auth.revokeRefreshTokens(uid);
    console.log("Admin factors reset and sessions revoked. Enrol again on the admin page.");
    return;
  }
  const manager = auth.projectConfigManager();
  const config = await manager.getProjectConfig();
  if (action === "status") {
    const totp = config.multiFactorConfig?.providerConfigs?.find(
      (provider) => provider.totpProviderConfig);
    console.log(JSON.stringify({project: PROJECT_ID,
      totpEnabled: totp?.state === "ENABLED",
      adjacentIntervals: totp?.totpProviderConfig?.adjacentIntervals ?? null}));
    return;
  }
  const current = config.multiFactorConfig || {};
  const providers = (current.providerConfigs || []).filter(
    (provider) => !provider.totpProviderConfig);
  providers.push({state: "ENABLED", totpProviderConfig: {adjacentIntervals: 1}});
  await manager.updateProjectConfig({multiFactorConfig: {
    ...current, state: "ENABLED", providerConfigs: providers,
  }});
  console.log("TOTP enabled for twyt-80c82. Other MFA providers preserved. No user enrolled.");
}
main().catch((error) => {
  // Do not dump objects that might contain a token or HTTP request headers.
  console.error("MFA setup failed:", error.code || "configuration-error");
  process.exitCode = 1;
});
