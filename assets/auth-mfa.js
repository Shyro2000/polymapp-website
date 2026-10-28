import {app, auth} from "./website-auth.js";
import {
  signInWithEmailAndPassword, reauthenticateWithCredential, EmailAuthProvider,
  getMultiFactorResolver, TotpMultiFactorGenerator, multiFactor, signOut,
  sendEmailVerification,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFunctions, connectFunctionsEmulator, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import qrcode from "./vendor/qrcode.mjs";

const lang = ["de", "en", "fr"].includes(document.documentElement.lang)
  ? document.documentElement.lang : "de";
const t = {
  de: {title: "Google Authenticator", intro: "Gib den sechsstelligen Code aus deiner Authenticator-App ein.", code: "Bestätigungscode", confirm: "Bestätigen", cancel: "Abbrechen", invalid: "Der Code ist ungültig oder abgelaufen. Bitte erneut versuchen.", expired: "Die Anmeldung ist abgelaufen. Bitte erneut mit E-Mail und Passwort anmelden.", cancelled: "Bestätigung abgebrochen.", unsupported: "Für dieses Konto ist kein unterstützter Authenticator hinterlegt.", password: "Passwort erneut bestätigen", passwordLabel: "Dein aktuelles Passwort", passwordError: "Passwort konnte nicht bestätigt werden. Bitte erneut versuchen.", factor: "Authenticator auswählen", close: "Schliessen"},
  en: {title: "Google Authenticator", intro: "Enter the six-digit code from your authenticator app.", code: "Verification code", confirm: "Confirm", cancel: "Cancel", invalid: "The code is invalid or expired. Please try again.", expired: "Your sign-in has expired. Please sign in again with your email and password.", cancelled: "Verification cancelled.", unsupported: "No supported authenticator is registered for this account.", password: "Confirm your password again", passwordLabel: "Your current password", passwordError: "Your password could not be verified. Please try again.", factor: "Select authenticator", close: "Close"},
  fr: {title: "Google Authenticator", intro: "Saisissez le code à six chiffres de votre application d’authentification.", code: "Code de vérification", confirm: "Confirmer", cancel: "Annuler", invalid: "Le code est incorrect ou expiré. Réessayez.", expired: "La connexion a expiré. Reconnectez-vous avec votre e-mail et votre mot de passe.", cancelled: "Vérification annulée.", unsupported: "Aucune application d’authentification compatible n’est enregistrée pour ce compte.", password: "Confirmez à nouveau votre mot de passe", passwordLabel: "Votre mot de passe actuel", passwordError: "Le mot de passe n’a pas pu être vérifié. Réessayez.", factor: "Choisir un authentificateur", close: "Fermer"},
}[lang];

const functions = getFunctions(app, "europe-west1");
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}
const accessCall = httpsCallable(functions, "getAdminAccess");
export async function getAdminAccess() {
  return (await accessCall()).data;
}

let activeDialog = null;

