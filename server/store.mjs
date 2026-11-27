export const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
`;

export class Store {
  constructor(adapter, seed) { this.db = adapter; this.seed = seed; }
  async initialize() {
    await this.db.exec(SCHEMA);
    if (!(await this.db.first('SELECT id FROM workspace WHERE id=1', []))) await this.db.run('INSERT OR IGNORE INTO workspace(id,version,data) VALUES(1,1,?)', [JSON.stringify(this.seed())]);
  }
  async load() {
    let row=await this.db.first('SELECT version,data FROM workspace WHERE id=1', []),data=JSON.parse(row.data),nights;
    if(data.storageFormat===2){
      if(!this.db.batch)throw new Error('This workspace needs the current storage adapter.');
      const result=await this.db.batch([{sql:'SELECT version,data FROM workspace WHERE id=1',args:[]},{sql:'SELECT kind,id,data FROM workspace_records ORDER BY rowid',args:[]}]);
      row=result[0].rows[0];data=JSON.parse(row.data);nights=result[1].rows;
    }
    const state=data.storageFormat===2?{...data.workspace,schedules:Object.fromEntries(nights.filter(n=>n.kind==='night').map(n=>[n.id,JSON.parse(n.data)])),presets:nights.filter(n=>n.kind==='preset').map(n=>JSON.parse(n.data))}:data;
    this.loaded={version:row.version,records:new Map([...Object.entries(state.schedules).map(([id,value])=>[`night:${id}`,JSON.stringify(value)]),...(state.presets||[]).map(value=>[`preset:${value.id}`,JSON.stringify(value)])]),legacy:data.storageFormat!==2};
    return {state,version:row.version};
  }
  async save(state, version) {
    if(this.db.batch){
      if(this.loaded?.version!==version){const loaded=await this.load();if(loaded.version!==version)return false;}
      const token=crypto.randomUUID(),{schedules,presets=[],...workspace}=state;
      const envelope=JSON.stringify({storageFormat:2,writeToken:token,workspace});
      if(new TextEncoder().encode(envelope).length>1500000)throw new Error('Archive unused presets before saving more workspace configuration.');
      const commands=[{sql:'UPDATE workspace SET data=?,version=version+1 WHERE id=1 AND version=?',args:[envelope,version]}];
      const guard="EXISTS(SELECT id FROM workspace WHERE id=1 AND json_extract(data,'$.writeToken')=?)";
      const records=[...Object.entries(schedules).map(([id,value])=>({kind:'night',id,data:JSON.stringify(value)})),...presets.map(value=>({kind:'preset',id:value.id,data:JSON.stringify(value)}))];
      const keys=new Set(records.map(r=>`${r.kind}:${r.id}`));const removed=[...this.loaded.records.keys()].filter(key=>!keys.has(key));
      if(this.loaded.legacy)commands.push({sql:`DELETE FROM workspace_records WHERE ${guard}`,args:[token]});
      else if(removed.length)commands.push({sql:`DELETE FROM workspace_records WHERE (kind||':'||id) IN (SELECT value FROM json_each(?)) AND ${guard}`,args:[JSON.stringify(removed),token]});
      let chunk=[],size=0;
      const flush=()=>{if(!chunk.length)return;commands.push({sql:`INSERT INTO workspace_records(kind,id,data) SELECT json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.data') FROM json_each(?) WHERE ${guard} ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`,args:[JSON.stringify(chunk),token]});chunk=[];size=0;};
      for(const record of records){
        if(!this.loaded.legacy&&this.loaded.records.get(`${record.kind}:${record.id}`)===record.data)continue;
        const bytes=new TextEncoder().encode(JSON.stringify(record)).length;
        if(bytes>1500000)throw new Error('This night is too large. Reduce its slots or note lengths.');
        if(size+bytes>500000)flush();chunk.push(record);size+=bytes;
      }
      flush();const result=await this.db.batch(commands);return result[0].changes===1;
    }
    const result = await this.db.run('UPDATE workspace SET data=?,version=version+1 WHERE id=1 AND version=?', [JSON.stringify(state),version]);
    return result.changes === 1;
  }
  async meta(key) { const row = await this.db.first('SELECT value FROM metadata WHERE key=?', [key]); return row ? JSON.parse(row.value) : null; }
  async setMeta(key, value) { await this.db.run('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key,JSON.stringify(value)]); }
  async createSession(digest, expires) { await this.db.run('DELETE FROM sessions WHERE expires<?', [Date.now()]); await this.db.run('INSERT INTO sessions(digest,expires) VALUES(?,?)', [digest,expires]); }
  async session(digest) { return this.db.first('SELECT digest FROM sessions WHERE digest=? AND expires>?', [digest,Date.now()]); }
  async revoke(digest) { await this.db.run('DELETE FROM sessions WHERE digest=?', [digest]); }
  async revokeAll() { await this.db.run('DELETE FROM sessions', []); }
  async limit(key, maximum, windowMs) {
    const now = Date.now();
    await this.db.run('DELETE FROM rate_limits WHERE resets<?', [now]);
    await this.db.run('INSERT INTO rate_limits(key,count,resets) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', [key,now+windowMs]);
    return (await this.db.first('SELECT count FROM rate_limits WHERE key=?',[key])).count <= maximum;
  }
}

export function d1Adapter(db) {
  return {
    exec: sql => db.exec(sql),
    first: (sql,args) => db.prepare(sql).bind(...args).first(),
    run: async (sql,args) => { const result = await db.prepare(sql).bind(...args).run(); return { changes: result.meta.changes }; },
    batch: async commands=>(await db.batch(commands.map(({sql,args})=>db.prepare(sql).bind(...args)))).map(result=>({rows:result.results||[],changes:result.meta.changes||0}))
  };
}

export function sqliteAdapter(db){
  return {
    exec:async sql=>db.exec(sql),first:async(sql,args)=>db.prepare(sql).get(...args),run:async(sql,args)=>db.prepare(sql).run(...args),
    batch:async commands=>{db.exec('BEGIN');try{const results=commands.map(({sql,args})=>/^SELECT\b/i.test(sql)?{rows:db.prepare(sql).all(...args),changes:0}:{rows:[],changes:db.prepare(sql).run(...args).changes});db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}
  };
}
