import {auth} from "./website-auth.js";
import {getFunctions, httpsCallable} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
const functions = getFunctions(auth.app, "europe-west1");
const call = (name, data) => httpsCallable(functions, name)(data).then((result) => result.data);
const lang = document.documentElement.lang;
const t = {
 de:{title:"Firmenabo", loading:"Firmenabo wird geladen …", pilot:"Kostenlose Aufbauphase", active:"Aktiv", payment_pending:"Zahlung ausstehend", overdue:"Überfällig", expired:"Abgelaufen / noch nicht freigeschaltet", suspended:"Gesperrt", until:"Gültig bis", tariff:"Gebuchte Plätze", year:"Einführungspreis pro Jahr", calc:"Berechnung", month:"pro Platz / Monat", credit:"Tarifgutschrift", history:"Gutschriftenverlauf", change:"Tarif / Plätze ändern", preview:"Änderung berechnen", confirm:"Änderung bestätigen", quote:"Vorschau der Tarifänderung", add:"Zusätzlicher Betrag", use:"Verrechnete Gutschrift", gain:"Neue Tarifgutschrift", due:"Zu bezahlen", unchanged:"Das bisherige Ablaufdatum bleibt unverändert. Die Berechnung erfolgt taggenau. Bei einer Erhöhung werden die zusätzlichen Plätze nach Zahlungsbestätigung freigegeben.", free:"In der kostenlosen Aufbauphase entstehen weder Kosten noch Gutschriften.", pending:"Eine Tariferhöhung ist angefragt. PolymApp erstellt die Rechnung manuell. Die zusätzlichen Plätze werden nach Zahlungseingang freigegeben.", withdraw:"Anfrage zurückziehen", success:"Tarifänderung gespeichert.", waiting:"Tariferhöhung angefragt. Die bisherigen Plätze bleiben bis zur Zahlungsbestätigung gültig.", error:"Die Aktion konnte nicht ausgeführt werden. Bitte erneut versuchen.", stale:"Die Vorschau ist veraltet. Bitte neu berechnen.", occupied:"Die gewählte Stufe ist kleiner als die belegten oder reservierten Plätze. Entfernen Sie zuerst Mitglieder oder ziehen Sie Einladungen zurück.", invoicePending:"Es besteht bereits eine offene Rechnung oder Tarifänderung. Bitte zuerst abschliessen oder durch PolymApp stornieren lassen.", inactive:"Die Firmenfunktionen sind derzeit nicht freigeschaltet. Bitte wenden Sie sich an den Firmeninhaber.", select:"Tarif auswählen", seats:"Plätze", included:"Der Inhaber zählt als ein Platz. Gültige offene Einladungen reservieren einen Platz. Verrechnet wird das gebuchte Paket.", invoice:"Rechnungen", open:"Offen", paid:"Bezahlt", creditSettled:"Mit Gutschrift verrechnet", cancelled:"Storniert", enroll:"Kostenpflichtiges Firmenabo anfragen", enrollment:"Kostenpflichtiges Jahresabo zum angezeigten Einführungspreis anfragen? Die Nutzung beginnt nach Zahlungsbestätigung.", moreCredit:"Nur zur Verrechnung mit künftigen Firmenrechnungen; keine Einzahlung oder Auszahlung.", notice:"Die Einführung des kostenpflichtigen Firmenabos steht noch aus. Ein Starttermin ist noch nicht festgelegt. Sobald das Einführungsdatum feststeht, informieren wir Sie frühzeitig. Bis dahin entstehen keine Kosten.", months:"12 Monate", date:"Datum", amount:"Betrag"},
 en:{title:"Company subscription", loading:"Loading subscription …", pilot:"Free development phase", active:"Active", payment_pending:"Payment pending", overdue:"Overdue", expired:"Expired / not yet activated", suspended:"Suspended", until:"Valid until", tariff:"Booked seats", year:"Introductory annual price", calc:"Calculation", month:"per seat / month", credit:"Tariff credit", history:"Credit history", change:"Change tariff / seats", preview:"Calculate change", confirm:"Confirm change", quote:"Tariff change preview", add:"Additional amount", use:"Credit applied", gain:"New tariff credit", due:"Amount due", unchanged:"Your current expiry date stays the same. Charges are prorated by day. Additional seats become available after payment is confirmed.", free:"No charges or credits arise during the free development phase.", pending:"A tariff upgrade has been requested. PolymApp will prepare the invoice manually. Additional seats become available after payment.", withdraw:"Withdraw request", success:"Tariff change saved.", waiting:"Upgrade requested. Your existing seats remain available until payment is confirmed.", error:"The action failed. Please try again.", stale:"The preview has expired. Please calculate again.", occupied:"The selected tier is smaller than the occupied or reserved seats. Remove members or withdraw invitations first.", invoicePending:"There is already an open invoice or tariff change. Complete it or ask PolymApp to cancel it first.", inactive:"Company features are not currently enabled. Please contact your company owner.", select:"Select tariff", seats:"seats", included:"The owner counts as one seat. Valid pending invitations reserve a seat. The booked package determines the price.", invoice:"Invoices", open:"Open", paid:"Paid", creditSettled:"Settled by credit", cancelled:"Cancelled", enroll:"Request a paid company subscription", enrollment:"Request a paid annual subscription at the displayed introductory price? Access starts after payment is confirmed.", moreCredit:"For future company invoices only; no deposits or cash payouts.", notice:"The paid company subscription has not launched yet. No start date has been set. We will inform you well in advance once a launch date is confirmed. Until then, there are no charges.", months:"12 months", date:"Date", amount:"Amount"},
 fr:{title:"Abonnement d’entreprise", loading:"Chargement de l’abonnement …", pilot:"Phase de développement gratuite", active:"Actif", payment_pending:"Paiement en attente", overdue:"En retard", expired:"Expiré / pas encore activé", suspended:"Suspendu", until:"Valable jusqu’au", tariff:"Places réservées", year:"Prix annuel de lancement", calc:"Calcul", month:"par place / mois", credit:"Avoir tarifaire", history:"Historique des avoirs", change:"Modifier le tarif / les places", preview:"Calculer le changement", confirm:"Confirmer le changement", quote:"Aperçu du changement de tarif", add:"Montant supplémentaire", use:"Avoir déduit", gain:"Nouvel avoir tarifaire", due:"Montant à payer", unchanged:"La date d’expiration reste inchangée. Le calcul se fait au prorata des jours. Les places supplémentaires sont disponibles après confirmation du paiement.", free:"Aucun coût ni avoir ne résulte de la phase de développement gratuite.", pending:"Une augmentation de tarif a été demandée. PolymApp prépare la facture manuellement. Les places supplémentaires sont disponibles après le paiement.", withdraw:"Retirer la demande", success:"Changement de tarif enregistré.", waiting:"Augmentation demandée. Les places actuelles restent disponibles jusqu’à confirmation du paiement.", error:"L’action a échoué. Veuillez réessayer.", stale:"L’aperçu a expiré. Veuillez recalculer.", occupied:"Le forfait choisi est inférieur au nombre de places occupées ou réservées. Retirez d’abord des membres ou des invitations.", invoicePending:"Une facture ou un changement de tarif est déjà en cours. Terminez-le ou demandez à PolymApp de l’annuler.", inactive:"Les fonctions d’entreprise ne sont pas activées. Veuillez contacter le propriétaire.", select:"Choisir un tarif", seats:"places", included:"Le propriétaire occupe une place. Les invitations en cours de validité réservent une place. Le prix dépend du forfait choisi.", invoice:"Factures", open:"Ouverte", paid:"Payée", creditSettled:"Réglée par avoir", cancelled:"Annulée", enroll:"Demander un abonnement d’entreprise payant", enrollment:"Demander un abonnement annuel payant au prix de lancement affiché ? L’accès commence après confirmation du paiement.", moreCredit:"Uniquement pour les futures factures de l’entreprise ; aucun dépôt ni versement en espèces.", notice:"L’abonnement d’entreprise payant n’a pas encore été lancé. Aucune date de début n’a été fixée. Nous vous informerons suffisamment tôt dès qu’une date de lancement sera confirmée. D’ici là, aucun coût ne vous sera facturé.", months:"12 mois", date:"Date", amount:"Montant"},
}[lang] || {};
const money = (cents) => new Intl.NumberFormat(lang + "-CH", {style:"currency", currency:"CHF"}).format(Number(cents || 0) / 100);
const rate = (value) => new Intl.NumberFormat(lang + "-CH", {maximumFractionDigits:3, minimumFractionDigits:2}).format(value);
const date = (ms) => new Intl.DateTimeFormat(lang + "-CH", {timeZone:"UTC"}).format(new Date(ms));
let catalogue;
export async function selectedCreationTariff() {
  catalogue ||= await call("getCompanyTariffs");
  const value = Number(document.getElementById("createCompanyTier").value);
  const tariff = catalogue.tariffs.find((item) => item.seatLimit === value);
  if (!tariff) throw new Error(t.select);
  return {...tariff, pricingVersion:catalogue.pricingVersion, paidEnrollmentEnabled:catalogue.paidEnrollmentEnabled, notice:catalogue.paidEnrollmentEnabled ? t.enrollment : t.notice};
}
export async function setupCreationTariffs() {
  const slot = document.getElementById("createTariffSlot");
  if (!slot || !auth.currentUser) return;
  try {
    catalogue = await call("getCompanyTariffs");
    slot.innerHTML = `<div class="input-group"><label for="createCompanyTier">${t.select}</label><select id="createCompanyTier" required></select></div><p id="createTariffPrice"></p><p class="empty-state">${t.included}</p><p class="creation-tariff-note">${catalogue.paidEnrollmentEnabled ? t.enrollment : t.notice}</p>`;
    const select = slot.querySelector("select");
    catalogue.tariffs.forEach((item) => select.add(new Option(`${item.seatLimit} ${t.seats} · CHF ${rate(item.monthlyRate)} ${t.month} · ${money(item.annualCents)} / ${t.months}`, item.seatLimit)));
    const update = () => {
      const item = catalogue.tariffs.find((item) => item.seatLimit === Number(select.value));
      document.getElementById("createTariffPrice").textContent = `${item.seatLimit} × CHF ${rate(item.monthlyRate)} × 12 = ${money(item.annualCents)} / ${t.months}`;
    };
    select.addEventListener("change", update); update();
    document.getElementById("createCompanyButton").disabled = false;
  } catch {
    slot.textContent = t.error;
    document.getElementById("createCompanyButton").disabled = true;
  }
}
let lastCompany = null;
let fetchSequence = 0;
export async function updateSubscriptionUI(companyId) {
  const panel = document.getElementById("subscriptionPanel");
  const sequence = ++fetchSequence; lastCompany = companyId;
  if (!panel) return;
  panel.hidden = false; panel.textContent = t.loading;
  try {
    const data = await call("getCompanySubscription");
    if (sequence !== fetchSequence || lastCompany !== companyId || !auth.currentUser) return;
    if (!data.isOwner && ["editor", "viewer"].includes(data.role)) {
      panel.textContent = data.accessActive ? "" : t.inactive;
      panel.hidden = data.accessActive;
      return;
    }
    panel.innerHTML = `<h3>${t.title}</h3><p><strong>${t[data.status] || t.expired}</strong>${data.validUntilMs ? ` · ${t.until} ${date(data.validUntilMs)}` : ""}</p>`;
    if (!data.accessActive) {
      const warning = document.createElement("p");warning.className = "notice notice-warning";warning.textContent = t.inactive;panel.append(warning);
    }
    // Access status and capacity are operational information. Money is owner-only.
    if (!data.isOwner) return;
    panel.insertAdjacentHTML("beforeend", `<div class="subscription-summary"><p>${t.tariff}<strong>${data.seatLimit}</strong></p><p>${t.year}<strong>${money(data.annualCents)}</strong></p></div><p>${t.calc}: ${data.seatLimit} × CHF ${rate(data.monthlyRate)} × 12 = ${money(data.annualCents)}</p>${data.status === "pilot" ? `<p class="creation-tariff-note">${t.notice}</p>` : ""}`);
    if (data.creditBalanceCents > 0 || data.ledger?.length) {
      const credit = document.createElement("details");
      credit.innerHTML = `<summary>${t.credit}: ${money(data.creditBalanceCents)}</summary><p>${t.moreCredit}</p>`;
      const list = document.createElement("ul");
      data.ledger.forEach((entry) => { const li = document.createElement("li");li.textContent = `${entry.createdAtMs ? date(entry.createdAtMs) : ""}: ${money(entry.amountCents)}`;list.append(li); });credit.append(list);panel.append(credit);
    }
    if (data.invoices?.length) {
      const details = document.createElement("details");details.innerHTML = `<summary>${t.invoice}</summary>`;
      const list = document.createElement("ul");
      data.invoices.forEach((invoice) => { const li = document.createElement("li");li.textContent = `${invoice.invoiceNumber || ""}: ${money(invoice.amountCents)} · ${invoice.settledByCredit ? t.creditSettled : t[invoice.status] || invoice.status}${invoice.dueDate ? ` · ${invoice.dueDate}` : ""}`;list.append(li); });details.append(list);panel.append(details);
    }
    const error = document.createElement("p");error.setAttribute("role","alert");panel.append(error);
    const failure = (cause) => {error.textContent = ({quote_expired:t.stale,seats_occupied:t.occupied,billing_change_pending:t.invoicePending})[cause.details?.reason] || t.error;};
    if (data.pendingChange) {
      const notice = document.createElement("p");notice.textContent = `${t.pending} ${data.pendingChange.targetSeatLimit} ${t.seats} · ${t.due}: ${money(data.pendingChange.amountDueCents)} · ${t.use}: ${money(data.pendingChange.creditUsedCents)}`;panel.append(notice);
      if (data.invoices?.some((invoice) => ["open", "overdue"].includes(invoice.status))) {const p = document.createElement("p");p.textContent = t.invoicePending;panel.append(p);return;}
      const cancel = document.createElement("button");cancel.type="button";cancel.textContent=t.withdraw;
      cancel.onclick=async()=>{cancel.disabled=true;try{await call("cancelPendingCompanyTariff");await updateSubscriptionUI(companyId);}catch(e){failure(e);cancel.disabled=false;}};panel.append(cancel);return;
    }
    catalogue ||= await call("getCompanyTariffs");
    const controls = document.createElement("details");controls.innerHTML=`<summary>${t.change}</summary><label for="companyTariffTarget">${t.select}</label><select id="companyTariffTarget"></select><div class="button-row"><button type="button" data-preview>${t.preview}</button></div><div data-quote hidden class="subscription-quote"></div>`;
    const select = controls.querySelector("select");
    catalogue.tariffs.forEach((item)=>select.add(new Option(`${item.seatLimit} ${t.seats} · ${money(item.annualCents)} / ${t.months}`,item.seatLimit)));
    select.value=String(data.seatLimit);
    const quoteBox=controls.querySelector("[data-quote]");
    select.onchange=()=>{quoteBox.hidden=true;};
    controls.querySelector("[data-preview]").onclick=async(event)=>{
      const button=event.target;button.disabled=true;error.textContent="";
      try {
        const quote=await call("quoteCompanyTariff",{seatLimit:Number(select.value)});
        const requestId=crypto.randomUUID();quoteBox.hidden=false;
        quoteBox.innerHTML=`<strong>${t.quote}</strong><p>${quote.targetSeatLimit} ${t.seats} · ${money(quote.annualCents)} / ${t.months}</p><p>${quote.pilot?t.free:t.unchanged}</p>${!quote.pilot?`<p>${t.add}: ${money(Math.max(0,quote.deltaCents))}<br>${t.use}: ${money(quote.creditUsedCents)}<br>${t.gain}: ${money(quote.creditAddedCents)}<br><strong>${t.due}: ${money(quote.amountDueCents)}</strong></p>`:""}<button type="button">${t.confirm}</button>`;
        quoteBox.querySelector("button").onclick=async(click)=>{
          click.target.disabled=true;
          try {const result=await call("changeCompanyTariff",{seatLimit:quote.targetSeatLimit,quoteToken:quote.quoteToken,requestId});await updateSubscriptionUI(companyId);document.getElementById("subscriptionPanel").insertAdjacentText("beforeend",result.pending?t.waiting:t.success);}
          catch(e){failure(e);click.target.disabled=false;}
        };
      }catch(e){failure(e);}finally{button.disabled=false;}
    };
    panel.append(controls);
    if(data.paidEnrollmentEnabled && data.status==="pilot"){
      const enroll=document.createElement("button");enroll.textContent=t.enroll;enroll.type="button";
      enroll.onclick=async()=>{if(!confirm(`${t.enrollment}\n${money(data.annualCents)} / ${t.months}`))return;enroll.disabled=true;try{await call("requestPaidCompanySubscription",{acceptPaidTerms:true,pricingVersion:data.pricingVersion});await updateSubscriptionUI(companyId);}catch(e){failure(e);enroll.disabled=false;}};panel.append(enroll);
    }
  } catch {if(sequence===fetchSequence)panel.textContent=t.error;}
}
export function resetSubscriptionUI(){fetchSequence++;lastCompany=null;const p=document.getElementById("subscriptionPanel");if(p){p.hidden=true;p.textContent="";}}