// The verifier and all TOTP secrets remain in memory, never localStorage/logs.
function modal({title, intro, type = "text", label = t.code, setup,
  verify, failure = t.invalid}) {
  if (activeDialog) {
    return Promise.reject(Object.assign(new Error(t.cancelled),
      {code: "auth/mfa-cancelled"}));
  }
  return new Promise((resolve, reject) => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "auth-mfa-dialog";
    dialog.setAttribute("aria-labelledby", "auth-mfa-title");
    dialog.innerHTML = `<form><h2 id="auth-mfa-title"></h2><p data-intro></p><div data-setup></div><label for="auth-mfa-input"></label><input id="auth-mfa-input" required><p data-error role="alert" hidden></p><div class="auth-mfa-actions"><button type="submit"></button><button type="button" data-cancel></button></div></form>`;
    dialog.querySelector("h2").textContent = title;
    dialog.querySelector("[data-intro]").textContent = intro;
    dialog.querySelector("label").textContent = label;
    const input = dialog.querySelector("input");
    input.type = type;
    input.autocomplete = type === "password" ? "current-password" : "one-time-code";
    if (type !== "password") {
      input.inputMode = "numeric";
      input.pattern = "[0-9]{6}";
      input.maxLength = 6;
    }
    const submit = dialog.querySelector("button[type=submit]");
    const cancel = dialog.querySelector("[data-cancel]");
    const error = dialog.querySelector("[data-error]");
    submit.textContent = t.confirm;
    cancel.textContent = t.cancel;
    let busy = false;
    let finished = false;
    let dispose = null;
    function finish(ok, value) {
      if (finished) return;
      finished = true;
      input.value = "";
      dialog.querySelector("[data-setup]").replaceChildren();
      dialog.close();
      dialog.remove();
      activeDialog = null;
      dispose?.();
      if (previousFocus?.isConnected) previousFocus.focus();
      if (ok) resolve(value);
      else reject(value);
    }
    function abort() {
      if (!busy) finish(false, Object.assign(new Error(t.cancelled),
        {code: "auth/mfa-cancelled"}));
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault(); abort();
    });
    cancel.addEventListener("click", abort);
    dialog.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !input.reportValidity()) return;
      busy = true; submit.disabled = true; cancel.disabled = true;
      error.hidden = true;
      try {
        const value = await verify(input.value, dialog);
        finish(true, value);
      } catch (cause) {
        if (["auth/multi-factor-session-expired", "auth/invalid-multi-factor-session",
          "auth/session-expired", "auth/user-token-expired"].includes(cause.code)) {
          finish(false, Object.assign(new Error(t.expired), {code: cause.code}));
        } else {
          error.textContent = cause.code === "auth/mfa-cancelled"
            ? t.cancelled : failure;
          error.hidden = false;
          input.value = ""; input.focus();
        }
      } finally {
        busy = false; submit.disabled = false; cancel.disabled = false;
      }
    });
    try {
      if (setup) dispose = setup(dialog.querySelector("[data-setup]"));
      document.body.append(dialog); activeDialog = dialog;
      dialog.showModal(); input.focus();
    } catch (cause) {
      dialog.remove(); activeDialog = null; dispose?.(); reject(cause);
    }
  });
}

