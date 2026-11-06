import {collection, onSnapshot} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {httpsCallable} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

const translations = {
  de: {empty: "Noch keine Gruppen vorhanden. Gruppen werden in der App erstellt.",
    members: "Mitarbeiter", filter: "Mitarbeiter filtern", loading: "Gruppen werden geladen …",
    saving: "Wird gespeichert …", saved: "Gespeichert", error: "Speichern fehlgeschlagen.",
    cell: (member, group) => `${group}: sichtbar für ${member}`, noMembers: "Keine passenden aktiven Mitglieder.",
    roles: {owner: "Inhaber", admin: "Admin", editor: "Bearbeiter", viewer: "Betrachter"}},
  en: {empty: "No groups yet. Create groups in the app.", members: "Members", filter: "Filter members",
    loading: "Loading groups …", saving: "Saving …", saved: "Saved", error: "Could not save.",
    cell: (member, group) => `${group}: visible to ${member}`, noMembers: "No matching active members.",
    roles: {owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer"}},
  fr: {empty: "Aucun groupe. Créez les groupes dans l’application.", members: "Membres", filter: "Filtrer les membres",
    loading: "Chargement des groupes …", saving: "Enregistrement …", saved: "Enregistré", error: "Échec de l’enregistrement.",
    cell: (member, group) => `${group} : visible pour ${member}`, noMembers: "Aucun membre actif correspondant.",
    roles: {owner: "Propriétaire", admin: "Admin", editor: "Éditeur", viewer: "Lecteur"}},
};

/** The matrix is administrative: even owners and admins have an editable display preference. */
export function createMachineGroupVisibility({db, functions, getContext, onError, language = "de"}) {
  const root = document.getElementById("machineGroupVisibilitySection");
  const mount = document.getElementById("machineGroupVisibilityTable");
  const status = document.getElementById("machineGroupVisibilityStatus");
  const filter = document.getElementById("machineGroupVisibilityFilter");
  const text = translations[language] || translations.de;
  const save = httpsCallable(functions, "manageMachineGroups");
  let unsubscribe = null;
  let scope = null;
  let generation = 0;
  let groups = [];
  let loaded = false;
  const pending = new Map();
  filter.placeholder = text.filter;
  filter.setAttribute("aria-label", text.filter);
  filter.addEventListener("input", render);

  function stop() {
    generation++;
    unsubscribe?.(); unsubscribe = null; scope = null; groups = []; loaded = false;
    pending.clear(); mount.replaceChildren(); status.textContent = ""; filter.value = "";
    root.classList.add("hidden");
  }
  function update() {
    const context = getContext();
    if (!context.companyId || !context.uid || context.membershipStatus !== "active" ||
        !["owner", "admin"].includes(context.role) || !context.licensed) { stop(); return; }
    const next = `${context.uid}:${context.companyId}`;
    if (scope !== next) {
      stop(); scope = next;
      const token = generation;
      unsubscribe = onSnapshot(collection(db, "companies", context.companyId, "machineGroups"), snapshot => {
        if (generation !== token) return;
        groups = snapshot.docs.map(doc => ({id: doc.id, ...doc.data()})).filter(group => !group.deleting)
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));
        loaded = true; render();
      }, error => {
        if (generation !== token) return;
        groups = []; loaded = true; render(); status.textContent = error.message; onError(error);
      });
    }
    root.classList.remove("hidden"); render();
  }
  function displayName(member, profiles) {
    const profile = profiles.get(member.id) || {};
    return [profile.firstName, profile.lastName].filter(value => typeof value === "string" && value.trim()).join(" ") ||
      profile.email || member.email || member.id;
  }
  function element(tag, value, className) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function render() {
    if (!scope) return;
    const context = getContext();
    const oldScroll = mount.scrollLeft;
    mount.replaceChildren();
    if (!loaded || !groups.length) {
      mount.append(element("p", !loaded ? text.loading : text.empty, "notice")); return;
    }
    const table = element("table", undefined, "machine-group-matrix");
    const head = element("thead"); const titles = element("tr");
    const corner = element("th", text.members); corner.scope = "col"; titles.append(corner);
    for (const group of groups) {
      const th = element("th"); th.scope = "col"; th.title = group.name;
      th.append(element("span", group.name, "machine-group-name")); titles.append(th);
    }
    head.append(titles); table.append(head);
    const body = element("tbody");
    const search = filter.value.trim().toLocaleLowerCase(language);
    const members = [...context.members.values()].filter(member => member.status === "active")
      .map(member => ({member, name: displayName(member, context.profiles)}))
      .filter(({name}) => name.toLocaleLowerCase(language).includes(search))
      .sort((a, b) => a.name.localeCompare(b.name, language));
    for (const {member, name} of members) {
      const row = element("tr");
      const nameCell = element("th"); nameCell.scope = "row"; nameCell.title = name;
      nameCell.append(element("span", name, "machine-group-member"),
        element("small", text.roles[member.role] || member.role));
      row.append(nameCell);
      for (const group of groups) {
        const key = `${member.id}:${group.id}`;
        const td = element("td"); const checkbox = document.createElement("input"); checkbox.type = "checkbox";
        checkbox.checked = pending.has(key) ? pending.get(key) : (group.visibleTo || []).includes(member.id);
        checkbox.disabled = pending.has(key);
        checkbox.setAttribute("aria-label", text.cell(name, group.name));
        checkbox.addEventListener("change", async () => {
          const visible = checkbox.checked; const token = generation; const expectedScope = scope;
          pending.set(key, visible); checkbox.disabled = true; status.textContent = text.saving;
          try {
            await save({operation: "setVisibility", companyId: context.companyId,
              groupId: group.id, memberId: member.id, visible});
            if (generation !== token || expectedScope !== scope) return;
            const current = groups.find(value => value.id === group.id);
            if (current) current.visibleTo = visible ? [...new Set([...(current.visibleTo || []), member.id])] :
              (current.visibleTo || []).filter(uid => uid !== member.id);
            status.textContent = text.saved;
          } catch (error) {
            if (generation !== token || expectedScope !== scope) return;
            status.textContent = text.error; onError(error);
          } finally {
            if (generation === token && expectedScope === scope) { pending.delete(key); render(); }
          }
        });
        td.append(checkbox); row.append(td);
      }
      body.append(row);
    }
    if (!members.length) {
      const row = element("tr"); const cell = element("td", text.noMembers);
      cell.colSpan = groups.length + 1; row.append(cell); body.append(row);
    }
    table.append(body); mount.append(table); mount.scrollLeft = oldScroll;
  }
  return {update, stop};
}
