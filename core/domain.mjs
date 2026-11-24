export const id = () => crypto.randomUUID();
export const clone = value => structuredClone(value);
export const iso = date => new Date(date).toISOString().slice(0, 10);
export const addDays = (date, days) => iso(new Date(`${date}T12:00:00Z`).getTime() + days * 86400000);
export const sessionDates = (start, count = 8) => Array.from({ length: count }, (_, i) => addDays(start, i * 7));
export function localParts(now = new Date(), timezone = 'America/Chicago') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour, minute: +parts.minute };
}
export function servingDates(state) {
  const dates = new Set();
  for (let date = state.settings.seasonStart; date <= state.settings.seasonEnd; date = addDays(date, 1)) {
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === +state.settings.servingDay && !state.settings.breakDates.includes(date)) dates.add(date);
  }
  for (const event of state.events) if (event.serviceNight) dates.add(event.date);
  for (const cohort of state.classes.filter(c => c.active !== false && state.programs.some(p => p.id === c.programId && p.active))) for (const date of cohort.dates) dates.add(date);
  return [...dates].sort();
}
export const isOut = (state, personId, date) => state.absences.some(a => a.personId === personId && a.date === date);
export const isEligible = person => person.active && person.assignable && person.role !== 'Team lead';
export const periodFor = (state, date) => state.periods.find(p => p.start <= date && p.end >= date)?.id;
export const activeClasses = (state, date) => state.classes.filter(c => c.active !== false && c.dates.includes(date));
export function activePrograms(state, date) {
  return state.programs.filter(p => p.active && (p.mode !== 'cohort' || activeClasses(state, date).some(c => c.programId === p.id))).sort((a, b) => a.priority - b.priority);
}
export function externalPresent(table, date) {
  return Boolean(table.externalName?.trim() && table.externalConfirmed && !(table.externalOut || []).includes(date));
}
function historyCount(state, personId, postId, date) {
  return Object.values(state.schedules).filter(s => s.date < date && s.published).reduce((n, s) => n + s.published.assignments.filter(a => a.postId === postId && a.people.includes(personId)).length, 0);
}
export function assignmentIssues(state, assignments, date) {
  const issues = [];
  const people = new Map(state.people.map(p => [p.id, p]));
  for (const a of assignments) {
    const table = a.classId ? state.classes.find(c => c.id === a.classId)?.tables.find(t => t.id === a.tableId) : null;
    const external = table ? externalPresent(table, date) : false;
    const available = a.people.filter(pid => people.has(pid) && isEligible(people.get(pid)) && !isOut(state, pid, date));
    if (available.length + (external ? 1 : 0) < a.required) issues.push({ assignmentId: a.id, label: a.label, programId: a.programId, message: 'Needs coverage', severity: 'coverage' });
    for (const pid of a.people) {
      const person = people.get(pid);
      if (!person || !isEligible(person) || isOut(state, pid, date)) issues.push({ assignmentId: a.id, label: a.label, message: `${person?.name || 'Leader'} is unavailable`, severity: 'invalid' });
      else if (a.group !== 'any' && person.group !== a.group) issues.push({ assignmentId: a.id, label: a.label, message: 'Leader does not match this table or post group', severity: 'invalid' });
    }
    if (new Set(a.people).size !== a.people.length) issues.push({ assignmentId: a.id, label: a.label, message: 'The same leader appears twice in one post', severity: 'invalid' });
  }
  const occupied = new Map();
  for (const a of assignments.filter(a => a.reuse)) for (const pid of a.people) {
    if (!assignments.some(other => other.id !== a.id && other.programId === a.programId && other.people.includes(pid) && state.posts.some(post => post.id === other.postId && post.kind === 'table'))) issues.push({ assignmentId:a.id, label:a.label, message:'This host must also lead a table in the same program', severity:'invalid' });
  }
  for (const a of assignments.filter(a => !a.reuse)) for (const pid of a.people) {
    const key = `${pid}:${a.phase}`;
    if (occupied.has(key)) issues.push({ assignmentId: a.id, label: a.label, message: `${people.get(pid)?.name || 'Leader'} has overlapping posts`, severity: 'invalid' });
    occupied.set(key, a.id);
  }
  return issues;
}

