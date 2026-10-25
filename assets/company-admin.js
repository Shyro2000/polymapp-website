import {auth} from "./website-auth.js";
import {getFunctions, httpsCallable} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
const call=(name,data)=>httpsCallable(getFunctions(auth.app,"europe-west1"),name)(data);
const money=(c)=>new Intl.NumberFormat("de-CH",{style:"currency",currency:"CHF"}).format(Number(c||0)/100);
export function renderCompanyAdminExtras(data,reload){
  const root=document.getElementById("companyAdminExtras");root.replaceChildren();
  const heading=document.createElement("h2");heading.textContent="Neue Firmen und Tarifmeldungen";root.append(heading);
  const errors=document.createElement("p");errors.setAttribute("role","alert");root.append(errors);
  const run=async(button,name,payload)=>{button.disabled=true;try{await call(name,payload);await reload();}catch(error){errors.textContent=error.message;button.disabled=false;}};
  const unread=(data.notifications||[]).filter((item)=>!item.read);
  if(!unread.length){const p=document.createElement("p");p.textContent="Keine neuen Meldungen.";root.append(p);}
  unread.forEach((item)=>{
    const card=document.createElement("div");card.className="notice";
    const title=document.createElement("strong");title.textContent=item.title;
    const text=document.createElement("p");text.textContent=item.text;text.style.whiteSpace="pre-line";
    const button=document.createElement("button");button.type="button";button.textContent="Als gelesen markieren";
    button.onclick=()=>run(button,"markCompanyNotificationRead",{notificationId:item.id});
    card.append(title,text,button);root.append(card);
  });
  const note=document.createElement("p");note.className="empty-state";note.textContent="E-Mail-Meldungen an info@polymapp.ch werden über die Firebase-Erweiterung Trigger Email versendet. Ohne eingerichteten SMTP-Versand bleiben sie in der Warteschlange. Während der Aufbauphase keine Rechnungen erstellen.";root.append(note);
  const credits=(data.companies||[]).filter((company)=>company.creditBalanceCents>0||company.pendingChange);
  if(credits.length){const details=document.createElement("details");details.innerHTML="<summary>Tarifänderungen und Gutschriften</summary>";credits.forEach((company)=>{const p=document.createElement("p");p.textContent=`${company.name}: Gutschrift ${money(company.creditBalanceCents)}${company.pendingChange?` · Erhöhung auf ${company.pendingChange.targetSeatLimit} Plätze angefragt · Rechnung ${money(company.pendingChange.amountDueCents)}`:""}`;details.append(p);});root.append(details);}
  if(data.migrationRequired){
    const p=document.createElement("p");p.textContent="Bestehende Firmen müssen einmalig der Aufbauphase oder ihrem bisherigen bezahlten Zeitraum zugeordnet werden. Vor dem Hochladen der neuen Firestore-Regeln ausführen.";
    const button=document.createElement("button");button.type="button";button.textContent="Bestehende Firmen zuordnen";
    button.onclick=()=>{if(confirm("Bestehende Zahlungsdaten beibehalten und bisher kostenlose Firmen ausdrücklich für die Aufbauphase freigeben?"))run(button,"migrateCompanySubscriptions");};root.append(p,button);
  }
  const program=document.createElement("details");program.innerHTML=`<summary>Einführung des kostenpflichtigen Firmenabos</summary><p>${data.program?.paidEnrollmentEnabled?"Kostenpflichtige Anfragen sind freigegeben.":"Noch kein Starttermin. Die kostenlose Aufbauphase läuft."}</p><p>Erst aktivieren, nachdem die Kunden frühzeitig über das Datum informiert wurden. Bestehende Firmen werden nicht automatisch kostenpflichtig.</p><label for="paidLaunchDate">Bekanntgegebenes Einführungsdatum</label><input id="paidLaunchDate" type="date"><button type="button">${data.program?.paidEnrollmentEnabled?"Kostenpflichtige Anfragen deaktivieren":"Kostenpflichtige Anfragen ab dem Einführungsdatum freigeben"}</button>`;
  if(data.program?.launchDate)program.querySelector("input").value=data.program.launchDate;
  program.querySelector("button").onclick=(event)=>{const enabled=!data.program?.paidEnrollmentEnabled;if(!confirm(enabled?"Wurden die Kunden frühzeitig informiert und ist das Einführungsdatum erreicht?":"Kostenpflichtige Neuanfragen deaktivieren?"))return;run(event.target,"updateCompanyProgram",{paidEnrollmentEnabled:enabled,launchDate:program.querySelector("input").value});};root.append(program);
}
