import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createSeed} from '../core/seed.mjs';
import {handleApi,initializePassword} from '../server/api.mjs';
const password='fixture-only-passphrase-9347';
async function fixture(t,path=':memory:'){
 const db=new DatabaseSync(path);t.after(()=>db.close());
 const adapter={exec:async sql=>db.exec(sql),first:async(sql,args)=>db.prepare(sql).get(...args),run:async(sql,args)=>db.prepare(sql).run(...args)};
 const store=new Store(adapter,createSeed);await store.initialize();
 const request=(path,method='GET',body,cookie='',origin='http://localhost',context={localSetup:true,ip:'test'})=>handleApi(new Request(`http://localhost${path}`,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json','X-TNS-Request':'1'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})}),store,context);
 const login=async()=>{await initializePassword(store,password);const r=await request('/api/login','POST',{password});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 return{store,db,request,login};
}
test('public access works without login and admin state requires a valid server session',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/public')).status,200);assert.equal((await f.request('/api/admin/state')).status,401);const cookie=await f.login();const r=await f.request('/api/admin/state','GET',null,cookie);assert.equal(r.status,200);assert.equal((await r.json()).people.length,30);
});
test('setup is one-time and stores a salted hash; sessions are HttpOnly',async t=>{
 const f=await fixture(t);const r=await f.request('/api/setup','POST',{password});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.ok(!(await f.store.meta('admin')).hash.includes(password));assert.equal((await f.request('/api/setup','POST',{password})).status,409);
});
test('remote setup requires the deployment owner token',async t=>{
 const f=await fixture(t),context={bootstrapToken:'fixture-token',ip:'test'};assert.equal((await f.request('/api/setup','POST',{password},'','http://localhost',context)).status,403);assert.equal((await f.request('/api/setup','POST',{password,setupToken:'fixture-token'},'','http://localhost',context)).status,200);
});
test('absence requires a reason, blocks allocation, and keeps private text out of public responses',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/absence','POST',{personId:'sample-m1',dates:['2027-02-16'],reason:''})).status,400);
 const r=await f.request('/api/absence','POST',{personId:'sample-m1',dates:['2027-02-16'],reason:'fixture-private-detail'});assert.equal(r.status,200);
 const p=await(await f.request('/api/public')).json();assert.ok(!JSON.stringify(p).includes('fixture-private-detail'));assert.ok(p.schedules['2027-02-16'].assignments.every(a=>!a.people.includes('sample-m1')));
 const {state}=await f.store.load();assert.equal(state.absences[0].reason,'fixture-private-detail');assert.equal(state.schedules['2027-02-16'].draft.stale,true);assert.ok(state.schedules['2027-02-16'].draft.issues.some(i=>i.severity==='invalid')); 
});
test('all roles, including team leads, can submit multi-date absences',async t=>{
 const f=await fixture(t);for(const personId of ['sample-m0','sample-m1','sample-m5'])assert.equal((await f.request('/api/absence','POST',{personId,dates:['2027-02-23','2027-03-02'],reason:'Away'})).status,200);assert.equal((await f.store.load()).state.absences.length,6);
});
test('cross-site admin mutations are rejected; configured Pages origin can submit public absences',async t=>{
 const f=await fixture(t),cookie=await f.login();assert.equal((await f.request('/api/admin/command','POST',{action:'generate',date:'2027-02-23',version:1},cookie,'https://other.example')).status,403);
 const origin='https://team.example',context={publicOrigin:origin,ip:'test'};const r=await f.request('/api/absence','POST',{personId:'sample-m1',dates:['2027-03-02'],reason:'Away'},'',origin,context);assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),origin);
});
test('concurrent admin edits are rejected rather than overwriting newer data',async t=>{
 const f=await fixture(t),cookie=await f.login();const body={action:'generate',date:'2027-02-23',version:1};assert.equal((await f.request('/api/admin/command','POST',body,cookie)).status,200);assert.equal((await f.request('/api/admin/command','POST',body,cookie)).status,409);
});
test('draft generation and publication are separate and backups exclude authentication records',async t=>{
 const f=await fixture(t),cookie=await f.login(),date='2027-02-23';let r=await f.request('/api/admin/command','POST',{action:'generate',date,version:1},cookie);assert.equal(r.status,200);assert.equal((await(await f.request('/api/public')).json()).schedules[date],undefined);
 r=await f.request('/api/admin/command','POST',{action:'publish',date,version:2},cookie);assert.equal(r.status,200);assert.equal((await(await f.request('/api/public')).json()).schedules[date].status,'Published');
 const backup=await(await f.request('/api/admin/export','GET',null,cookie)).text();assert.ok(!backup.includes(password));assert.ok(!backup.includes('"sessions"'));assert.ok(!backup.includes((await f.store.meta('admin')).hash));
});
test('password rotation revokes the old session and accepts only the new password',async t=>{
 const f=await fixture(t),cookie=await f.login(),next='fixture-new-passphrase-7348';const r=await f.request('/api/admin/password','POST',{currentPassword:password,password:next},cookie);assert.equal(r.status,200);assert.equal((await f.request('/api/admin/state','GET',null,cookie)).status,401);assert.equal((await f.request('/api/login','POST',{password})).status,401);assert.equal((await f.request('/api/login','POST',{password:next})).status,200);
});
test('logout removes server-side session access',async t=>{
 const f=await fixture(t),cookie=await f.login();assert.equal((await f.request('/api/logout','POST',{},cookie)).status,200);assert.equal((await f.request('/api/admin/state','GET',null,cookie)).status,401);
});
test('roster import replaces fictional commitments without importing private columns',async t=>{
 const f=await fixture(t),cookie=await f.login();const r=await f.request('/api/admin/command','POST',{action:'importPeople',version:1,replaceSample:true,rows:[{name:'Real fixture leader',group:'women',team:'Equipping',role:'stl',privateNotes:'never-import'}]},cookie);assert.equal(r.status,200);const state=await r.json();assert.equal(state.isSample,false);assert.equal(state.people.filter(p=>p.active).length,1);assert.ok(!JSON.stringify(state).includes('never-import'));assert.ok(state.classes.every(c=>c.tables.every(t=>!t.personId&&!t.externalName)));assert.deepEqual(state.schedules,{});
});
test('database state persists across a store reopen',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'tns-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=join(directory,'test.sqlite');
 const db=new DatabaseSync(file),adapter={exec:async sql=>db.exec(sql),first:async(sql,args)=>db.prepare(sql).get(...args),run:async(sql,args)=>db.prepare(sql).run(...args)};let store=new Store(adapter,createSeed);await store.initialize();let {state,version}=await store.load();state.settings.teamName='Persisted fixture';assert.equal(await store.save(state,version),true);db.close();
 const reopened=new DatabaseSync(file);t.after(()=>reopened.close());store=new Store({exec:async sql=>reopened.exec(sql),first:async(sql,args)=>reopened.prepare(sql).get(...args),run:async(sql,args)=>reopened.prepare(sql).run(...args)},createSeed);await store.initialize();assert.equal((await store.load()).state.settings.teamName,'Persisted fixture');
});