export function generateDraft(state, date, now = new Date()) {
  if (!servingDates(state).includes(date)) throw new Error('Choose a serving date on the calendar.');
  const eligible = state.people.filter(p => isEligible(p) && !isOut(state, p.id, date));
  const assignments = [];
  const used = new Map();
  const available = (p, phase) => !used.get(phase)?.has(p.id);
  const take = (p, phase) => { if (!used.has(phase)) used.set(phase, new Set()); used.get(phase).add(p.id); };
  const reservedPartner = person => assignments.some(a => !a.classId && a.preferred > 1 && a.people.length === 1 && state.people.find(p => p.id === a.people[0])?.partners?.[periodFor(state,date)] === person.id);
  const rank = (postId, phase, group, pool = eligible) => pool.filter(p => available(p, phase) && (group === 'any' || p.group === group)).sort((a, b) => Number(reservedPartner(a)) - Number(reservedPartner(b)) || historyCount(state, a.id, postId, date) - historyCount(state, b.id, postId, date) || a.name.localeCompare(b.name));
  const make = (post, label, group, more = {}) => ({ id: id(), postId: post.id, programId: post.programId || '', label, phase: post.phase, location: post.location, group, required: 1, preferred: post.preferred || 1, people: [], reuse: Boolean(post.reuse), ...more });
  const programs = activePrograms(state, date);
  for (const program of programs) {
    const posts = state.posts.filter(p => p.active && p.programId === program.id && (!p.start || p.start <= date) && (!p.end || p.end >= date)).sort((a, b) => a.order - b.order);
    for (const post of posts.filter(p => p.kind === 'table')) {
      const cohorts = activeClasses(state, date).filter(c => c.programId === program.id);
      if (program.mode === 'cohort') {
        const fixed = [];
        // Reserve all present committed leaders before suggesting substitutes.
        for (const cohort of cohorts) for (const table of cohort.tables) {
          const a = make(post, table.label, table.group, { classId: cohort.id, tableId: table.id, preferred: 2, externalName: table.externalName || '', externalTeam: table.externalTeam || '', externalAvailable: externalPresent(table, date), externalConfirmed: Boolean(table.externalConfirmed), committedPersonId: table.personId || '', note: '' });
          const person = eligible.find(p => p.id === table.personId && p.group === table.group);
          if (person && available(person, post.phase)) { a.people.push(person.id); take(person, post.phase); }
          else if (table.personId) a.note = 'Committed leader unavailable';
          assignments.push(a); fixed.push(a);
        }
        for (const a of fixed) if (!a.people.length && !a.externalAvailable) {
          const substitute = rank(post.id, post.phase, a.group)[0];
          if (substitute) { a.people.push(substitute.id); take(substitute, post.phase); a.note = 'Suggested one-night substitute'; }
        }
      } else {
        for (const group of ['men', 'women', 'any']) for (let i = 0; i < (+post.counts[group] || 0); i++) {
          const a = make(post, `${group === 'any' ? 'Table' : group === 'men' ? 'Men’s table' : 'Women’s table'} ${i + 1}`, group);
          const person = rank(post.id, post.phase, group)[0];
          if (person) { a.people.push(person.id); take(person, post.phase); }
          assignments.push(a);
        }
      }
    }
    for (const post of posts.filter(p => !['table', 'prayer'].includes(p.kind))) {
      for (const group of ['men', 'women', 'any']) for (let i = 0; i < (+post.counts[group] || 0); i++) {
        const pool = post.reuse ? eligible.filter(p => assignments.some(a => a.programId === program.id && a.classId && a.people.includes(p.id))) : eligible;
        const already = new Set(assignments.filter(a => a.postId === post.id).flatMap(a => a.people));
        const person = pool.filter(p => !already.has(p.id) && (post.reuse || available(p, post.phase)) && (group === 'any' || p.group === group)).sort((a, b) => Number(reservedPartner(a)) - Number(reservedPartner(b)) || historyCount(state, a.id, post.id, date) - historyCount(state, b.id, post.id, date) || a.name.localeCompare(b.name))[0];
        const a = make(post, `${post.label}${(+post.counts[group] || 0) > 1 ? ` ${i + 1}` : ''}`, group);
        if (person) { a.people.push(person.id); if (!post.reuse) take(person, post.phase); }
        assignments.push(a);
      }
    }
  }
  // Preferred second leaders come after required program coverage and host/care slots.
  for (const a of assignments.filter(a => !a.classId && a.preferred > 1 && a.people.length)) {
    const first = state.people.find(p => p.id === a.people[0]);
    const partnerId = first?.partners?.[periodFor(state, date)];
    const partner = eligible.find(p => p.id === partnerId && p.group === a.group && available(p, a.phase));
    if (partner) { a.people.push(partner.id); take(partner, a.phase); }
  }
  for (const post of state.posts.filter(p => p.active && !p.programId && (!p.start || p.start <= date) && (!p.end || p.end >= date)).sort((a, b) => a.order - b.order)) {
    for (const group of ['men', 'women', 'any']) for (let i = 0; i < (+post.counts[group] || 0); i++) {
      const person = rank(post.id, post.phase, group)[0];
      const a = make(post, `${post.label} ${i + 1}`, group);
      if (person) { a.people.push(person.id); take(person, post.phase); }
      assignments.push(a);
    }
  }
  for (const program of programs) for (const post of state.posts.filter(p => p.active && p.programId === program.id && p.kind === 'prayer' && (!p.start || p.start <= date) && (!p.end || p.end >= date))) {
    const programPeople = eligible.filter(p => assignments.some(a => a.programId === program.id && a.people.includes(p.id)));
    const person = programPeople.sort((a, b) => Number(used.get('service')?.has(a.id) || false) - Number(used.get('service')?.has(b.id) || false) || historyCount(state, a.id, post.id, date) - historyCount(state, b.id, post.id, date) || a.name.localeCompare(b.name))[0];
    const a = make(post, post.label, 'any');
    if (person) a.people.push(person.id);
    assignments.push(a);
  }
  return { date, status: 'Ready for review', generatedAt: now.toISOString(), assignments, issues: assignmentIssues(state, assignments, date), stale: false };
}

