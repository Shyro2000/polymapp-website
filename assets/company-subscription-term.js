/* Company page only. All billing decisions are verified again by the callable. */
const strings = {
  de: {
    title: "Laufzeit und Kündigung", cancel: "Firmenabo kündigen …",
    active: d => `Die aktuelle Laufzeit ist bis einschliesslich ${d} bezahlt.`,
    confirm: d => `Firmenabo zum ${d} kündigen? Die bezahlte Laufzeit und die Firmendaten bleiben erhalten. Eine offene Jahresrechnung für die nächste Laufzeit wird storniert. Tarifänderungen für die laufende Periode bleiben bestehen.`,
    ending: d => `Gekündigt zum ${d}`, ended: d => `Abo am ${d} beendet`,
    noRenewal: "Es wird keine weitere Jahreslaufzeit verrechnet. Die Kündigung löscht keine Firmendaten.",
    restart: "Neues Jahresabo prüfen …",
    offer: (n, price) => `Neues Firmenabo für ${n} Plätze zu ${price} pro Jahr kostenpflichtig bestellen? Die neue Laufzeit beginnt mit der Zahlungsbestätigung.`,
    unavailable: "Neue kostenpflichtige Firmenabos werden derzeit nicht angeboten.",
    ordered: "Das neue Jahresabo wurde angefordert. Die Zahlung ist noch ausstehend.",
    stale: "Firma oder Laufzeit haben sich geändert. Bitte die Seite aktualisieren und das angezeigte Datum prüfen.",
    pending: "Bitte zuerst offene Rechnungen oder Tarifänderungen mit PolymApp klären.",
    forbidden: "Nur der aktuelle Inhaber darf das Firmenabo verwalten.",
    error: "Der Abostatus konnte nicht bestätigt werden. Bitte die Seite neu laden und erneut prüfen."
  },
  en: {
    title: "Subscription term and cancellation", cancel: "Cancel company subscription …",
    active: d => `The current term is paid up to and including ${d}.`,
    confirm: d => `Cancel the company subscription effective ${d}? Your paid term and company data will be kept. Any open annual invoice for the next term will be cancelled. Plan changes for the current term are unaffected.`,
    ending: d => `Cancellation scheduled for ${d}`, ended: d => `Subscription ended on ${d}`,
    noRenewal: "No further annual term will be billed. Cancelling does not delete company data.",
    restart: "Review a new annual subscription …",
    offer: (n, price) => `Order a new paid company subscription for ${n} seats at ${price} per year? The new term begins when payment is confirmed.`,
    unavailable: "New paid company subscriptions are not currently available.",
    ordered: "The new annual subscription has been requested. Payment is pending.",
    stale: "The company or term has changed. Refresh the page and check the date.",
    pending: "Please resolve any outstanding invoices or plan changes with PolymApp first.",
    forbidden: "Only the current owner can manage the company subscription.",
    error: "The subscription status could not be confirmed. Reload the page and check again."
  },
  fr: {
    title: "Durée et résiliation", cancel: "Résilier l’abonnement d’entreprise …",
    active: d => `La période en cours est payée jusqu’au ${d} inclus.`,
    confirm: d => `Résilier l’abonnement d’entreprise au ${d} ? La période déjà payée et les données de l’entreprise sont conservées. Toute facture annuelle ouverte pour la période suivante sera annulée. Les changements de tarif pour la période en cours restent valables.`,
    ending: d => `Résiliation prévue le ${d}`, ended: d => `Abonnement terminé le ${d}`,
    noRenewal: "Aucune nouvelle période annuelle ne sera facturée. La résiliation ne supprime aucune donnée de l’entreprise.",
    restart: "Consulter l’offre pour un nouvel abonnement annuel …",
    offer: (n, price) => `Souscrire un nouvel abonnement payant pour ${n} places à ${price} par an ? La nouvelle période commence à la confirmation du paiement.`,
    unavailable: "Il n’est pas possible de souscrire un nouvel abonnement payant pour le moment.",
    ordered: "Le nouvel abonnement annuel a été demandé. Le paiement est en attente.",
    stale: "L’entreprise ou la période a changé. Actualisez la page et vérifiez la date.",
    pending: "Veuillez d’abord clarifier les factures ou changements de tarif en suspens avec PolymApp.",
    forbidden: "Seul le propriétaire actuel peut gérer l’abonnement de l’entreprise.",
    error: "Impossible de confirmer l’état de l’abonnement. Rechargez la page et vérifiez à nouveau."
  }
};

