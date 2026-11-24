import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../core/seed.mjs';
import {generateDraft,servingDates,assignmentIssues,publishDraft,publicState,editAssignment,applyTick,validateState,sessionDates,markDraftsStale} from '../core/domain.mjs';
const day='2027-02-16';
const draft=(s,date=day)=>generateDraft(s,date);

test('season has 47 Tuesdays and three movable eight-week classes',()=>{
 const s=createSeed(),dates=servingDates(s);assert.equal(dates.length,47);assert.equal(dates[0],'2027-01-19');assert.equal(dates.at(-1),'2027-12-07');
 for(const c of s.classes){assert.equal(c.dates.length,8);assert.ok(c.dates.every(d=>dates.includes(d)));}
 s.classes[0].dates=sessionDates('2027-02-23');assert.equal(validateState(s),s);
});
test('team leads are excluded while subteam leads receive posts',()=>{
 const s=createSeed(),d=draft(s),assigned=d.assignments.flatMap(a=>a.people);
 assert.ok(s.people.filter(p=>p.role==='Team lead').every(p=>!assigned.includes(p.id)));
 assert.ok(s.people.filter(p=>p.role==='Subteam lead').every(p=>assigned.includes(p.id)));
 assert.deepEqual(assignmentIssues(s,d.assignments,day),[]);
});
test('Disciple commitments stay with their table for all eight sessions',()=>{
 const s=createSeed(),c=s.classes[0];
 for(const date of c.dates){const d=draft(s,date);for(const t of c.tables){const a=d.assignments.find(a=>a.tableId===t.id);assert.ok(a.people.includes(t.personId));assert.equal(a.externalName,t.externalName);}}
});
test('an absent TNS Disciple leader is covered by the confirmed external co-lead',()=>{
 const s=createSeed(),t=s.classes[0].tables[0];s.absences.push({id:'out',personId:t.personId,date:day,reason:'Away'});
 const a=draft(s).assignments.find(a=>a.tableId===t.id);assert.deepEqual(a.people,[]);assert.equal(a.externalAvailable,true);
 assert.equal(s.classes[0].tables[0].personId,t.personId);
});
test('if both co-leads are out, suggest one-night coverage without changing the class',()=>{
 const s=createSeed(),t=s.classes[0].tables[0],fixed=t.personId;t.externalOut=[day];s.absences.push({id:'out',personId:fixed,date:day,reason:'Away'});
 const a=draft(s).assignments.find(a=>a.tableId===t.id);assert.equal(a.people.length,1);assert.notEqual(a.people[0],fixed);assert.equal(a.note,'Suggested one-night substitute');assert.equal(t.personId,fixed);
});
test('Disciple fills before Next Steps when the team is short',()=>{
 const s=createSeed();for(const p of s.people)if(p.assignable&&!['sample-m1','sample-m2','sample-m3','sample-m4','sample-m5','sample-w1','sample-w2','sample-w3','sample-w4','sample-w5'].includes(p.id))p.active=false;
 const d=draft(s);assert.ok(d.assignments.filter(a=>a.classId).every(a=>a.people.length===1));assert.ok(d.assignments.filter(a=>a.programId==='next-steps'&&a.phase==='post').every(a=>a.people.length===0));assert.ok(d.issues.some(i=>i.severity==='coverage'));
});
test('Engine Room has 3 men and 3 women, can serve afterward, and avoids room prayer leads',()=>{
 const s=createSeed(),d=draft(s),engine=d.assignments.filter(a=>a.postId==='engine');assert.equal(engine.filter(a=>a.group==='men').length,3);assert.equal(engine.filter(a=>a.group==='women').length,3);
 const ids=engine.flatMap(a=>a.people);assert.ok(ids.every(pid=>d.assignments.some(a=>a.phase==='post'&&a.people.includes(pid))));
 for(const a of d.assignments.filter(a=>a.phase==='prep'))assert.ok(a.people.every(pid=>!ids.includes(pid)));
});
test('configured trimester pairs are used when required tables and hosts are covered',()=>{
 const s=createSeed(),d=draft(s,'2027-01-19'),tables=d.assignments.filter(a=>a.postId==='next-table');
 assert.equal(tables.length,10);assert.ok(tables.every(a=>a.people.length===2));
 for(const a of tables)assert.equal(s.people.find(p=>p.id===a.people[0]).partners.spring,a.people[1]);
 assert.equal(d.assignments.filter(a=>a.postId==='next-host'&&a.people.length===1).length,4);
});
test('drafts are private until publish, and absent names/reasons never leak publicly',()=>{
 const s=createSeed(),date='2027-02-23';s.schedules[date]={date,draft:draft(s,date)};assert.equal(publicState(s).schedules[date],undefined);
 publishDraft(s,date);const a=s.schedules[date].published.assignments.find(a=>a.postId==='next-table');const pid=a.people[0];s.absences.push({id:'out',personId:pid,date,reason:'PRIVATE-REASON'});markDraftsStale(s);
 const view=publicState(s);assert.ok(view.schedules[date].assignments.every(a=>!a.people.includes(pid)&&a.personNames.every(p=>p.id!==pid)));assert.ok(!JSON.stringify(view).includes('PRIVATE-REASON'));assert.equal(view.absences,undefined);
});
test('publishing enforces gaps, stale drafts, and overlapping assignments',()=>{
 const s=createSeed(),date='2027-02-23';s.schedules[date]={date,draft:draft(s,date)};
 const a=s.schedules[date].draft.assignments.find(a=>a.postId==='next-table');a.people=[];
 assert.throws(()=>publishDraft(s,date),/coverage gaps/);publishDraft(s,date,true);
 s.schedules[date].draft.stale=true;assert.throws(()=>publishDraft(s,date,true),/Refresh/);
});
test('manual swap updates both one-night assignments without changing pairings',()=>{
 const s=createSeed(),date='2027-01-19';const d=s.schedules[date].draft;
 const rows=d.assignments.filter(a=>a.postId==='next-table'&&a.group==='men');const [a,b]=rows,oldA=[...a.people],oldB=[...b.people];
 editAssignment(s,date,a.id,[oldB[0],oldA[1]],true);assert.ok(a.people.includes(oldB[0]));assert.ok(b.people.includes(oldA[0]));assert.deepEqual(assignmentIssues(s,d.assignments,date),[]);
});
test('invalid manual assignment rolls back instead of leaving a partial edit',()=>{
 const s=createSeed(),a=s.schedules[day].draft.assignments.find(a=>a.postId==='next-table');const before=JSON.stringify(s.schedules[day].draft.assignments);
 assert.throws(()=>editAssignment(s,day,a.id,['sample-m0']),/unavailable/);assert.equal(JSON.stringify(s.schedules[day].draft.assignments),before);
});
test('published names and program labels remain stable after roster renames',()=>{
 const s=createSeed(),name=s.schedules[day].published.assignments[0].personNames[0].name;s.people.find(p=>p.id===s.schedules[day].published.assignments[0].people[0]).name='New name';s.programs[0].name='Renamed';
 const a=publicState(s).schedules[day].assignments[0];assert.equal(a.personNames[0].name,name);assert.equal(a.programName,'Disciple');
});
test('Tuesday draft generation respects Chicago time and is idempotent; never auto-publishes',()=>{
 const s=createSeed(),date='2027-02-23';assert.equal(applyTick(s,new Date(`${date}T12:59:00Z`)),false);assert.equal(applyTick(s,new Date(`${date}T13:00:00Z`)),true);assert.equal(s.schedules[date].draft.status,'Ready for review');assert.equal(s.schedules[date].published,undefined);assert.equal(applyTick(s,new Date(`${date}T14:00:00Z`)),false);
 const summer='2027-06-15';assert.equal(applyTick(s,new Date(`${summer}T11:59:00Z`)),false);assert.equal(applyTick(s,new Date(`${summer}T12:00:00Z`)),true);
});
test('backup validation rejects impossible dates, overlapping classes, and unsafe links',()=>{
 let s=createSeed();s.settings.seasonStart='2027-02-30';assert.throws(()=>validateState(s));s=createSeed();s.classes[1].dates=s.classes[0].dates;assert.throws(()=>validateState(s),/overlapping/);s=createSeed();s.resources[0].url='javascript:alert(1)';assert.throws(()=>validateState(s),/https/);
});
