import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { id, clone, publicState, generateDraft, publishDraft, editAssignment, servingDates, localParts, markDraftsStale, validateState, shouldGenerate, addDays } from '../core/domain.mjs';
import {applyPlannerCommand} from '../core/planner.mjs';

const scrypt = (password,salt) => new Promise((resolve,reject) => scryptCallback(password,salt,32,{N:32768,r:8,p:1,maxmem:67108864},(error,value)=>error?reject(error):resolve(value)));
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message,status=400) => { const e=new Error(message); e.status=status; throw e; };
const json = (body,status=200,headers={}) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const cookieName = request => new URL(request.url).protocol === 'https:' ? '__Host-tns_admin' : 'tns_admin';
const cookieToken = request => (request.headers.get('cookie') || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookieName(request)}=`))?.split('=')[1] || '';
function cookie(request,token,clear=false) { return `${cookieName(request)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear?0:28800}${new URL(request.url).protocol==='https:'?'; Secure':''}`; }
async function passwordRecord(password) {
  if (typeof password!=='string' || password.length<12 || password.length>256) fail('Use a shared passphrase of 12–256 characters.');
  const salt=randomBytes(16).toString('hex');
  return {salt,hash:(await scrypt(password,salt)).toString('hex')};
}
async function verifyPassword(password,record) {
  if (!record || typeof password!=='string' || password.length>256) return false;
  const actual=await scrypt(password,record.salt),expected=Buffer.from(record.hash,'hex');
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
export async function initializePassword(store,password) { if (password && !await store.meta('admin')) await store.setMeta('admin',await passwordRecord(password)); }
async function startSession(store,request) { const token=randomBytes(32).toString('hex'); await store.createSession(digest(token),Date.now()+28800000); return cookie(request,token); }
async function authenticated(store,request) { const token=cookieToken(request); return token ? Boolean(await store.session(digest(token))) : false; }
async function bodyOf(request,max=200000) {
  if (!request.headers.get('content-type')?.includes('application/json')) fail('Send JSON data.',415);
  if (+(request.headers.get('content-length') || 0)>max) fail('This request is too large.',413);
  const text=await request.text(); if (text.length>max) fail('This request is too large.',413);
  try { return JSON.parse(text); } catch { fail('The submitted data was not valid JSON.'); }
}
export async function mutate(store,operation,expectedVersion) {
  for (let attempt=0;attempt<4;attempt++) {
    const {state,version}=await store.load();
    if (expectedVersion!==undefined && +expectedVersion!==version) fail('This workspace changed in another tab. Refresh and try again.',409);
    await operation(state);
    validateState(state);
    if (await store.save(state,version)) return {state,version:version+1};
  }
  fail('The workspace is busy. Please try again.',409);
}
const allowedFields={
  people:['id','name','group','team','role','assignable','active','partners'],
  programs:['id','name','mode','location','priority','active','description'],
  posts:['id','programId','label','kind','phase','location','counts','preferred','reuse','order','active','instructions','start','end','timeStart','timeEnd'],
  phases:['id','name','label','cue','timeStart','timeEnd'],
  classes:['id','name','programId','provisional','dates','tables','active'],
  events:['id','title','date','time','location','type','url','description','serviceNight'],
  resources:['id','title','category','description','url','body','published'],
  updates:['id','title','body','tag','date','pinned','published'],
  periods:['id','name','start','end']
};
function cleanRecord(collection,record) {
  if (!record || typeof record!=='object' || !allowedFields[collection]) fail('Unknown record type.');
  if (JSON.stringify(record).length>60000) fail('This record is too large.');
  const clean=Object.fromEntries(allowedFields[collection].filter(k=>Object.hasOwn(record,k)).map(k=>[k,record[k]]));
  clean.id ||= id();
  if (typeof clean.id!=='string' || clean.id.length>120) fail('Invalid record ID.');
  return clean;
}
function updatePersonPairs(state,person,previous) {
  if (person.role==='Team lead') person.assignable=false;
  for (const period of state.periods) {
    const partnerId=person.partners?.[period.id] || '';
    if (partnerId===person.id) fail('A leader cannot be their own partner.');
    const partner=partnerId?state.people.find(p=>p.id===partnerId):null;
    if (partnerId && (!partner || partner.group!==person.group)) fail('Choose a partner from the same staffing group.');
    if (previous?.partners?.[period.id]!==partnerId) {
      for (const other of state.people) if (other.id!==person.id && other.partners?.[period.id]===person.id) delete other.partners[period.id];
      if (partner) {
        const old=state.people.find(p=>p.id===partner.partners?.[period.id]);
        if (old?.partners?.[period.id]===partner.id) delete old.partners[period.id];
        partner.partners ||= {}; partner.partners[period.id]=person.id;
      }
    }
  }
}
function runCommand(state,command) {
  const {action}=command;
  if (action?.startsWith('planner:')) {
    applyPlannerCommand(state,command);
  } else if (action==='saveRecord') {
    const {collection}=command,record=cleanRecord(collection,command.record);
    const old=state[collection].find(x=>x.id===record.id),previous=old?clone(old):null;
    const next={...old,...record};
    if (collection==='people') updatePersonPairs(state,next,previous);
    if (collection==='programs' && old && old.location!==next.location) for (const post of state.posts) if (post.programId===old.id && post.location===old.location) post.location=next.location;
    if (old) Object.assign(old,next); else state[collection].push(next);
    if (['people','programs','posts','phases','classes','periods','events'].includes(collection)) markDraftsStale(state);
  } else if (action==='archive') {
    if (!allowedFields[command.collection]) fail('Unknown record type.');
    const record=state[command.collection].find(x=>x.id===command.id);
    if (!record) fail('Record not found.',404);
    if (['resources','updates'].includes(command.collection)) record.published=false; else record.active=false;
    markDraftsStale(state);
  } else if (action==='saveSettings') {
    const keys=Object.keys(state.settings);
    for (const key of keys) if (Object.hasOwn(command.settings,key)) state.settings[key]=command.settings[key];
    if (Object.hasOwn(command,'isSample')) state.isSample=Boolean(command.isSample);
    markDraftsStale(state);
  } else if (action==='generate') {
    state.schedules[command.date]={...state.schedules[command.date],date:command.date,draft:generateDraft(state,command.date)};
  } else if (action==='editAssignment') {
    if (!Array.isArray(command.people) || command.people.length>3) fail('Choose up to three leaders for a post.');
    editAssignment(state,command.date,command.assignmentId,command.people,Boolean(command.swap));
  } else if (action==='publish') {
    publishDraft(state,command.date,Boolean(command.acknowledgeShortages));
  } else if (action==='cancelAbsence') {
    state.absences=state.absences.filter(a=>a.id!==command.id); markDraftsStale(state);
  } else if (action==='importPeople') {
    if (!Array.isArray(command.rows) || !command.rows.length || command.rows.length>200) fail('Import 1–200 roster rows at a time.');
    if (command.replaceSample) {
      if (!state.isSample) fail('Sample replacement is only available in a sample workspace.');
      for (const person of state.people) person.active=false;
      state.schedules={};state.absences=[];
      for (const cohort of state.classes) for (const table of cohort.tables) Object.assign(table,{personId:'',externalName:'',externalTeam:'',externalConfirmed:false,externalOut:[]});
      state.events=state.events.filter(e=>e.id!=='event-hang');state.isSample=false;
    }
    for (const row of command.rows) {
      const name=String(row.name||'').trim();if(!name)fail('Every imported row needs a name.');
      const group=['men','women'].includes(row.group?.toLowerCase())?row.group.toLowerCase():'unassigned';
      const roles={'leader':'Leader','subteam lead':'Subteam lead','stl':'Subteam lead','team lead':'Team lead','tl':'Team lead'};
      const role=roles[row.role?.toLowerCase()]||'Leader';
      state.people.push({id:id(),name,group,team:String(row.team||'Unassigned').slice(0,100),role,assignable:role!=='Team lead',active:true,partners:{}});
    }
    markDraftsStale(state);
  } else if (action==='restore') {
    const restored=validateState(command.workspace);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state,restored);
    markDraftsStale(state);
  } else fail('Unknown action.');
  state.audit ||= [];
  state.audit.unshift({id:id(),date:new Date().toISOString(),actor:'Shared admin',action,detail:command.collection || command.date || ''});
  state.audit=state.audit.slice(0,200);
}

export async function handleApi(request,store,context={}) {
  const url=new URL(request.url),path=url.pathname,origin=request.headers.get('origin');
  const sameOrigin=!origin || origin===url.origin;
  const publicPath=['/api/public','/api/absence','/api/health'].includes(path);
  const allowedPublicOrigin=sameOrigin || origin===context.publicOrigin;
  const cors=publicPath?{'Access-Control-Allow-Origin':context.publicOrigin && origin===context.publicOrigin?origin:url.origin,'Vary':'Origin'}:{};
  try {
    if (request.method==='OPTIONS') {
      if (!publicPath || !allowedPublicOrigin) return json({error:'Origin not allowed.'},403);
      return new Response(null,{status:204,headers:{...cors,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-TNS-Request'}});
    }
    if (!['GET','POST'].includes(request.method)) fail('Method not allowed.',405);
    if (request.method==='POST' && (!allowedPublicOrigin || (!publicPath && !sameOrigin) || request.headers.get('x-tns-request')!=='1')) fail('Request origin not allowed.',403);
    if (path==='/api/health') return json({ok:true,storage:'connected',features:{nightPlanner:1}},200,cors);
    if (path==='/api/public' && request.method==='GET') return json({...publicState((await store.load()).state),backendReady:true},200,cors);
    if (path==='/api/auth' && request.method==='GET') return json({authenticated:await authenticated(store,request),configured:Boolean(await store.meta('admin')),setupAvailable:Boolean(context.localSetup || context.bootstrapToken),setupTokenRequired:!context.localSetup});
    if (path==='/api/setup' && request.method==='POST') {
      if (await store.meta('admin')) fail('Admin access is already configured.',409);
      const body=await bodyOf(request,2000);
      if (!context.localSetup && (!context.bootstrapToken || typeof body.setupToken!=='string' || digest(body.setupToken)!==digest(context.bootstrapToken))) fail('Use the setup token provided by the deployment owner.',403);
      if (!await store.limit(`setup:${context.ip || 'unknown'}`,5,3600000)) fail('Too many setup attempts. Try again later.',429);
      // The first-write claim prevents simultaneous setup requests from replacing a password.
      const record=await passwordRecord(body.password);
      const result=await store.db.run('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',['admin',JSON.stringify(record)]);
      if (!result.changes) fail('Admin access was configured in another tab.',409);
      return json({ok:true},200,{'Set-Cookie':await startSession(store,request)});
    }
    if (path==='/api/login' && request.method==='POST') {
      if (!await store.limit(`login:${context.ip || 'unknown'}`,10,900000)) fail('Too many attempts. Wait 15 minutes and try again.',429);
      const body=await bodyOf(request,2000),record=await store.meta('admin');
      if (!await verifyPassword(body.password,record)) fail('The admin password did not match.',401);
      return json({ok:true},200,{'Set-Cookie':await startSession(store,request)});
    }
    if (path==='/api/logout' && request.method==='POST') { await store.revoke(digest(cookieToken(request))); return json({ok:true},200,{'Set-Cookie':cookie(request,'',true)}); }
    if (path==='/api/absence' && request.method==='POST') {
      if (!await store.limit(`absence:${context.ip || 'unknown'}`,15,600000)) fail('Too many submissions. Please wait a few minutes.',429);
      const body=await bodyOf(request,6000);
      if (body.website) fail('Could not submit this form.');
      if (typeof body.reason!=='string' || !body.reason.trim() || body.reason.length>1000 || !Array.isArray(body.dates) || !body.dates.length || body.dates.length>52) fail('Choose your name, at least one date, and a reason of up to 1,000 characters.');
      await mutate(store,state=>{
        if (!state.people.some(p=>p.id===body.personId && p.active)) fail('Choose a name from the current roster.');
        const dates=servingDates(state),today=localParts(new Date(),state.settings.timezone).date;
        for (const date of new Set(body.dates)) {
          if (!dates.includes(date) || date<today) fail('Choose an upcoming serving date.');
          if (!state.absences.some(a=>a.personId===body.personId && a.date===date)) state.absences.push({id:id(),personId:body.personId,date,reason:body.reason.trim(),submittedAt:new Date().toISOString(),late:today>=date});
        }
        markDraftsStale(state);
      });
      return json({ok:true,dates:body.dates},200,cors);
    }
    if (path.startsWith('/api/admin')) {
      if (!await authenticated(store,request)) fail('Sign in to the admin area.',401);
      if (path==='/api/admin/state' && request.method==='GET') { const {state,version}=await store.load(); return json({...state,_version:version}); }
      if (path==='/api/admin/export' && request.method==='GET') return json((await store.load()).state,200,{'Content-Disposition':'attachment; filename="tns-workspace-backup.json"'});
      if (path==='/api/admin/password' && request.method==='POST') {
        const body=await bodyOf(request,2000);
        if (!await verifyPassword(body.currentPassword,await store.meta('admin'))) fail('The current password did not match.',401);
        await store.setMeta('admin',await passwordRecord(body.password)); await store.revokeAll();
        return json({ok:true},200,{'Set-Cookie':await startSession(store,request)});
      }
      if (path==='/api/admin/command' && request.method==='POST') {
        const body=await bodyOf(request,4000000);
        if (!Number.isInteger(body.version)) fail('Refresh the workspace before making changes.',409);
        const result=await mutate(store,state=>runCommand(state,body),body.version);
        return json({...result.state,_version:result.version});
      }
    }
    fail('Not found.',404);
  } catch (error) { return json({error:error.status?error.message:(error.message || 'The request could not be completed.')},error.status || 400,publicPath?cors:{}); }
}

export async function tick(store,now=new Date()) {
  const {state}=await store.load();
  if (!shouldGenerate(state,now)) return false;
  await mutate(store,current=>{if(shouldGenerate(current,now)){const date=localParts(now,current.settings.timezone).date;applyPlannerCommand(current,{action:'planner:prepare',date});current.schedules[date].draft.generatedAt=now.toISOString();}});
  return true;
}