export function markDraftsStale(state) {
  for (const schedule of Object.values(state.schedules)) if (schedule.draft) {
    schedule.draft.stale = true;
    schedule.draft.issues = assignmentIssues(state,schedule.draft.assignments,schedule.date);
  }
}
export function publicState(state) {
  const programs = state.programs.map(p => ({ ...p }));
  const schedules = {};
  for (const [date, schedule] of Object.entries(state.schedules)) if (schedule.published) {
    const published = clone(schedule.published);
    published.assignments = published.assignments.map(a => {
      const people = a.people.filter(pid => !isOut(state, pid, date));
      const table = a.classId ? state.classes.find(c => c.id === a.classId)?.tables.find(t => t.id === a.tableId) : null;
      const externalAvailable = table ? externalPresent(table, date) : Boolean(a.externalAvailable);
      return { ...a, people, externalAvailable, personNames: (a.personNames || []).filter(p => people.includes(p.id)), needsCoverage: people.length + (externalAvailable ? 1 : 0) < a.required };
    });
    published.needsReview = published.assignments.some(a => a.needsCoverage);
    schedules[date] = published;
  }
  return {
    settings: { ...state.settings }, isSample: state.isSample,
    people: state.people.filter(p => p.active).map(({ id, name, group, team, role }) => ({ id, name, group, team, role })),
    programs, phases: state.phases, posts: state.posts.filter(p => p.active),
    classes: state.classes.filter(c => c.active !== false && state.programs.some(p => p.id === c.programId && p.active)).map(({ id, name, programId, dates, provisional }) => ({ id, name, programId, dates, provisional })),
    events: state.events, resources: state.resources.filter(r => r.published), updates: state.updates.filter(u => u.published),
    unavailable: state.absences.map(({ personId, date }) => ({ personId, date })), schedules,
    servingDates: servingDates(state)
  };
}
export function publishDraft(state, date, acknowledgeShortages = false, now = new Date()) {
  const schedule = state.schedules[date];
  if (!schedule?.draft) throw new Error('Generate a draft before publishing.');
  if (schedule.draft.stale) throw new Error('The roster, calendar, or availability changed. Refresh the draft before publishing.');
  const issues = assignmentIssues(state, schedule.draft.assignments, date);
  if (issues.some(i => i.severity === 'invalid')) throw new Error(issues.find(i => i.severity === 'invalid').message);
  if (issues.length && !acknowledgeShortages) throw new Error('Review the uncovered posts and confirm publishing with coverage gaps.');
  const snapshot = clone(schedule.draft);
  snapshot.status = 'Published'; snapshot.publishedAt = now.toISOString(); snapshot.issues = issues;
  snapshot.assignments = snapshot.assignments.map(a => ({ ...a, personNames: a.people.map(pid => ({ id: pid, name: state.people.find(p => p.id === pid)?.name || 'Archived leader' })), programName: state.programs.find(p => p.id === a.programId)?.name || '', phaseLabel: state.phases.find(p => p.id === a.phase)?.label || a.phase }));
  schedule.published = snapshot;
  return snapshot;
}
export function editAssignment(state, date, assignmentId, personIds, swap = false) {
  const draft = state.schedules[date]?.draft;
  if (!draft) throw new Error('Generate a draft first.');
  const assignment = draft.assignments.find(a => a.id === assignmentId);
  if (!assignment) throw new Error('Post not found.');
  const before = clone(draft.assignments);
  const oldPeople = [...assignment.people];
  assignment.people = personIds.filter(Boolean);
  if (swap && !assignment.reuse) for (let i = 0; i < assignment.people.length; i++) {
    const incoming = assignment.people[i];
    if (oldPeople.includes(incoming)) continue;
    const other = draft.assignments.find(a => a.id !== assignment.id && !a.reuse && a.phase === assignment.phase && a.people.includes(incoming));
    if (other) {
      const outgoing = oldPeople[i];
      other.people = other.people.filter(pid => pid !== incoming);
      if (outgoing && !assignment.people.includes(outgoing)) other.people.push(outgoing);
      other.note = 'Swapped for this night';
    }
  }
  const invalid = assignmentIssues(state, draft.assignments, date).find(i => i.severity === 'invalid');
  if (invalid) { draft.assignments = before; throw new Error(invalid.message); }
  assignment.note = 'Edited for this night';
  draft.issues = assignmentIssues(state, draft.assignments, date);
}
export function shouldGenerate(state, now = new Date()) {
  const local = localParts(now, state.settings.timezone);
  const hour = +state.settings.reviewTime.split(':')[0], minute = +state.settings.reviewTime.split(':')[1];
  return servingDates(state).includes(local.date) && (local.hour * 60 + local.minute >= hour * 60 + minute) && !state.schedules[local.date]?.draft;
}
export function applyTick(state, now = new Date()) {
  if (!shouldGenerate(state, now)) return false;
  const date = localParts(now, state.settings.timezone).date;
  state.schedules[date] = { ...state.schedules[date], date, draft: generateDraft(state, date, now) };
  return true;
}
export function safeUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a full https:// link.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use an https:// link.');
  return url.href;
}
export function validateState(state) {
  if (!state || state.schemaVersion !== 1) throw new Error('This is not a supported TNS workspace backup.');
  for (const key of ['people','programs','posts','phases','classes','events','resources','updates','absences','periods']) {
    if (!Array.isArray(state[key]) || state[key].length > 5000) throw new Error(`Invalid ${key}.`);
    const ids = state[key].map(x => x.id);
    if (ids.some(x => typeof x !== 'string' || !x) || new Set(ids).size !== ids.length) throw new Error(`Each ${key} record must have a unique ID.`);
  }
  if (!state.schedules || typeof state.schedules !== 'object' || Array.isArray(state.schedules)) throw new Error('Invalid schedules.');
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && iso(`${value}T12:00:00Z`) === value;
  const settings = state.settings;
  if (!settings || !settings.teamName?.trim() || !validDate(settings.seasonStart) || !validDate(settings.seasonEnd) || settings.seasonStart > settings.seasonEnd || settings.seasonEnd > addDays(settings.seasonStart, 730)) throw new Error('Choose a valid season of at most two years.');
  if (!Number.isInteger(+settings.servingDay) || +settings.servingDay < 0 || +settings.servingDay > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.reviewTime)) throw new Error('Check the serving weekday and draft time.');
  new Intl.DateTimeFormat('en', { timeZone: settings.timezone });
  if (!Array.isArray(settings.breakDates) || settings.breakDates.some(d => !validDate(d))) throw new Error('Break dates must be valid YYYY-MM-DD dates.');
  if (settings.logoUrl) safeUrl(settings.logoUrl);
  if (settings.groupMeUrl) safeUrl(settings.groupMeUrl);
  for (const program of state.programs) if (!program.name?.trim() || !['weekly','cohort'].includes(program.mode) || !Number.isFinite(+program.priority)) throw new Error('Each program needs a name, assignment pattern, and priority.');
  for (const period of state.periods) if (!period.name?.trim() || !validDate(period.start) || !validDate(period.end) || period.start > period.end) throw new Error('Each trimester needs valid dates.');
  for (const person of state.people) {
    if (!person.name?.trim() || person.name.length > 100 || !['men','women','unassigned'].includes(person.group)) throw new Error('Each leader needs a name and a valid staffing group.');
    if (person.partners && typeof person.partners !== 'object') throw new Error('Invalid partner configuration.');
  }
  const personIds = new Set(state.people.map(p => p.id)), programIds = new Set(state.programs.map(p => p.id)), postIds = new Set(state.posts.map(p => p.id));
  for (const post of state.posts) {
    if (!post.label?.trim() || !state.phases.some(p => p.id === post.phase) || (post.programId && !programIds.has(post.programId))) throw new Error('Each post needs a label, a valid phase, and a valid program.');
    for (const group of ['men','women','any']) if (!Number.isInteger(+post.counts[group]) || +post.counts[group] < 0 || +post.counts[group] > 30) throw new Error('Staffing counts must be whole numbers from 0 to 30.');
  }
  for (const cohort of state.classes) {
    if (!programIds.has(cohort.programId) || !cohort.name?.trim() || !Array.isArray(cohort.dates) || !cohort.dates.length || cohort.dates.length > 52 || new Set(cohort.dates).size !== cohort.dates.length || cohort.dates.some(x => !validDate(x))) throw new Error('Check the class name, program, and session dates.');
    const assigned = new Set();
    for (const table of cohort.tables) {
      if (table.personId && (!personIds.has(table.personId) || assigned.has(table.personId))) throw new Error('A class table leader must exist and can lead only one table in that class.');
      if (table.personId) { const person = state.people.find(p => p.id === table.personId); if (person.group !== table.group || person.role === 'Team lead') throw new Error('Choose a matching table leader who is eligible for posts.'); }
      if (!Array.isArray(table.externalOut) || table.externalOut.some(d => !cohort.dates.includes(d))) throw new Error('External co-lead absences must match class session dates.');
      if (table.personId) assigned.add(table.personId);
    }
  }
  for (let i = 0; i < state.classes.length; i++) for (let j = i + 1; j < state.classes.length; j++) if (state.classes[i].programId === state.classes[j].programId && state.classes[i].dates.some(x => state.classes[j].dates.includes(x))) throw new Error('Classes in the same program cannot have overlapping sessions.');
  for (const absence of state.absences) if (!personIds.has(absence.personId) || !absence.reason?.trim()) throw new Error('Each absence needs a roster name and a reason.');
  for (const item of [...state.resources, ...state.events]) { if (!item.title?.trim()) throw new Error('Resources and events need a title.'); if (item.url) safeUrl(item.url); }
  for (const event of state.events) if (!validDate(event.date)) throw new Error('Choose a valid event date.');
  for (const update of state.updates) if (!update.title?.trim() || !update.body?.trim() || !validDate(update.date)) throw new Error('Updates need a title, message, and valid date.');
  for (const [date, schedule] of Object.entries(state.schedules)) {
    if (date !== schedule.date) throw new Error('Invalid schedule date.');
    if (schedule.draft?.assignments.some(a => !postIds.has(a.postId))) throw new Error('An active draft references an unknown post. Archive posts instead of removing them.');
  }
  return state;
}
