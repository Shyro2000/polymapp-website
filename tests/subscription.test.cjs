// Run only against the Firestore emulator: never against the production project.
process.env.GCLOUD_PROJECT = 'demo-polymapp';
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:18080';
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const path = require('node:path');
const req = createRequire(path.resolve(__dirname, '../functions/package.json'));
const {Timestamp} = req('firebase-admin/firestore');
const f = require('../functions/lib/index.js');
const {db} = require('../functions/lib/firebase.js');
const {proratedDelta,applyCredit,DAY_MS} = require('../functions/lib/company/tariffMath.js');
const {hasCompanyAccess} = require('../functions/lib/shared/companyAccess.js');
const version='intro-1';
const request=(uid,data={})=>({auth:{uid,token:{email:uid+'@example.test',email_verified:true}},data});
const invoke=(name,uid,data)=>f[name].run(request(uid,data));
const id=()=>require('node:crypto').randomUUID();
const billing={invoiceCompanyName:'Test GmbH',recipientName:'',street:'Testweg 1',city:'Zürich',postalCode:'8000',countryCode:'CH',country:'Schweiz',billingEmail:'owner@example.test'};
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
let companyId,company,sub,invoiceId,initialCredit;
const now=Date.now();const start=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth()-4,new Date(now).getUTCDate());
const end=Date.UTC(new Date(start).getUTCFullYear()+1,new Date(start).getUTCMonth(),new Date(start).getUTCDate())-1;
const dueDate=new Date(now+30*DAY_MS).toISOString().slice(0,10);
async function change(target,requestId=id()){
 const q=await invoke('quoteCompanyTariff','owner',{seatLimit:target});
 const result=await invoke('changeCompanyTariff','owner',{seatLimit:target,quoteToken:q.quoteToken,requestId});
 return {q,result,requestId};
}
test('money math: reversibility, leap years, expired/future periods and credit clamp',async()=>{
 const periods=[{id:'p',startMs:0,endMs:366*DAY_MS-1,annualCents:35400,seatLimit:20}];
 const up=proratedDelta(periods,52200,100*DAY_MS);
 assert.equal(up,Math.round(16800*266/366));
 assert.equal(proratedDelta([{...periods[0],annualCents:52200}],35400,100*DAY_MS),-up);
 assert.equal(proratedDelta(periods,52200,400*DAY_MS),0);
 assert.deepEqual(applyCredit(18000,20000),{creditUsedCents:18000,amountDueCents:0});
 assert.throws(()=>applyCredit(10,-1));
 assert.equal(hasCompanyAccess({status:'active',billingStatus:'not_configured'}),false);
 assert.equal(hasCompanyAccess({status:'active',accessMode:'pilot'}),true);
 assert.equal(hasCompanyAccess({status:'active',accessMode:'pilot',billingStatus:'suspended'}),false);
});
test('create requires verified identity, supported tier and complete billing data',async()=>{
 await db.collection('users').doc('owner').set({email:'owner@example.test'});
 await db.collection('users').doc('sysadmin').set({systemAdmin:true});
 await assert.rejects(()=>invoke('createCompany','owner',{name:'Test',seatLimit:11,pricingVersion:version,billingDetails:billing}));
 await assert.rejects(()=>invoke('createCompany','owner',{name:'Test',seatLimit:20,pricingVersion:version,billingDetails:{}}));
 const result=await invoke('createCompany','owner',{name:'Test GmbH',seatLimit:20,pricingVersion:version,billingDetails:billing});
 companyId=result.companyId;company=db.collection('companies').doc(companyId);sub=db.collection('companySubscriptions').doc(companyId);
 assert.equal((await company.get()).get('activeMemberCount'),1);
 assert.equal((await company.get()).get('accessMode'),'pilot');
 assert.equal((await db.collection('mail').doc('created-'+companyId).get()).get('to')[0],'info@polymapp.ch');
 assert.equal((await db.collection('companyBillingDetails').doc(companyId).get()).get('reviewedByOwnerUid'),'owner');
 await assert.rejects(()=>invoke('createCompany','owner',{name:'Duplicate',seatLimit:20,pricingVersion:version,billingDetails:billing}));
});
test('pilot cannot be invoiced and pilot changes never create money or credits',async()=>{
 await assert.rejects(()=>invoke('createCompanyInvoice','sysadmin',{companyId,dueDate}));
 const {q}=await change(30);assert.equal(q.deltaCents,0);
 assert.equal((await company.get()).get('seatLimit'),30);
 assert.equal((await sub.get()).get('creditBalanceCents'),0);
 await change(20);
 await assert.rejects(()=>invoke('requestPaidCompanySubscription','owner',{acceptPaidTerms:true,pricingVersion:version}));
});
test('only platform admin can enable billing; explicit owner opt-in precedes invoices',async()=>{
 await assert.rejects(()=>invoke('updateCompanyProgram','owner',{paidEnrollmentEnabled:true,launchDate:new Date().toISOString().slice(0,10)}));
 await invoke('updateCompanyProgram','sysadmin',{paidEnrollmentEnabled:true,launchDate:new Date().toISOString().slice(0,10)});
 await invoke('requestPaidCompanySubscription','owner',{acceptPaidTerms:true,pricingVersion:version});
 assert.equal((await company.get()).get('billingStatus'),'payment_pending');
 const result=await invoke('createCompanyInvoice','sysadmin',{companyId,dueDate});invoiceId=result.invoiceId;
 assert.equal(result.annualAmount,354);
 await assert.rejects(()=>invoke('createCompanyInvoice','sysadmin',{companyId,dueDate}));
 await invoke('markCompanyInvoicePaid','sysadmin',{invoiceId});
 assert.equal((await invoke('markCompanyInvoicePaid','sysadmin',{invoiceId})).changed,false);
 assert.equal((await company.get()).get('billingStatus'),'active');
});
test('downgrade generates exact credit once; only owner can read finance or alter seats',async()=>{
 await company.update({billingValidFrom:Timestamp.fromMillis(start),billingValidUntil:Timestamp.fromMillis(end)});
 await sub.collection('periods').doc(invoiceId).set({startAt:Timestamp.fromMillis(start),endAt:Timestamp.fromMillis(end),annualCents:35400,seatLimit:20});
 await db.collection('users').doc('viewer').set({companyId});
 await company.collection('members').doc('viewer').set({role:'viewer',status:'active'});
 await company.update({activeMemberCount:2});
 const basic=await invoke('getCompanySubscription','viewer');assert.equal(basic.isOwner,false);assert(!('creditBalanceCents'in basic));assert(!('invoices'in basic));assert(!('validUntilMs'in basic));assert(!('status'in basic));
 await assert.rejects(()=>invoke('quoteCompanyTariff','viewer',{seatLimit:10}));
 const {q,result,requestId}=await change(10);assert(!result.pending);
 initialCredit=-proratedDelta([{id:invoiceId,startMs:start,endMs:end,annualCents:35400,seatLimit:20}],18000,Date.now());
 assert.equal(q.creditAddedCents,initialCredit);assert.equal((await sub.get()).get('creditBalanceCents'),initialCredit);
 await invoke('changeCompanyTariff','owner',{seatLimit:10,quoteToken:q.quoteToken,requestId});
 assert.equal((await sub.get()).get('creditBalanceCents'),initialCredit);
 assert.equal((await company.get()).get('billingValidUntil').toMillis(),end);
});
test('occupied seats and valid invitations prevent an undersized package',async()=>{
 await change(20);
 for(let n=0;n<10;n++)await company.collection('members').doc('m'+n).set({role:'viewer',status:'active'});
 await assert.rejects(()=>invoke('quoteCompanyTariff','owner',{seatLimit:10}),e=>e.details.reason==='seats_occupied');
 for(let n=0;n<10;n++)await company.collection('members').doc('m'+n).delete();
 await db.collection('companyInvitations').doc('qa-valid').set({companyId,status:'pending',expiresAt:Timestamp.fromMillis(now+DAY_MS)});
 await db.collection('companyInvitations').doc('qa-expired').set({companyId,status:'pending',expiresAt:Timestamp.fromMillis(now-DAY_MS)});
 const q=await invoke('quoteCompanyTariff','owner',{seatLimit:10});assert.equal(q.reservedSeats,3);
 await db.collection('companyInvitations').doc('qa-valid').delete();await db.collection('companyInvitations').doc('qa-expired').delete();
 await change(10);initialCredit=(await sub.get()).get('creditBalanceCents');
});
test('pending upgrades reserve credit but do not activate seats; withdrawal restores it',async()=>{
 const {result}=await change(30);assert(result.pending);assert.equal((await company.get()).get('seatLimit'),10);
 assert.equal((await sub.get()).get('creditBalanceCents'),0);
 await invoke('cancelPendingCompanyTariff','owner');assert.equal((await sub.get()).get('creditBalanceCents'),initialCredit);
 assert.equal((await invoke('cancelPendingCompanyTariff','owner')).changed,false);
});
test('concurrent retries reserve credit only once',async()=>{
 const q=await invoke('quoteCompanyTariff','owner',{seatLimit:30});const requestId=id();
 const payload={seatLimit:30,quoteToken:q.quoteToken,requestId};
 const results=await Promise.all([invoke('changeCompanyTariff','owner',payload),invoke('changeCompanyTariff','owner',payload)]);
 assert(results.every(result=>result.pending));
 assert.equal((await sub.get()).get('creditBalanceCents'),initialCredit-q.creditUsedCents);
 await invoke('cancelPendingCompanyTariff','owner');
 assert.equal((await sub.get()).get('creditBalanceCents'),initialCredit);
});
test('upgrade invoices use net amount; cancellation restores credit exactly once',async()=>{
 const {q}=await change(30);
 const result=await invoke('createCompanyInvoice','sysadmin',{companyId,dueDate});
 assert.equal(Math.round(result.annualAmount*100),q.amountDueCents);
 await assert.rejects(()=>invoke('changeCompanyTariff','owner',{seatLimit:20,quoteToken:q.quoteToken,requestId:id()}));
 await assert.rejects(()=>invoke('cancelPendingCompanyTariff','owner'));
 await invoke('cancelCompanyInvoice','sysadmin',{invoiceId:result.invoiceId});
 assert.equal((await sub.get()).get('creditBalanceCents'),initialCredit);
 assert.equal((await invoke('cancelCompanyInvoice','sysadmin',{invoiceId:result.invoiceId})).changed,false);
});
test('later upgrade payment preserves expiry, credits unused waiting days and activates seats',async()=>{
 const {q}=await change(30);const created=await invoke('createCompanyInvoice','sysadmin',{companyId,dueDate});
 // Model an older issued quotation without changing the clock used by gRPC.
 await db.collection('companyInvoices').doc(created.invoiceId).update({grossAmountCents:q.deltaCents+100,annualAmount:created.annualAmount+1});
 await invoke('markCompanyInvoicePaid','sysadmin',{invoiceId:created.invoiceId});
 assert.equal((await company.get()).get('seatLimit'),30);
 assert.equal((await company.get()).get('billingValidUntil').toMillis(),end);
 const expected=100;
 assert.equal((await sub.get()).get('creditBalanceCents'),Math.max(0,expected));
});
test('prepaid future renewals are included; fully credited annual invoices activate without cash',async()=>{
 await sub.set({creditBalanceCents:200000},{merge:true});
 const created=await invoke('createCompanyInvoice','sysadmin',{companyId,dueDate});
 assert.equal(created.annualAmount,0);
 assert.equal((await db.collection('companyInvoices').doc(created.invoiceId).get()).get('status'),'paid');
 assert((await company.get()).get('billingValidUntil').toMillis()>end);
 const q=await invoke('quoteCompanyTariff','owner',{seatLimit:20});assert(q.creditAddedCents>10000);
});
test('repeated migrations preserve suspension/payment and notification reads require admin',async()=>{
 await db.collection('companies').doc('legacy-pilot').set({name:'Legacy',status:'active',seatLimit:10});
 await db.collection('companies').doc('legacy-suspended').set({name:'Blocked',status:'active',seatLimit:10,billingStatus:'suspended',billingValidUntil:Timestamp.fromMillis(end)});
 await invoke('migrateCompanySubscriptions','sysadmin');
 assert.equal((await db.collection('companies').doc('legacy-pilot').get()).get('accessMode'),'pilot');
 assert.equal((await db.collection('companies').doc('legacy-suspended').get()).get('accessMode'),'paid');
 assert.equal((await db.collection('companies').doc('legacy-suspended').get()).get('billingStatus'),'suspended');
 assert.equal((await invoke('migrateCompanySubscriptions','sysadmin')).migrated,0);
 await assert.rejects(()=>invoke('markCompanyNotificationRead','viewer',{notificationId:'created-'+companyId}));
 await invoke('markCompanyNotificationRead','sysadmin',{notificationId:'created-'+companyId});
 assert.equal((await db.collection('adminNotifications').doc('created-'+companyId).get()).get('read'),true);
});
test('new paid enrollment requires explicit confirmation after the launch switch',async()=>{
 await db.collection('users').doc('second').set({email:'second@example.test'});
 await assert.rejects(()=>invoke('createCompany','second',{name:'Paid Test',seatLimit:10,pricingVersion:version,billingDetails:billing}));
 const made=await invoke('createCompany','second',{name:'Paid Test',seatLimit:10,pricingVersion:version,billingDetails:billing,acceptPaidTerms:true});
 assert.equal((await db.collection('companies').doc(made.companyId).get()).get('accessMode'),'paid');
});
(async()=>{
 // Empty only the explicit demo emulator project.
 await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-polymapp/databases/(default)/documents`,{method:'DELETE'});
 for(const [name,fn]of tests){await fn();console.log('PASS',name);}
 console.log(`${tests.length} subscription integration scenarios passed`);
 await db.terminate();
})().catch(error=>{console.error(error);process.exit(1);});
