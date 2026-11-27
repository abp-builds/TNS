import {id,clone,generateDraft,assignmentIssues,isEligible,isOut,externalPresent} from './domain.mjs';
import {baselineLayout,defaultLayout,withLayout,validateLayout,phaseTime} from './layout.mjs';

const error = text => {throw new Error(text);};
export function ensureDraft(state,date) {
  if(!state.schedules[date]?.draft){const preset=state.presets?.find(p=>p.id===state.defaultPresetId&&p.active!==false);state.schedules[date]={...state.schedules[date],date,draft:{...generateDraft(state,date),presetId:preset?.id||'',presetName:preset?.name||'Workspace baseline',structureCustomized:false}};}
  const d=state.schedules[date].draft;
  d.layout ||= baselineLayout(state);
  const counts=new Map();
  for(const a of d.assignments){const key=`${a.postId}:${a.group}`,n=counts.get(key)||0;counts.set(key,n+1);a.slotKey ||= a.classId?`${a.postId}:${a.classId}:${a.tableId}`:`${key}:${n}`;a.overrides ||= {};const post=d.layout.posts.find(p=>p.id===a.postId);a.kind ||= post?.kind;a.postLabel ||= post?.label;a.instructions ??= post?.instructions||'';}
  return d;
}
function cleanupHosts(draft) {
  for(const a of draft.assignments.filter(a=>a.reuse))a.people=a.people.filter(pid=>draft.assignments.some(t=>t.id!==a.id&&t.programId===a.programId&&t.kind==='table'&&t.people.includes(pid)));
}
function finish(state,date,{allowInvalid=false}={}) {
  const d=ensureDraft(state,date);cleanupHosts(d);
  if(d.assignments.length>500)error('Keep the night to at most 500 slots.');
  d.issues=assignmentIssues(state,d.assignments,date);
  const invalid=d.issues.find(i=>i.severity==='invalid');
  if(invalid&&!allowInvalid)error(invalid.message);
  d.stale=false;d.status='Ready for review';d.editedAt=new Date().toISOString();
  return d;
}
export function rebuildNight(state,date,layout,{keepPeople=true}={}) {
  const old=ensureDraft(state,date),byKey=new Map(old.assignments.map(a=>[a.slotKey,a]));
  validateLayout(layout);
  state.schedules[date].draft={...old,layout:clone(layout)};
  const next=generateDraft(state,date);
  next.presetId=old.presetId||'';next.presetName=old.presetName||'Workspace baseline';next.structureCustomized=true;
  for(const a of next.assignments){
    const previous=byKey.get(a.slotKey);a.people=keepPeople&&previous?[...previous.people]:[];
    if(previous){a.id=previous.id;a.overrides=clone(previous.overrides||{});}
    applyOverrides(a);
  }
  state.schedules[date].draft=next;
  return finish(state,date);
}
function applyOverrides(a){for(const key of ['label','location','instructions','notes','timeStart','timeEnd'])if(Object.hasOwn(a.overrides||{},key))a[key]=a.overrides[key];}
function validCandidate(state,date,draft,a,pid) {
  const person=state.people.find(p=>p.id===pid);
  if(!person||!isEligible(person)||isOut(state,pid,date)||(a.group!=='any'&&a.group!==person.group)||a.people.includes(pid)||a.people.length>=a.preferred)return false;
  if(a.reuse)return draft.assignments.some(t=>t.programId===a.programId&&t.kind==='table'&&t.people.includes(pid))&&!draft.assignments.some(t=>t.id!==a.id&&t.postId===a.postId&&t.people.includes(pid));
  return !draft.assignments.some(other=>{if(other.id===a.id||other.reuse||!other.people.includes(pid))return false;return a.timeStart&&a.timeEnd&&other.timeStart&&other.timeEnd?a.timeStart<other.timeEnd&&other.timeStart<a.timeEnd:a.phase===other.phase;});
}
export function fillOpenSlots(state,date) {
  const d=ensureDraft(state,date),night=withLayout(state,d.layout),people=state.people.filter(p=>isEligible(p)&&!isOut(state,p.id,date));
  // Clear obsolete availability without throwing away valid manual allocations.
  for(const a of d.assignments){a.kind ||= night.posts.find(p=>p.id===a.postId)?.kind;a.people=a.people.filter(pid=>people.some(p=>p.id===pid&&(a.group==='any'||p.group===a.group)));
    if(a.classId){const table=state.classes.find(c=>c.id===a.classId)?.tables.find(t=>t.id===a.tableId);if(table){a.externalAvailable=externalPresent(table,date);a.externalName=table.externalName;a.externalTeam=table.externalTeam;a.committedPersonId=table.personId;}}
  }
  cleanupHosts(d);
  const historyCache=new Map();
  const history=(pid,postId)=>{const key=`${pid}:${postId}`;if(!historyCache.has(key))historyCache.set(key,Object.values(state.schedules).filter(s=>s.date<date&&s.published).reduce((n,s)=>n+s.published.assignments.filter(a=>a.postId===postId&&a.people.includes(pid)).length,0));return historyCache.get(key);};
  const rank=a=>people.filter(p=>(a.group==='any'||p.group===a.group)&&!a.people.includes(p.id)).sort((aP,bP)=>{
    const engine=p=>d.assignments.some(s=>s.kind==='service'&&s.people.includes(p.id));
    return (a.kind==='prayer'?Number(engine(aP))-Number(engine(bP)):0)||history(aP.id,a.postId)-history(bP.id,a.postId)||aP.name.localeCompare(bP.name);
  });
  const slots=d.assignments.slice().sort((a,b)=>{
    const stage=a=>a.reuse?3:a.kind==='prayer'?4:!a.programId?2:0;
    return stage(a)-stage(b)||(night.programs.find(p=>p.id===a.programId)?.priority||99)-(night.programs.find(p=>p.id===b.programId)?.priority||99)||Number(a.kind!=='table')-Number(b.kind!=='table');
  });
  // Reserve fixed class partners before any weekly roles consume them.
  for(const a of slots.filter(a=>a.classId&&!a.people.length))if(a.committedPersonId&&people.some(p=>p.id===a.committedPersonId)){
    const displaced=d.assignments.filter(other=>other.id!==a.id&&!other.classId&&!other.reuse&&other.phase===a.phase&&other.people.includes(a.committedPersonId));
    for(const other of displaced)other.people=other.people.filter(pid=>pid!==a.committedPersonId);
    if(validCandidate(state,date,d,a,a.committedPersonId))a.people.push(a.committedPersonId);else for(const other of displaced)other.people.push(a.committedPersonId);
  }
  cleanupHosts(d);
  for(const a of slots){while(a.people.length+(a.externalAvailable?1:0)<a.required){const p=rank(a).find(p=>validCandidate(state,date,d,a,p.id));if(!p)break;a.people.push(p.id);}}
  // Preferred second table leaders only follow complete required coverage.
  if(!assignmentIssues(state,d.assignments,date).some(i=>i.severity==='coverage'))for(const a of slots.filter(a=>a.kind==='table'&&!a.classId&&a.people.length)){
    const first=state.people.find(p=>p.id===a.people[0]),period=state.periods.find(p=>p.start<=date&&p.end>=date)?.id,partner=first?.partners?.[period];
    if(a.people.length<a.preferred&&partner&&people.some(p=>p.id===partner)&&validCandidate(state,date,d,a,partner))a.people.push(partner);
  }
  return finish(state,date);
}
export function placePeople(state,date,{people,assignmentId,postId,seat=0,sourceId}={}) {
  const d=ensureDraft(state,date);
  if(!Array.isArray(people)||!people.length||people.length>100||new Set(people).size!==people.length)error('Select one or more distinct leaders.');
  const targets=d.assignments.filter(a=>assignmentId?a.id===assignmentId:a.postId===postId);
  if(!targets.length)error('Choose a destination slot.');
  for(const pid of people){
    const person=state.people.find(p=>p.id===pid);
    if(!person||!isEligible(person)||isOut(state,pid,date))error(`${person?.name||'This leader'} is unavailable for posts.`);
    let target;
    if(assignmentId){target=targets[0];if(people.length!==1)error('Place multiple leaders into a post type rather than a single seat.');if(!Number.isInteger(seat)||seat<0||seat>=target.preferred)error('Choose an available seat.');}
    else target=targets.filter(a=>(a.group==='any'||a.group===person.group)&&!a.people.includes(pid)&&a.people.length<a.preferred).sort((a,b)=>Number(a.people.length>=a.required)-Number(b.people.length>=b.required)).find(a=>!a.reuse||d.assignments.some(t=>t.programId===a.programId&&t.kind==='table'&&t.people.includes(pid)));
    if(!target)error(`No compatible open slot for ${person.name}. Add capacity or choose another post.`);
    if(target.group!=='any'&&target.group!==person.group)error(`${person.name} does not match this slot’s staffing group.`);
    const existing=target.people.indexOf(pid);if(existing>=0){if(assignmentId&&existing!==seat){[target.people[existing],target.people[seat]]=[target.people[seat],target.people[existing]];target.people=target.people.filter(Boolean);}continue;}
    const index=assignmentId?seat:target.people.length;
    if(index>target.people.length)error('Fill the first open seat before the next one.');
    const outgoing=target.people[index];
    const source=sourceId?d.assignments.find(a=>a.id===sourceId&&a.people.includes(pid)):!target.reuse?d.assignments.find(a=>a.id!==target.id&&!a.reuse&&a.phase===target.phase&&a.people.includes(pid)):null;
    if(source&&source.id!==target.id){source.people=source.people.filter(x=>x!==pid);if(outgoing&&!source.people.includes(outgoing))source.people.push(outgoing);}
    target.people[index]=pid;
  }
  return finish(state,date);
}
export function applyPlannerCommand(state,command) {
  const {date}=command,op=command.action.slice(8);
  state.presets ||= [];
  if(op==='savePreset'){
    const d=ensureDraft(state,date),name=String(command.name||'').trim();if(!name||name.length>120)error('Give the preset a name of at most 120 characters.');
    let preset=command.id?state.presets.find(p=>p.id===command.id):null;if(command.id&&!preset)error('Preset not found.');
    const value={id:preset?.id||id(),name,layout:clone(d.layout),active:true,updatedAt:new Date().toISOString(),assignments:command.includePeople?d.assignments.filter(a=>!a.classId&&a.people.length).map(a=>({slotKey:a.slotKey,people:[...a.people]})):[]};
    if(preset)Object.assign(preset,value);else state.presets.push(value);
    if(command.makeDefault)state.defaultPresetId=value.id;
    return;
  }
  if(op==='defaultPreset'){if(command.id&&!state.presets.some(p=>p.id===command.id&&p.active!==false))error('Preset not found.');state.defaultPresetId=command.id||'';return;}
  if(op==='archivePreset'){const p=state.presets.find(p=>p.id===command.id);if(!p)error('Preset not found.');p.active=false;if(state.defaultPresetId===p.id)state.defaultPresetId='';return;}
  if(op==='importPreset'){const p=command.preset;if(!p?.name?.trim())error('Choose a schedule-preset export.');const layout=validateLayout(clone(p.layout));state.presets.push({id:id(),name:p.name.slice(0,120),layout,active:true,assignments:[],updatedAt:new Date().toISOString()});return;}
  const existing=Boolean(state.schedules[date]?.draft),d=ensureDraft(state,date);
  if(op==='prepare'){
    if(!existing){for(const a of d.assignments)a.people=[];const preset=state.presets.find(p=>p.id===state.defaultPresetId&&p.active!==false);applyPresetPeople(state,date,d,preset);fillOpenSlots(state,date);}
    return;
  }
  if(op==='layout'){rebuildNight(state,date,command.layout);return;}
  if(op==='applyPreset'){
    const preset=command.id?state.presets.find(p=>p.id===command.id&&p.active!==false):null;if(command.id&&!preset)error('Preset not found.');
    rebuildNight(state,date,clone(preset?.layout||baselineLayout(state)),{keepPeople:command.keepPeople!==false});
    Object.assign(state.schedules[date].draft,{presetId:preset?.id||'',presetName:preset?.name||'Workspace baseline',structureCustomized:false});
    if(command.usePeople&&preset)applyPresetPeople(state,date,state.schedules[date].draft,preset);
    finish(state,date);return;
  }
  if(op==='fill'){fillOpenSlots(state,date);return;}
  if(op==='recheck'){for(const a of d.assignments){a.people=a.people.filter(pid=>state.people.some(p=>p.id===pid&&isEligible(p))&&!isOut(state,pid,date));if(a.classId){const table=state.classes.find(c=>c.id===a.classId)?.tables.find(t=>t.id===a.tableId);a.externalAvailable=Boolean(table&&externalPresent(table,date));}}finish(state,date,{allowInvalid:true});return;}
  if(op==='place'){placePeople(state,date,command);return;}
  if(op==='clear'){for(const a of d.assignments)if(!command.assignmentId||a.id===command.assignmentId)a.people=command.personId?a.people.filter(pid=>pid!==command.personId):[];finish(state,date);return;}
  if(op==='person'){
    const person=state.people.find(p=>p.id===command.personId);if(!person||!isEligible(person)||isOut(state,person.id,date))error('This leader is unavailable for posts.');
    if(!Array.isArray(command.assignments)||new Set(command.assignments).size!==command.assignments.length)error('Choose valid post slots.');
    if(command.assignments.some(id=>!d.assignments.some(a=>a.id===id)))error('One of these post slots no longer exists.');
    for(const a of d.assignments){if(!command.phase||a.phase===command.phase)a.people=a.people.filter(pid=>pid!==person.id);}
    for(const id of command.assignments){const a=d.assignments.find(a=>a.id===id);if(command.phase&&a.phase!==command.phase)error('Choose a slot in this phase.');if(!a.people.includes(person.id))a.people.push(person.id);}
    finish(state,date);return;
  }
  if(op==='slot'){
    const a=d.assignments.find(a=>a.id===command.assignmentId);if(!a)error('Slot not found.');
    if(command.reset){a.overrides={};rebuildNight(state,date,d.layout);return;}
    for(const k of ['label','location','instructions','notes','timeStart','timeEnd'])if(Object.hasOwn(command.fields||{},k)){
      const value=command.fields[k];if(typeof value!=='string'||value.length>(['instructions','notes'].includes(k)?4000:200))error('Use a shorter text value.');
      if(k==='label'&&!value.trim())error('Give the slot a name.');
      if(k.startsWith('time')&&value&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))error('Choose a valid time.');
      if(k.startsWith('time')&&!value){delete a.overrides[k];const post=d.layout.posts.find(p=>p.id===a.postId),phase=d.layout.phases.find(p=>p.id===a.phase);a[k]=post[k]||phaseTime(phase,{...state.settings,...d.layout.settings})[k]||'';}
      else{a.overrides[k]=value;a[k]=value;}
    }
    if(a.timeStart&&a.timeEnd&&a.timeStart>=a.timeEnd)error('The slot must end after it starts.');finish(state,date);return;
  }
  if(op==='restore'){
    const restore=clone(command.draft);if(restore?.date!==date||!Array.isArray(restore.assignments)||restore.assignments.length>500)error('This undo no longer matches the night.');
    validateLayout(restore.layout);
    for(const a of restore.assignments){if(!a.id||!restore.layout.posts.some(p=>p.id===a.postId)||!restore.layout.phases.some(p=>p.id===a.phase)||!['men','women','any'].includes(a.group)||!Array.isArray(a.people)||a.people.length>3||!Number.isInteger(a.required)||a.required<1||a.required>3||!Number.isInteger(a.preferred)||a.preferred<1||a.preferred>3)error('This undo contains an invalid slot.');}
    state.schedules[date].draft=restore;finish(state,date);return;
  }
  error('Unknown planner action.');
}
function applyPresetPeople(state,date,d,preset){
  d.presetWarnings=[];
  const committed=new Set(d.assignments.filter(a=>a.classId).map(a=>a.committedPersonId));
  for(const seed of preset?.assignments||[]){const a=d.assignments.find(a=>a.slotKey===seed.slotKey);if(!a)continue;for(const pid of seed.people){if(a.people.includes(pid))continue;if(!committed.has(pid)&&validCandidate(state,date,d,a,pid))a.people.push(pid);else d.presetWarnings.push(`${state.people.find(p=>p.id===pid)?.name||'An archived leader'} could not be placed from the preset. Review availability and class commitments.`);}}
}