async function completeSecondFactor(error) {
  const resolver = getMultiFactorResolver(auth, error);
  const factors = resolver.hints.filter((factor) =>
    factor.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  if (!factors.length) throw new Error(t.unsupported);
  let selected = factors[0].uid;
  return modal({title: t.title, intro: t.intro,
    setup: (container) => {
      if (factors.length < 2) return;
      const label = document.createElement("label");
      label.textContent = t.factor;
      const select = document.createElement("select");
      select.setAttribute("aria-label", t.factor);
      for (const [index, factor] of factors.entries()) {
        const option = document.createElement("option");
        option.value = factor.uid;
        option.textContent = factor.displayName || `Authenticator ${index + 1}`;
        select.append(option);
      }
      select.addEventListener("change", () => { selected = select.value; });
      container.append(label, select);
    },
    verify: (code) => resolver.resolveSignIn(
      TotpMultiFactorGenerator.assertionForSignIn(selected, code))});
}

export async function signInWithMfa(email, password) {
  try {
    return await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    if (error.code !== "auth/multi-factor-auth-required") throw error;
    return completeSecondFactor(error);
  }
}

export async function reauthenticateWithMfa(user, credential) {
  try {
    return await reauthenticateWithCredential(user, credential);
  } catch (error) {
    if (error.code !== "auth/multi-factor-auth-required") throw error;
    return completeSecondFactor(error);
  }
}

async function confirmPassword(user) {
  // Password dialog must close before a second-factor dialog is opened.
  const password = await modal({title: t.password, intro: user.email || "",
    type: "password", label: t.passwordLabel, failure: t.passwordError,
    verify: async (value) => value});
  await reauthenticateWithMfa(user,
    EmailAuthProvider.credential(user.email, password));
  if (auth.currentUser?.uid !== user.uid) throw new Error(t.expired);
}

async function enrollAuthenticator(user) {
  await confirmPassword(user);
  const access = await getAdminAccess();
  if (!access.isAdmin || !access.emailVerified || access.totpEnrolled) {
    throw new Error("Einrichtung nicht verfügbar. Bitte Seite neu laden.");
  }
  let secret = await TotpMultiFactorGenerator.generateSecret(
    await multiFactor(user).getSession());
  try {
    await modal({title: "Google Authenticator einrichten",
      intro: "Scanne den QR-Code in Google Authenticator und bestätige den angezeigten Code. Bewahre den Einrichtungsschlüssel sicher ausserhalb dieser Website auf.",
      setup: (container) => {
        const qr = qrcode(0, "M");
        qr.addData(secret.generateQrCodeUrl(user.email, "PolymApp"));
        qr.make();
        const image = document.createElement("div");
        image.className = "auth-mfa-qr";
        image.innerHTML = qr.createSvgTag({scalable: true, margin: 4});
        image.setAttribute("role", "img");
        image.setAttribute("aria-label", "QR-Code für Google Authenticator");
        const hint = document.createElement("p");
        hint.textContent = "Alternativ manuell eingeben (zeitbasierter Schlüssel):";
        const key = document.createElement("code");
        key.className = "auth-mfa-key";
        key.textContent = secret.secretKey;
        container.append(image, hint, key);
      },
      verify: async (code) => {
        if (auth.currentUser?.uid !== user.uid) throw new Error(t.expired);
        await multiFactor(user).enroll(
          TotpMultiFactorGenerator.assertionForEnrollment(secret, code),
          "Google Authenticator");
      }});
  } finally {
    secret = null;
  }
  // An enrollment alone is not an MFA sign-in. Require a fresh full sign-in.
  await signOut(auth);
  window.alert("Google Authenticator ist eingerichtet. Bitte melde dich erneut mit Passwort und Authenticator-Code an.");
}

export function renderAdminMfaSetup(panel, access) {
  panel.replaceChildren();
  if (access.isAdmin !== true) {
    panel.textContent = "Kein Administratorzugriff.";
    return;
  }
  const title = document.createElement("h2");
  const text = document.createElement("p");
  const button = document.createElement("button");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  button.type = "button";
  if (!access.emailVerified) {
    title.textContent = "E-Mail-Adresse bestätigen";
    text.textContent = "Für Google Authenticator muss deine E-Mail-Adresse bestätigt sein. Öffne die Bestätigungsmail und lade diese Seite anschliessend neu.";
    button.textContent = "Bestätigungsmail senden";
  } else if (!access.totpEnrolled) {
    title.textContent = "Adminzugang absichern";
    text.textContent = "Richte Google Authenticator ein, um die Administration zu öffnen. Halte dein Smartphone bereit.";
    button.textContent = "Google Authenticator einrichten";
  } else {
    title.textContent = "Authenticator-Bestätigung erforderlich";
    text.textContent = "Bestätige Passwort und Authenticator-Code für diese Anmeldung.";
    button.textContent = "Adminzugang bestätigen";
  }
  button.addEventListener("click", async () => {
    button.disabled = true; error.textContent = "";
    const user = auth.currentUser;
    if (!user) { location.reload(); return; }
    try {
      if (!access.emailVerified) {
        await sendEmailVerification(user);
        text.textContent = "Bestätigungsmail wurde gesendet. Nach der Bestätigung bitte neu anmelden.";
      } else if (!access.totpEnrolled) {
        await enrollAuthenticator(user);
      } else {
        await confirmPassword(user);
        await user.getIdToken(true);
      }
    } catch (cause) {
      error.textContent = cause.code === "auth/mfa-cancelled" ? t.cancelled
        : "Bestätigung nicht möglich. Bitte Passwort, Code und die Firebase-TOTP-Einrichtung prüfen.";
    } finally { button.disabled = false; }
  });
  panel.append(title, text, button, error);
}
