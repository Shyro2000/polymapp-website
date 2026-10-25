import {auth, choosePersistence} from "./website-auth.js";
import {onAuthStateChanged, signInWithEmailAndPassword, signOut} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
const lang = ["de", "en", "fr"].includes(document.documentElement.lang) ? document.documentElement.lang : "de";
const words = {
  de: {account:"Mein Account", login:"Anmelden", neutral:"Account", loading:"Anmeldung wird geprüft …", email:"E-Mail", password:"Passwort", remember:"Angemeldet bleiben", company:"Firmenverwaltung", logout:"Abmelden", create:"Konto erstellen / Passwort vergessen", error:"Anmeldung fehlgeschlagen. Bitte E-Mail und Passwort prüfen.", offline:"Keine Verbindung. Bitte erneut versuchen.", signed:"Angemeldet als"},
  en: {account:"My account", login:"Sign in", neutral:"Account", loading:"Checking sign-in …", email:"Email", password:"Password", remember:"Stay signed in", company:"Company management", logout:"Sign out", create:"Create account / Forgot password", error:"Sign-in failed. Please check your email and password.", offline:"No connection. Please try again.", signed:"Signed in as"},
  fr: {account:"Mon compte", login:"Connexion", neutral:"Compte", loading:"Vérification de la connexion …", email:"E-mail", password:"Mot de passe", remember:"Rester connecté", company:"Gestion d’entreprise", logout:"Déconnexion", create:"Créer un compte / Mot de passe oublié", error:"Connexion impossible. Vérifiez l’e-mail et le mot de passe.", offline:"Aucune connexion. Veuillez réessayer.", signed:"Connecté en tant que"},
}[lang];
const suffix = lang === "de" ? "" : "-" + lang;
const header = document.querySelector("header");
if (header) {
  const menu = document.createElement("details");
  menu.className = "account-menu";
  menu.innerHTML = `<summary aria-label="${words.account}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/></svg><span data-label>${words.neutral}</span></summary><div class="account-menu-panel"><p data-loading role="status">${words.loading}</p><div data-user hidden><p>${words.signed}<br><strong data-email></strong></p><a href="accountverwaltung${suffix}.html">${words.account}</a><a href="firmenverwaltung${suffix}.html">${words.company}</a><button type="button" data-logout>${words.logout}</button></div><form data-login hidden><label for="menu-email">${words.email}</label><input id="menu-email" type="email" autocomplete="email" required><label for="menu-password">${words.password}</label><input id="menu-password" type="password" autocomplete="current-password" required><label class="remember-label"><input type="checkbox" data-remember checked>${words.remember}</label><button type="submit">${words.login}</button><a href="accountverwaltung${suffix}.html">${words.create}</a></form><p class="account-menu-error" data-error role="alert" hidden></p></div>`;
  header.append(menu);
  const get = (selector) => menu.querySelector(selector);
  const form = get("[data-login]");
  const error = get("[data-error]");
  onAuthStateChanged(auth, (user) => {
    get("[data-loading]").hidden = true;
    get("[data-label]").textContent = user ? words.account : words.login;
    menu.querySelector("summary").setAttribute("aria-label", user ? words.account : words.login);
    get("[data-user]").hidden = !user;
    form.hidden = !!user;
    get("[data-email]").textContent = user?.email || "";
    if (user) { form.reset(); error.hidden = true; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true; error.hidden = true;
    try {
      await choosePersistence(get("[data-remember]").checked);
      await signInWithEmailAndPassword(auth, get("#menu-email").value.trim(), get("#menu-password").value);
      form.reset(); menu.open = false;
    } catch (failure) {
      error.textContent = failure.code === "auth/network-request-failed" ? words.offline : words.error;
      error.hidden = false;
    } finally { submit.disabled = false; }
  });
  get("[data-logout]").addEventListener("click", async () => {
    try { await signOut(auth); menu.open = false; }
    catch { error.textContent = words.offline; error.hidden = false; }
  });
  document.addEventListener("click", (event) => { if (!menu.contains(event.target)) menu.open = false; });
  menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); } });
}
