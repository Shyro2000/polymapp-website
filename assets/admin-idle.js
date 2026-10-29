import {onIdTokenChanged, signOut} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {getFunctions, httpsCallable, connectFunctionsEmulator} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

const IDLE_MS = 30 * 60 * 1000;
const WRITE_MS = 5000;

// Shared by every page using website-auth.js. No password or token is stored.
export function startAdminIdleLogout(auth, app) {
  const functions = getFunctions(app, "europe-west1");
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  }
  const access = httpsCallable(functions, "getAdminAccess");
  const touch = httpsCallable(functions, "touchAdminSession");
  let epoch = 0;
  let session = null;
  let pending = false;
  let retryAt = 0;
  let loggingOut = false;

  function readLast(current) {
    try {
      const raw = localStorage.getItem(current.key);
      const stored = raw === null ? NaN : Number(raw);
      if (Number.isFinite(stored) && stored >= current.started) {
        current.last = Math.max(current.last, stored);
      }
      const shared = JSON.parse(localStorage.getItem(current.key + ":server"));
      if (shared && Number.isFinite(shared.deadline) &&
          shared.received > current.serverReceived) {
        current.serverDeadline = shared.deadline;
        current.serverReceived = shared.received;
        current.last = Math.max(current.last, shared.deadline - IDLE_MS);
      }
    } catch { /* Memory fallback if browser storage is unavailable. */ }
    return current.last;
  }

  function persist(current, force = false) {
    if (!force && Date.now() - current.written < WRITE_MS) return;
    try {
      localStorage.setItem(current.key, String(current.last));
      current.written = Date.now();
    } catch { /* A reload may then require an earlier sign-in. */ }
  }

  function expired(current) {
    const last = readLast(current);
    const now = Date.now();
    return now - last >= IDLE_MS || last > now + 60000 ||
      now >= current.serverDeadline;
  }

  function applyServer(current, data) {
    if (!Number.isFinite(data.idleExpiresAt) || !Number.isFinite(data.serverTime)) {
      void logout();
      return false;
    }
    // Use the server's remaining time, so a wrong device clock cannot add time.
    current.serverDeadline = Date.now() + data.idleExpiresAt - data.serverTime;
    current.serverReceived = Date.now();
    try {
      localStorage.setItem(current.key + ":server", JSON.stringify({
        deadline: current.serverDeadline, received: current.serverReceived,
      }));
    } catch { /* The server remains authoritative without browser storage. */ }
    return true;
  }

  async function heartbeat() {
    const current = session;
    if (!current || !current.dirty || current.touching ||
        Date.now() - current.touched < 60000 || !check()) return;
    current.touching = true;
    current.dirty = false;
    current.touched = Date.now();
    try {
      const result = await touch();
      if (session !== current) return;
      applyServer(current, result.data);
    } catch (error) {
      if (session !== current) return;
      if (error.code === "functions/unauthenticated" ||
          error.code === "functions/permission-denied") await logout();
      else current.dirty = true;
    } finally {
      current.touching = false;
    }
  }

  async function logout() {
    if (loggingOut) return;
    loggingOut = true;
    try {
      await signOut(auth);
      // Clear admin data even on pages whose UI lacks an auth observer.
      location.reload();
    } catch {
      // Retry on the next check, without extending the expired session.
    } finally {
      loggingOut = false;
    }
  }

  async function identify(user, version) {
    if (pending || !user) return;
    pending = true;
    try {
      const token = await user.getIdTokenResult();
      if (version !== epoch || auth.currentUser?.uid !== user.uid) return;
      const started = Number(token.claims.auth_time) * 1000;
      const key = `polymapp.adminIdle.v1:${user.uid}:${started}`;
      if (session && session.key !== key) session = null;
      const result = await access();
      if (version !== epoch || auth.currentUser?.uid !== user.uid) return;
      retryAt = Infinity;
      if (result.data.isAdmin !== true) {
        session = null;
        return;
      }
      // Enrollment is allowed before the first MFA-authenticated session.
      if (result.data.mfaVerified !== true) {
        session = null;
        return;
      }
      if (!Number.isFinite(started) || started <= 0) {
        await logout();
        return;
      }
      if (session?.key !== key) {
        session = {key, uid: user.uid, started, last: started, written: 0,
          serverReceived: 0, serverDeadline: Infinity,
          touched: 0, dirty: false, touching: false};
      }
      if (!applyServer(session, result.data)) return;
      if (expired(session)) await logout();
      else persist(session, true);
    } catch (error) {
      if (version !== epoch || auth.currentUser?.uid !== user.uid) return;
      retryAt = Date.now() + 15000;
      if (error.code === "functions/unauthenticated") await logout();
    } finally {
      pending = false;
    }
  }

  onIdTokenChanged(auth, (user) => {
    const version = ++epoch;
    retryAt = 0;
    if (!user || session?.uid !== user.uid) session = null;
    // If another request is pending, the interval retries the newest user.
    void identify(user, version);
  });

  function check() {
    if (session && expired(session)) {
      void logout();
      return false;
    }
    return true;
  }

  function activity(event) {
    if (!event.isTrusted || document.visibilityState !== "visible") return;
    // An interaction after sleep must not revive an expired session.
    if (!check() || !session || loggingOut) return;
    session.last = Date.now();
    persist(session);
    session.dirty = true;
    void heartbeat();
  }

  for (const name of ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"]) {
    document.addEventListener(name, activity, {passive: true, capture: true});
  }
  window.addEventListener("storage", () => check());
  window.addEventListener("focus", () => check());
  window.addEventListener("pageshow", () => check());
  document.addEventListener("visibilitychange", () => check());
  window.addEventListener("pagehide", () => {
    if (session && check()) persist(session, true);
  });
  window.setInterval(() => {
    if (check()) void heartbeat();
    if (auth.currentUser && !pending && Date.now() >= retryAt) {
      void identify(auth.currentUser, epoch);
    }
  }, 5000);
}
