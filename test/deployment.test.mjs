import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {backendOrigin} from '../scripts/deployment-config.mjs';
import {SCHEMA} from '../server/store.mjs';
import {createSeed} from '../core/seed.mjs';

test('deployment configuration accepts only a non-secret HTTPS origin',()=>{
 assert.equal(backendOrigin('https://api.example.com/'),'https://api.example.com');
 for(const value of ['http://api.example.com','https://user:password@api.example.com','https://api.example.com/api','https://api.example.com?token=secret','https://api.example.com/#secret'])assert.throws(()=>backendOrigin(value));
 assert.equal(backendOrigin(''),'');assert.throws(()=>backendOrigin('',{required:true}),/TNS_API_BASE/);
});
test('private D1 migration preserves the workspace and hash, excludes sessions, and does not overwrite a real remote workspace',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'tns-export-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const local=new DatabaseSync(join(directory,'workspace.sqlite'));local.exec(SCHEMA);const state=createSeed();state.isSample=false;state.settings.teamName="Fixture's real workspace";
 local.prepare('INSERT INTO workspace(id,version,data) VALUES(1,1,?)').run(JSON.stringify(state));local.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('admin',JSON.stringify({salt:'fixture-salt',hash:'fixture-hash'}));local.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('unrelated-secret',JSON.stringify('never-export'));
 local.prepare('INSERT INTO sessions(digest,expires) VALUES(?,?)').run('never-copy-this-session',Date.now()+60000);local.close();
 execFileSync(process.execPath,[resolve('scripts/export-d1.mjs')],{env:{...process.env,TNS_DATA_DIR:directory},stdio:'pipe'});
 const file=join(directory,'deployment','production-import.sql'),sql=await readFile(file,'utf8');assert.equal((await stat(file)).mode&0o777,0o600);assert.ok(!sql.includes('never-copy-this-session'));assert.ok(!sql.includes('never-export'));
 const remote=new DatabaseSync(':memory:');t.after(()=>remote.close());remote.exec(sql);assert.equal(JSON.parse(remote.prepare('SELECT data FROM workspace WHERE id=1').get().data).settings.teamName,state.settings.teamName);assert.equal(JSON.parse(remote.prepare("SELECT value FROM metadata WHERE key='admin'").get().value).hash,'fixture-hash');assert.equal(remote.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
 const newer=structuredClone(state);newer.settings.teamName='Newer remote edits';remote.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(newer));remote.exec(sql);assert.equal(JSON.parse(remote.prepare('SELECT data FROM workspace WHERE id=1').get().data).settings.teamName,'Newer remote edits');
 const sample=createSeed();remote.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(sample));remote.exec(sql);assert.equal(JSON.parse(remote.prepare('SELECT data FROM workspace WHERE id=1').get().data).settings.teamName,state.settings.teamName);
});
