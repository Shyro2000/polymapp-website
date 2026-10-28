"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "../src");
function harness() {
  const state = {role: true, reads: [], user: {emailVerified: true,
    tokensValidAfterTime: new Date(0).toISOString(), disabled: false,
    multiFactor: {enrolledFactors: [{factorId: "totp", uid: "factor-1"}]}}};
  const db = {collection(name) {
    state.reads.push(name);
    if (name !== "users") throw Error("Business data accessed too early: " + name);
    return {doc: () => ({get: async () => ({exists: true,
      get: (key) => key === "systemAdmin" && state.role})})};
  }};
  const cache = new Map();
  class HttpsError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details; }
  }
  function load(file) {
    file = path.resolve(file);
    if (file === path.join(root, "firebase.ts")) return {db};
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"),
      {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
    vm.runInNewContext(code, {exports, Buffer, Date, console, require(name) {
      if (name === "firebase-admin/auth") return {getAuth: () => ({getUser: async () => state.user})};
      if (name === "firebase-functions/https") return {HttpsError,
        onCall: (...args) => args.at(-1)};
      if (name.startsWith(".")) return load(path.resolve(path.dirname(file), name + ".ts"));
      return require(name);
    }}, {filename: file});
    return exports;
  }
  const caller = {uid: "admin", token: {auth_time: 2000, email_verified: true,
    firebase: {sign_in_provider: "password", sign_in_second_factor: "totp",
      second_factor_identifier: "factor-1"}}};
  return {state, load, caller, guard: load(path.join(root, "shared/adminAccess.ts"))};
}

test("only a current system admin with the enrolled TOTP sign-in can pass", async () => {
  const h = harness(); await h.guard.requireAdminMfa(h.caller);
  assert.equal((await h.guard.readAdminAccess(h.caller)).mfaVerified, true);
});
for (const [name, change] of [
  ["regular user/company admin", (h) => { h.state.role = false; }],
  ["password-only sign-in", (h) => { delete h.caller.token.firebase.sign_in_second_factor; }],
  ["SMS second factor", (h) => { h.caller.token.firebase.sign_in_second_factor = "phone"; }],
  ["wrong/removed factor", (h) => { h.caller.token.firebase.second_factor_identifier = "old"; }],
  ["factor no longer enrolled", (h) => { h.state.user.multiFactor.enrolledFactors = []; }],
  ["unverified account", (h) => { h.state.user.emailVerified = false; }],
  ["unverified token", (h) => { h.caller.token.email_verified = false; }],
  ["disabled account", (h) => { h.state.user.disabled = true; }],
  ["revoked login", (h) => { h.state.user.tokensValidAfterTime = new Date(3000000).toISOString(); }],
  ["custom token", (h) => { h.caller.token.firebase.sign_in_provider = "custom"; }],
]) test("rejects " + name, async () => {
  const h = harness(); change(h); await assert.rejects(() => h.guard.requireAdminMfa(h.caller));
});
test("unauthenticated caller rejected", async () => {
  const h = harness(); await assert.rejects(() => h.guard.requireAdminMfa(undefined));
});
test("bootstrap returns minimal state; normal users receive no admin access", async () => {
  const h = harness(); const endpoint = h.load(path.join(root, "admin/adminSecurity.ts")).getAdminAccess;
  delete h.caller.token.firebase.sign_in_second_factor;
  const access = await endpoint({auth: h.caller});
  assert.equal(access.isAdmin, true); assert.equal(access.mfaVerified, false);
  assert.deepEqual(Object.keys(access).sort(), ["emailVerified", "isAdmin", "mfaVerified", "totpEnrolled"].sort());
  h.state.role = false; assert.equal((await endpoint({auth: h.caller})).isAdmin, false);
});
const adminOperations = {
  "admin/getAdminCompanies.ts": ["getAdminCompanies"],
  "admin/adminBilling.ts": ["createCompanyInvoice", "markCompanyInvoicePaid", "cancelCompanyInvoice", "updateAdminBillingSettings", "getCompanyInvoicePdf"],
  "admin/companyProgram.ts": ["markCompanyNotificationRead", "migrateCompanySubscriptions", "updateCompanyProgram"],
};
for (const [file, names] of Object.entries(adminOperations)) for (const name of names) {
  test(name + " blocks missing MFA before reading any business data", async () => {
    const h = harness(); delete h.caller.token.firebase.sign_in_second_factor;
    const endpoint = h.load(path.join(root, file))[name];
    await assert.rejects(() => endpoint({auth: h.caller, data: {}}),
      (error) => error.details?.reason === "admin_mfa_required");
    assert(h.state.reads.every((collection) => collection === "users"));
  });
}