export function createSubscriptionTermPanel({panel, context, cancel, catalog, order, notify}) {
  const lang = document.documentElement.lang.split("-")[0];
  const t = strings[lang] || strings.de;
  const locale = {de: "de-CH", en: "en-GB", fr: "fr-CH"}[lang] || "de-CH";
  // Invoice periods end at 23:59:59.999 UTC. Formatting in local time
  // would show the following calendar day in Switzerland.
  const dates = new Intl.DateTimeFormat(locale, {dateStyle: "long", timeZone: "UTC"});
  const money = new Intl.NumberFormat(locale, {style: "currency", currency: "CHF"});
  const summary = panel.querySelector("summary");
  const description = panel.querySelector("p");
  const button = panel.querySelector("button");
  let generation = 0;
  let busy = false;
  let timer;
  let lastKey = "";
  let acknowledged = null;

  function state() {
    const {uid, companyId, company: c, membership: m} = context();
    if (!uid || !companyId || !c || c.status !== "active" || c.ownerUid !== uid ||
        m?.status !== "active" || m.role !== "owner" || c.accessMode !== "paid") return null;
    const key = JSON.stringify([uid, companyId]);
    const end = c.billingValidUntil?.toMillis?.();
    const start = c.billingValidFrom?.toMillis?.();
    const savedEnd = c.subscriptionEndsAt?.toMillis?.();
    const localEnd = acknowledged?.key === key && acknowledged.end === end ? end : null;
    const cutoff = savedEnd ?? localEnd;
    const now = Date.now();
    if (Number.isFinite(cutoff)) {
      return {key, uid, companyId, end: cutoff, seats: c.seatLimit,
        mode: now > cutoff ? "ended" : "ending", suspended: c.billingStatus === "suspended"};
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now > end) return null;
    return {key, uid, companyId, end, mode: "active"};
  }

  function refresh() {
    clearTimeout(timer);
    const s = state();
    if (lastKey !== (s?.key || "")) {
      generation++;
      busy = false;
      panel.open = false;
      lastKey = s?.key || "";
    }
    panel.hidden = !s;
    if (!s) return;
    const day = dates.format(s.end);
    summary.textContent = s.mode === "active" ? t.title : t[s.mode](day);
    description.textContent = s.mode === "active" ? t.active(day) : t.noRenewal;
    button.hidden = s.mode === "ending" || (s.mode === "ended" && s.suspended);
    button.disabled = busy;
    button.textContent = s.mode === "active" ? t.cancel : t.restart;
    if (s.mode !== "ended") {
      timer = setTimeout(refresh, Math.min(2_147_000_000, Math.max(1, s.end + 1 - Date.now())));
    }
  }

  function reset() {
    generation++;
    clearTimeout(timer);
    lastKey = "";
    acknowledged = null;
    busy = false;
    panel.open = false;
    panel.hidden = true;
    description.textContent = "";
  }

  button.addEventListener("click", async () => {
    const s = state();
    if (busy || !s || s.mode === "ending" || (s.mode === "ended" && s.suspended)) return;
    const ticket = generation;
    const sameOwner = () => ticket === generation && state()?.key === s.key;
    busy = true;
    refresh();
    try {
      if (s.mode === "active") {
        if (!window.confirm(t.confirm(dates.format(s.end)))) return;
        const result = await cancel({companyId: s.companyId, expectedEndMs: s.end});
        if (!sameOwner()) return;
        if (result.data?.effectiveAtMs !== s.end) throw Error();
        acknowledged = {key: s.key, end: s.end};
        notify(t.ending(dates.format(s.end)), "success");
      } else {
        const response = await catalog();
        const latest = state();
        if (!sameOwner() || latest?.mode !== "ended" || latest.end !== s.end) return;
        const info = response.data;
        if (info?.paidEnrollmentEnabled !== true) {
          notify(t.unavailable, "info");
          return;
        }
        const price = info.tariffs?.find(tariff => tariff.seatLimit === s.seats);
        if (!Number.isSafeInteger(price?.annualCents) || latest.seats !== s.seats) {
          notify(t.stale, "error");
          return;
        }
        if (!window.confirm(t.offer(s.seats, money.format(price.annualCents / 100)))) return;
        await order({companyId: s.companyId, previousEndMs: s.end, seatLimit: s.seats,
          acceptPaidTerms: true, pricingVersion: info.pricingVersion});
        // The Firestore listener may already have hidden the finished term.
        const current = context();
        if (current.companyId === s.companyId && current.uid === s.uid &&
            current.membership?.status === "active" && current.membership.role === "owner" &&
            current.company?.ownerUid === s.uid) notify(t.ordered, "success");
      }
    } catch (err) {
      if (sameOwner()) {
        const msg = {term_changed: t.stale, billing_change_pending: t.pending,
          enrollment_disabled: t.unavailable}[err?.details?.reason];
        notify(msg || (err?.code === "functions/permission-denied" ? t.forbidden : t.error), "error");
      }
    } finally {
      if (ticket === generation) busy = false;
      refresh();
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  return {refresh, reset};
}
