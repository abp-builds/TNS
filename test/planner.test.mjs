import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSeed} from '../core/seed.mjs';
import {clone,assignmentIssues,publishDraft,publicState,validateState,addDays} from '../core/domain.mjs';
import {baselineLayout} from '../core/layout.mjs';
import {applyPlannerCommand,ensureDraft,fillOpenSlots} from '../core/planner.mjs';
import {Store,sqliteAdapter} from '../server/store.mjs';
import {handleApi,initializePassword,tick} from '../server/api.mjs';

const date='2027-01-19';
const act=(state,op,params={})=>applyPlannerCommand(state,{action:`planner:${op}`,date,...params});
async function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());const store=new Store(sqliteAdapter(db),createSeed);await store.initialize();await initializePassword(store,'planner-fixture-only-passphrase');let cookie='';
  const request=(path,body)=>handleApi(new Request(`http://localhost${path}`,{method:body?'POST':'GET',headers:{Origin:'http://localhost',Cookie:cookie,...(body?{'Content-Type':'application/json','X-TNS-Request':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})}),store,{localSetup:true,ip:'planner-fixture'});
  const login=await request('/api/login',{password:'planner-fixture-only-passphrase'});cookie=login.headers.get('set-cookie').split(';')[0];
  const command=async(op,params={},status=200)=>{const {version}=await store.load();const r=await request('/api/admin/command',{action:`planner:${op}`,date,version,...params});const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));return body;};
  return{db,store,request,command};
}
test('night structure edits retain names, update all matching details, and leave defaults and other nights unchanged',()=>{
  const s=createSeed(),old=clone(s.posts),other=clone(s.schedules['2027-02-16']),d=ensureDraft(s,date),people=d.assignments.map(a=>[a.slotKey,a.people]),layout=clone(d.layout);
  const post=layout.posts.find(p=>p.id==='engine');post.label='Service prayer';post.location='Chapel';post.instructions='Bring the prayer guide';
  act(s,'layout',{layout});const next=s.schedules[date].draft;
  assert.deepEqual(next.assignments.map(a=>[a.slotKey,a.people]),people);assert.ok(next.assignments.filter(a=>a.postId==='engine').every(a=>a.location==='Chapel'&&a.instructions==='Bring the prayer guide'&&a.label.startsWith('Service prayer')));
  assert.deepEqual(s.posts,old);assert.deepEqual(s.schedules['2027-02-16'],other);validateState(s);
});
test('one-night slot overrides survive family edits and appear only after publishing',()=>{
  const s=createSeed(),d=ensureDraft(s,date),a=d.assignments.find(a=>a.postId==='engine'),before=clone(publicState(s).schedules[date]);
  act(s,'slot',{assignmentId:a.id,fields:{label:'Prayer at the chapel',location:'Chapel balcony',notes:'Enter through the side door',timeStart:'19:30',timeEnd:'20:00'}});
  const layout=clone(d.layout);layout.posts.find(p=>p.id==='engine').instructions='Prayer guide for everyone';act(s,'layout',{layout});
  assert.deepEqual(publicState(s).schedules[date],before);publishDraft(s,date,true);const published=publicState(s).schedules[date].assignments.find(x=>x.id===a.id);
  assert.equal(published.notes,'Enter through the side door');assert.equal(published.location,'Chapel balcony');assert.equal(published.timeStart,'19:30');assert.equal(published.instructions,'Prayer guide for everyone');
});
test('presets save structure without names by default and do not rewrite prepared nights',()=>{
  const s=createSeed();act(s,'savePreset',{name:'Ordinary night',makeDefault:true});const preset=s.presets[0];assert.deepEqual(preset.assignments,[]);
  const old=clone(s.schedules[date]);act(s,'prepare',{date:'2027-01-26'});assert.deepEqual(s.schedules[date],old);assert.deepEqual(s.schedules['2027-01-26'].draft.layout,preset.layout);publishDraft(s,'2027-01-26',true);assert.ok(!JSON.stringify(publicState(s)).includes('Ordinary night'));
});
test('optional preset people respect absences and current class commitments',()=>{
  const s=createSeed();act(s,'savePreset',{name:'Named start',includePeople:true,makeDefault:true});assert.ok(s.presets[0].assignments.length);
  s.absences.push({id:'absence-fixture',personId:'sample-m1',date:'2027-02-23',reason:'Private fixture'});
  act(s,'prepare',{date:'2027-02-23'});const d=s.schedules['2027-02-23'].draft;
  assert.ok(d.assignments.every(a=>!a.people.includes('sample-m1')));assert.ok(d.assignments.filter(a=>a.classId).every(a=>!a.committedPersonId||a.people.includes(a.committedPersonId)||a.committedPersonId==='sample-m1'));
  assert.ok(!assignmentIssues(s,d.assignments,'2027-02-23').some(i=>i.severity==='invalid'));
});
test('drag-style seat placement swaps two names in one action',()=>{
  const s=createSeed(),d=ensureDraft(s,date),slots=d.assignments.filter(a=>a.postId==='engine'&&a.group==='men'),a=slots[0],b=slots[1],first=a.people[0],second=b.people[0];
  act(s,'place',{people:[first],sourceId:a.id,assignmentId:b.id,seat:0});assert.equal(b.people[0],first);assert.equal(a.people[0],second);assert.ok(!d.issues.some(i=>i.severity==='invalid'));
});
test('bulk placement is atomic when one selected person is absent',async t=>{
  const f=await fixture(t);await f.command('clear');let {state,version}=await f.store.load();state.absences.push({id:'away',personId:'sample-m2',date,reason:'Away'});await f.store.save(state,version);
  const before=clone((await f.store.load()).state.schedules[date]);await f.command('place',{postId:'engine',people:['sample-m1','sample-m2']},400);
  assert.deepEqual((await f.store.load()).state.schedules[date],before);
});
test('bulk allocation fills required seats before adding optional partners',()=>{
  const s=createSeed();act(s,'clear');act(s,'place',{postId:'next-table',people:['sample-m1','sample-m2','sample-m3']});const rows=s.schedules[date].draft.assignments.filter(a=>a.postId==='next-table'&&a.group==='men');assert.deepEqual(rows.slice(0,3).map(a=>a.people.length),[1,1,1]);
});
test('person-wide assignment changes apply to the full night atomically and retain class definitions',()=>{
  const s=createSeed(),d=ensureDraft(s,date),classes=clone(s.classes);act(s,'clear');const engine=d.assignments.find(a=>a.postId==='engine'&&a.group==='men'),table=d.assignments.find(a=>a.postId==='next-table'&&a.group==='men');
  act(s,'person',{personId:'sample-m1',assignments:[engine.id,table.id]});assert.equal(d.assignments.filter(a=>a.people.includes('sample-m1')).length,2);assert.deepEqual(s.classes,classes);
});
test('explicit clock overlaps across different phases are rejected without a saved partial edit',async t=>{
  const f=await fixture(t);await f.command('clear');const {state}=await f.store.load(),d=state.schedules[date].draft,engine=d.assignments.find(a=>a.postId==='engine'&&a.group==='men'),table=d.assignments.find(a=>a.postId==='next-table'&&a.group==='men');
  await f.command('slot',{assignmentId:engine.id,fields:{timeStart:'20:00',timeEnd:'21:00'}});await f.command('slot',{assignmentId:table.id,fields:{timeStart:'20:30',timeEnd:'21:30'}});
  await f.command('person',{personId:'sample-m1',assignments:[engine.id,table.id]},400);assert.ok((await f.store.load()).state.schedules[date].draft.assignments.every(a=>!a.people.includes('sample-m1')));
});
test('undo restores only the draft and preserves the published plan and preset library',()=>{
  const s=createSeed(),before=clone(ensureDraft(s,date)),published=clone(s.schedules[date].published);act(s,'clear');act(s,'savePreset',{name:'Another preset'});act(s,'restore',{draft:before});assert.deepEqual(s.schedules[date].draft.assignments,before.assignments);assert.deepEqual(s.schedules[date].published,published);assert.equal(s.presets.length,1);
});
test('fill open slots preserves existing valid placements and does not publish',()=>{
  const s=createSeed(),d=ensureDraft(s,date),slot=d.assignments.find(a=>a.postId==='engine'&&a.group==='men'),pid=slot.people[0],published=clone(s.schedules[date].published);
  const other=d.assignments.find(a=>a.postId==='engine'&&a.group==='women');other.people=[];fillOpenSlots(s,date);assert.equal(slot.people[0],pid);assert.equal(other.people.length,1);assert.deepEqual(s.schedules[date].published,published);
});
test('night and preset records migrate lazily, reopen, and exclude auth metadata from state',async t=>{
  const f=await fixture(t);assert.equal(JSON.parse(f.db.prepare('SELECT data FROM workspace').get().data).storageFormat,undefined);await f.command('savePreset',{name:'Persisted preset'});
  assert.equal(JSON.parse(f.db.prepare('SELECT data FROM workspace').get().data).storageFormat,2);const reopened=new Store(sqliteAdapter(f.db),createSeed);await reopened.initialize();const {state}=await reopened.load();assert.equal(state.presets[0].name,'Persisted preset');assert.equal(Object.keys(state.schedules).length,2);assert.ok(!JSON.stringify(state).includes('planner-fixture-only-passphrase'));
});
test('stale writers cannot overwrite or delete any night or preset records',async t=>{
  const f=await fixture(t);await f.command('prepare');const other=new Store(sqliteAdapter(f.db),createSeed);await other.initialize();const a=await f.store.load(),b=await other.load();a.state.schedules[date].draft.assignments[0].notes='First edit';assert.equal(await f.store.save(a.state,a.version),true);b.state.schedules={};b.state.presets=[];assert.equal(await other.save(b.state,b.version),false);assert.equal((await f.store.load()).state.schedules[date].draft.assignments[0].notes,'First edit');
});
test('a full season of detailed plans is stored as separate bounded records',async t=>{
  const f=await fixture(t),{state,version}=await f.store.load(),sample=clone(state.schedules[date]);state.schedules={};
  for(let i=0;i<47;i++){const day=addDays(date,i*7),night=clone(sample);night.date=day;night.draft.date=day;night.draft.assignments[0].notes='Detailed fixture '.repeat(3500);state.schedules[day]=night;}
  assert.ok(JSON.stringify(state).length>2000000);assert.equal(await f.store.save(state,version),true);assert.ok(f.db.prepare('SELECT length(data) AS size FROM workspace').get().size<100000);assert.ok(f.db.prepare("SELECT max(length(data)) AS size FROM workspace_records WHERE kind='night'").get().size<2000000);assert.equal(Object.keys((await f.store.load()).state.schedules).length,47);
});
test('cron creates the default preset draft without publishing or overwriting existing drafts',async t=>{
  const f=await fixture(t);await f.command('savePreset',{name:'Cron default',makeDefault:true});assert.equal(await tick(f.store,new Date('2027-01-26T13:10:00Z')),true);assert.equal(await tick(f.store,new Date('2027-01-26T13:20:00Z')),false);const {state}=await f.store.load();assert.deepEqual(state.schedules['2027-01-26'].draft.layout,state.presets[0].layout);assert.equal(state.schedules['2027-01-26'].published,undefined);
});
test('an empty committed class slot reclaims its leader before weekly positions are filled',()=>{
  const s=createSeed(),day='2027-02-16',d=ensureDraft(s,day),fixed=d.assignments.find(a=>a.classId),pid=fixed.committedPersonId,weekly=d.assignments.find(a=>a.postId==='next-table'&&a.group===fixed.group);
  weekly.people=[];applyPlannerCommand(s,{action:'planner:person',date:day,personId:pid,assignments:[weekly.id]});assert.equal(fixed.people.length,0);fillOpenSlots(s,day);assert.ok(fixed.people.includes(pid));assert.ok(!weekly.people.includes(pid));assert.equal(s.classes[0].tables.find(t=>t.id===fixed.tableId).personId,pid);
});
test('one person cannot count as both reusable host positions',async t=>{
  const f=await fixture(t),day='2027-02-16';let {state}=await f.store.load();const hosts=state.schedules[day].draft.assignments.filter(a=>a.postId==='disciple-host'),pid=hosts[0].people[0];
  await f.command('clear',{date:day,assignmentId:hosts[1].id});const before=clone((await f.store.load()).state.schedules[day]);await f.command('place',{date:day,people:[pid],assignmentId:hosts[1].id,seat:0},400);assert.deepEqual((await f.store.load()).state.schedules[day],before);
});
test('portable preset import strips people and unknown settings',()=>{
  const s=createSeed(),layout=baselineLayout(s);layout.people=[{name:'Do not import this name'}];layout.settings.password='Do not import this secret';act(s,'importPreset',{preset:{name:'Portable',layout,assignments:[{people:['sample-m1']}]}});assert.deepEqual(s.presets[0].assignments,[]);assert.ok(!JSON.stringify(s.presets).includes('Do not import'));
});
test('clearing a per-slot time restores the post or phase timing',()=>{
  const s=createSeed(),d=ensureDraft(s,date),layout=clone(d.layout);layout.phases.find(p=>p.id==='service').timeStart='19:30';layout.phases.find(p=>p.id==='service').timeEnd='20:00';act(s,'layout',{layout});const a=s.schedules[date].draft.assignments.find(a=>a.postId==='engine');act(s,'slot',{assignmentId:a.id,fields:{timeStart:'19:40'}});act(s,'slot',{assignmentId:a.id,fields:{timeStart:''}});assert.equal(a.timeStart,'19:30');assert.equal(a.overrides.timeStart,undefined);
});
