const copy = value => structuredClone(value);
export const NIGHT_SETTINGS = ['teamStart','teamEnd','nightEnd','teamRoom','allLeaderRoom','allLeaderFirstTuesday'];
export function baselineLayout(state) {
  return {settings:Object.fromEntries(NIGHT_SETTINGS.map(k=>[k,state.settings[k]])),phases:copy(state.phases),programs:copy(state.programs),posts:copy(state.posts)};
}
export function defaultLayout(state) {
  return copy(state.presets?.find(p=>p.id===state.defaultPresetId&&p.active!==false)?.layout || baselineLayout(state));
}
export function withLayout(state,layout) {
  return layout?{...state,settings:{...state.settings,...layout.settings},phases:layout.phases,programs:layout.programs,posts:layout.posts}:state;
}
export function draftLayout(state,date) { return state.schedules[date]?.draft?.layout || defaultLayout(state); }
export const slotKey = a => a.classId?`${a.postId}:${a.classId}:${a.tableId}`:a.slotKey;
export function phaseTime(phase,settings) {
  return {timeStart:phase?.timeStart || (phase?.id==='gather'?settings.teamStart:''),timeEnd:phase?.timeEnd || (phase?.id==='gather'?settings.teamEnd:'')};
}
export function validateLayout(layout) {
  if(!layout||typeof layout!=='object')throw new Error('Choose a valid night structure.');
  for(const key of ['phases','programs','posts']) {
    if(!Array.isArray(layout[key])||layout[key].length>(key==='posts'?60:30))throw new Error(`Use at most ${key==='posts'?60:30} ${key}.`);
    const ids=layout[key].map(p=>p.id);
    if(ids.some(x=>typeof x!=='string'||!x||x.length>120)||new Set(ids).size!==ids.length)throw new Error(`Each ${key} item needs a unique ID.`);
  }
  if(!layout.phases.length)throw new Error('Keep at least one phase in the night.');
  const text=(value,max=1000)=>typeof value==='string'&&value.length<=max;
  const times=item=>{for(const k of ['timeStart','timeEnd'])if(item[k]&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(item[k]))throw new Error('Use a valid time or leave it blank to follow the cue.');if(item.timeStart&&item.timeEnd&&item.timeStart>=item.timeEnd)throw new Error('End times must follow start times within the same evening.');};
  for(const p of layout.phases){if(!text(p.name,100)||!p.name.trim()||!text(p.label||'',150)||!text(p.cue||'',2000))throw new Error('Each phase needs a name and valid timing description.');times(p);}
  for(const p of layout.programs)if(!text(p.name,100)||!p.name.trim()||!['weekly','cohort'].includes(p.mode)||!Number.isFinite(+p.priority)||!text(p.location||'',200))throw new Error('Check program names, rooms, and allocation patterns.');
  for(const p of layout.posts){
    if(!text(p.label,120)||!p.label.trim()||!layout.phases.some(x=>x.id===p.phase)||(p.programId&&!layout.programs.some(x=>x.id===p.programId))||!['table','host','prayer','service'].includes(p.kind)||!text(p.location||'',200)||!text(p.instructions||'',4000))throw new Error('Check each post’s name, phase, program, room, and instructions.');
    for(const group of ['men','women','any'])if(!Number.isInteger(+p.counts?.[group])||+p.counts[group]<0||+p.counts[group]>30)throw new Error('Use 0–30 slots for each staffing group.');
    p.counts=Object.fromEntries(['men','women','any'].map(group=>[group,+p.counts[group]]));
    if(!Number.isInteger(+p.preferred)||+p.preferred<1||+p.preferred>3)throw new Error('Use 1–3 people per slot.');
    if(p.reuse&&(p.kind!=='host'||!p.programId))throw new Error('Only hosts inside a program can share their table assignment.');
    times(p);
  }
  if(layout.posts.filter(p=>p.active!==false).reduce((n,p)=>n+Object.values(p.counts).reduce((a,b)=>a+(+b),0),0)>300)throw new Error('Keep a single night to at most 300 configured positions.');
  layout.settings ||= {};
  layout.settings=Object.fromEntries(NIGHT_SETTINGS.filter(k=>Object.hasOwn(layout.settings,k)).map(k=>[k,layout.settings[k]]));
  for(const key of ['teamStart','teamEnd','nightEnd'])if(layout.settings[key]&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(layout.settings[key]))throw new Error('Check the night’s gathering and end times.');
  for(const key of ['teamRoom','allLeaderRoom'])if(layout.settings[key]&&!text(layout.settings[key],200))throw new Error('Use a room name of at most 200 characters.');
  const fields={phases:['id','name','label','cue','timeStart','timeEnd','order'],programs:['id','name','mode','location','priority','active','description'],posts:['id','programId','label','kind','phase','location','counts','preferred','reuse','order','active','instructions','start','end','timeStart','timeEnd']};
  for(const key of Object.keys(fields))layout[key]=layout[key].map(record=>Object.fromEntries(fields[key].filter(k=>Object.hasOwn(record,k)).map(k=>[k,record[k]])));
  for(const key of Object.keys(layout))if(!['settings','phases','programs','posts'].includes(key))delete layout[key];
  return layout;
}
