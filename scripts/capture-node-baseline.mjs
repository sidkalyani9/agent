// Run with Node 24 against a separate checkout of the pre-migration backend.
// This is a test-data generator; no JavaScript backend is shipped or invoked by Python.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const s = await import(pathToFileURL(path.join(source, 'server/service.js')));
const calc = await import(pathToFileURL(path.join(source, 'server/calc.js')));
const chat = await import(pathToFileURL(path.join(source, 'server/chat.js')));
const passwords = await import(pathToFileURL(path.join(source, 'server/passwords.js')));
const secret = await import(pathToFileURL(path.join(source, 'server/secret.js')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-contract-'));
process.env.SESSION_SECRET = 'local-test-secret-never-use-in-a-real-deployment-42';
process.env.PANTRY_DATA_DIR = dir;
process.env.TOKENROUTER_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
const tables = ['person','office','role_grant','company_setting','pantry_product','pantry_purchase','pantry_count','pantry_receipt','operation','session','login_attempt','refresh_token','setup_ticket','idempotency','proposal','chat_thread','chat_message'];
const db = await s.openDatabase(path.join(dir,'test.sqlite'),{seed:'fixtures'});
s.setClock(()=>new Date('2026-09-20T06:30:00.000Z'));
const normalize = value => JSON.parse(JSON.stringify(value, (key,v) => key === 'temporaryPassword' ? '<password>' : typeof v === 'string' ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'<uuid>') : v));
try {
  const rows = Object.fromEntries(await Promise.all(tables.map(async table=>[table,await db.prepare(`SELECT * FROM ${table}${table==='chat_message'?' ORDER BY rowid':''}`).all()])));
  const vars = {};
  for (const [key,email] of Object.entries({admin:'avery.shah',manager:'meera.patel',reader:'kabir.mehta',observer:'isha.rao',otherManager:'rohan.desai'})) vars[key]=(await s.signIn(db,`${email}@intuitive.AI`)).person;
  const offices=await s.listOffices(db,vars.admin);
  vars.ahmedabad=offices.find(o=>o.name==='Ahmedabad').id;
  vars.pune=offices.find(o=>o.name==='Pune').id;
  vars.coffee=(await s.getPantry(db,vars.admin,vars.ahmedabad)).products.find(p=>p.name==='Coffee').productId;
  const initialVars=structuredClone(vars);
  const steps=[];
  const resolve=v=>typeof v==='string'&&v.startsWith('$')?v.slice(1).split('.').reduce((o,k)=>o[k],vars):Array.isArray(v)?v.map(resolve):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x)])):v;
  async function step(call,actor,args=[],save) {
    const spec={call,actor,args,...(save?{save}:{})};
    try { const result=await s[call](db,vars[actor],...resolve(args)); if(save)vars[save]=result; spec.expected={ok:normalize(result)}; }
    catch(error){spec.expected={error:{status:error.status||500,message:error.status?error.message:'Something went wrong.'}};}
    steps.push(spec);
  }
  for(const actor of ['admin','manager','reader','observer']) {
    await step('listOffices',actor); await step('getPantry',actor,['$ahmedabad','2026-09']);
    await step('getPantry',actor,['$pune','2026-08']); await step('summary',actor,['2026-09']);
    await step('listAccess',actor); await step('listPeople',actor);
  }
  await step('exportCsv','reader',['$ahmedabad','2026-09']);
  await step('listPurchases','reader',['$ahmedabad','2026-09']);
  await step('listOperations','manager',['$ahmedabad',{from:'2026-09-01',to:'2026-09-20'}]);
  await step('createOffice','observer',['Forbidden']);
  await step('createOffice','admin',['New office','$manager.id'],'newOffice');
  await step('assignOfficeManager','admin',['$newOffice.id','$manager.id']);
  await step('renameOffice','admin',['$newOffice.id','Renamed office']);
  await step('createProduct','manager',['$ahmedabad','Chocolate'],'chocolate');
  await step('createProduct','manager',['$ahmedabad','chocolate']);
  await step('createProduct','reader',['$ahmedabad','No permission']);
  await step('createProduct','manager',['$pune','Wrong office']);
  await step('updateProduct','manager',['$chocolate.productId',{name:'Chocolate bars',reorderLevel:'2',warningEffectiveDays:7}]);
  for(const body of [{name:''},{name:'x'.repeat(121)},{name:'bad\u0001name'},{reorderLevel:-1},{warningEffectiveDays:0},{reorderLevel:1.5}]) await step('updateProduct','manager',['$chocolate.productId',body]);
  await step('createPurchase','manager',['$ahmedabad',{productId:'$chocolate.productId',date:'2026-09-20',packs:3,pricePerPack:'25.50'},null,'test-save-key-001'],'purchase');
  await step('createPurchase','manager',['$ahmedabad',{productId:'$chocolate.productId',date:'2026-09-20',packs:3,pricePerPack:'25.50'},null,'test-save-key-001']);
  await step('createPurchase','manager',['$ahmedabad',{productId:'$chocolate.productId',date:'2026-09-20',packs:4,pricePerPack:'25.50'},null,'test-save-key-001']);
  for(const patch of [{date:'2026-02-30'},{date:'2026-09-21'},{packs:0},{packs:true},{packs:1.5},{packs:1000001},{pricePerPack:-1},{pricePerPack:''},{pricePerPack:1000001}]) await step('createPurchase','manager',['$ahmedabad',{productId:'$chocolate.productId',date:'2026-09-20',packs:1,pricePerPack:'10',...patch}]);
  await step('correctPurchase','manager',['$purchase.purchaseId',{packs:4,pricePerPack:'12.555',date:'2026-09-19'}]);
  await step('upsertCount','manager',['$ahmedabad',{productId:'$chocolate.productId',date:'2026-09-20',packs:2}],'count');
  await step('upsertCount','manager',['$ahmedabad',{productId:'$chocolate.productId',date:'2026-09-20',packs:1}]);
  await step('hideCount','manager',['$count.countId']);
  await step('upsertCount','manager',['$ahmedabad',{productId:'$chocolate.productId',date:'2026-09-20',packs:0}]);
  await step('hidePurchase','manager',['$purchase.purchaseId']);
  await step('hideProduct','manager',['$chocolate.productId']);
  await step('restoreProduct','manager',['$chocolate.productId']);
  await step('createChatThread','manager',[],'thread');
  await step('addChatMessage','manager',['$thread.id','user','A new chat']);
  await step('addChatMessage','manager',['$thread.id','assistant','Hello']);
  await step('recentChatHistory','manager',['$thread.id']);
  await step('getChatThread','manager',['$thread.id']);
  await step('getChatThread','otherManager',['$thread.id']);
  await step('listChatThreads','manager');
  await step('createProposal','reader',['add_count',{office:'Ahmedabad',product:'Coffee',packs:1}]);
  await step('createProposal','manager',['create_product',{office:'Ahmedabad',name:'Snacks'}],'proposal');
  await step('confirmProposal','manager',['$proposal.proposalId']);
  await step('confirmProposal','manager',['$proposal.proposalId']);
  await step('createProposal','manager',['add_purchase',{office:'Ahmedabad',product:'Snacks',packs:5,pricePerPack:10}],'proposal');
  await step('dismissProposal','manager',['$proposal.proposalId']);
  await step('createProposal','manager',['delete_product',{office:'Ahmedabad',product:'Chocolate bars'}],'proposal');
  await step('confirmProposal','manager',['$proposal.proposalId']);
  await step('updateSettings','reader',[{weekendWeight:.4}]);
  await step('updateSettings','admin',[{weekendWeight:0,lookbackMonths:6}]);
  await step('getPantry','manager',['$ahmedabad','2026-09']);
  await step('saveAccess','admin',[{signInName:'new.person@intuitive.AI',displayName:'New Person',role:'accounts',officeId:'$newOffice.id'}],'newPerson');
  await step('setPersonActive','admin',['$newPerson.id',false]);
  await step('setPersonActive','admin',['$newPerson.id',true]);
  await step('removeGrant','admin',['$newPerson.id','$newPerson.grants.0.id']);
  await step('setPersonActive','admin',['$admin.id',false]);
  const cases=[];
  let state=937;
  const random=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
  for(let j=0;j<120;j++) {
    const today='2026-09-20';
    const settings={weekendWeight:[0,.2,.5,1][random(4)],lookbackMonths:[2,3,6][random(3)]};
    const product={reorderLevel:random(7),warningEffectiveDays:random(12)+1};
    const purchases=Array.from({length:random(10)},(_,k)=>({purchasedOn:`2026-${String(7+random(3)).padStart(2,'0')}-${String(1+random(19)).padStart(2,'0')}`,packs:random(50)+1,pricePerPack:(random(50000)/100).toFixed(2),createdAt:`2026-09-20T06:30:${String(k).padStart(2,'0')}.000Z`,deletedAt:random(8)===0?'2026-09-20T06:30:00.000Z':null}));
    const counts=Array.from({length:random(3)},()=>({countedOn:`2026-09-${String(1+random(20)).padStart(2,'0')}`,packs:random(40),deletedAt:null}));
    const input={product,purchases,counts,settings,today};
    const math=calc.computeProduct(input); const basis=calc.monthFigures(purchases,'2026-09');
    cases.push({input,expected:{math,history:calc.monthHistory(purchases,settings,today),month:basis,forecast:calc.projectMonth({purchases,math,settings,today,basisPacks:basis.packsAdded,basisSpend:basis.spend}),series:calc.stockSeries({...input,burnRate:math.burnRatePerEffectiveDay,expectedDate:math.expectedDate,onHand:math.onHand})}});
  }
  const credentials={password:'Portable sample 42',hash:passwords.hashPassword('Portable sample 42'),secret:secret.seal('portable-directory-refresh'),issuedAt:Math.floor(Date.now()/1000),access:passwords.signAccess({sub:'portable-person',sid:'portable-session',csrf:'portable-csrf'}),setup:passwords.signSetup({sub:'portable-person',email:'portable@intuitive.AI',jti:'portable-ticket'})};
  const chatCases=[];
  for(const message of ['hide coffee','delete everything','remove the receipt','rename coffee','what is the weather','how much coffee is left at Ahmedabad?','when will it run out?','how much was spent at Pune?','what is left?']) chatCases.push({message,scope:chat.scopeReply(message),factual:await chat.factualReply(db,vars.manager,message,[{content:'Coffee at Ahmedabad'}])});
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({source:'Express baseline before FastAPI migration; captured with Node 24',clock:'2026-09-20T06:30:00.000Z',rows,vars:initialVars,steps,cases,credentials,chatCases},null,2)+'\n');
  console.log(`Captured ${steps.length} service cases and ${cases.length} calculation scenarios.`);
} finally {await db.close();fs.rmSync(dir,{recursive:true,force:true});}
