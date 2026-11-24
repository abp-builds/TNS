export const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets INTEGER NOT NULL);
`;

export class Store {
  constructor(adapter, seed) { this.db = adapter; this.seed = seed; }
  async initialize() {
    await this.db.exec(SCHEMA);
    if (!(await this.db.first('SELECT id FROM workspace WHERE id=1', []))) await this.db.run('INSERT OR IGNORE INTO workspace(id,version,data) VALUES(1,1,?)', [JSON.stringify(this.seed())]);
  }
  async load() {
    const row = await this.db.first('SELECT version,data FROM workspace WHERE id=1', []);
    return { state: JSON.parse(row.data), version: row.version };
  }
  async save(state, version) {
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
    run: async (sql,args) => { const result = await db.prepare(sql).bind(...args).run(); return { changes: result.meta.changes }; }
  };
}
