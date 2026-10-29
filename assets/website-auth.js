import {startAdminIdleLogout} from "./admin-idle.js";
import {initializeApp, getApp, getApps} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {getAuth, connectAuthEmulator, setPersistence, browserLocalPersistence,
  browserSessionPersistence} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
const config = {
  apiKey: "AIzaSyC2zXg4w6aJf1ct-1Yj2kFwAPujQEbPA3E",
  authDomain: "twyt-80c82.firebaseapp.com", projectId: "twyt-80c82",
  storageBucket: "twyt-80c82.firebasestorage.app", messagingSenderId: "64966382407",
  appId: "1:64966382407:web:6739c6a7afa83eb7877262", measurementId: "G-0QQYN8BKQD",
};
export const app = getApps().length ? getApp() : initializeApp(config);
export const auth = getAuth(app);
if (["localhost", "127.0.0.1"].includes(location.hostname) && !auth.emulatorConfig) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", {disableWarnings: true});
}
auth.languageCode = document.documentElement.lang || "de";
// Persistence is changed only on an explicit sign-in, never on page navigation.
export async function choosePersistence(remember) {
  await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
}

// Admin inactivity timeout also applies across page changes and browser restarts.
startAdminIdleLogout(auth, app);
