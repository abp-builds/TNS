import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SCHEMA} from '../server/store.mjs';
import {validateState} from '../core/domain.mjs';
const root=resolve(import.meta.dirname,'..'),dataDir=resolve(process.env.TNS_DATA_DIR||resolve(root,'.data'));
const db=new DatabaseSync(resolve(dataDir,'workspace.sqlite'),{readOnly:true});
const row=db.prepare('SELECT data FROM workspace WHERE id=1').get();
const admin=db.prepare('SELECT value FROM metadata WHERE key=?').get('admin');
if(!row||!admin)throw new Error('Set up the local workspace and shared admin passphrase before exporting.');
const state=validateState(JSON.parse(row.data));
if(state.isSample)throw new Error('Replace the fictional roster before exporting a production workspace.');
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const sql=[
 '-- Private one-time migration. Do not commit or publish this file.',
 '-- Use only with a new TNS database or an untouched sample workspace.',
 SCHEMA,
 `INSERT INTO workspace(id,version,data) VALUES(1,1,${literal(row.data)}) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=workspace.version+1 WHERE json_extract(workspace.data,'$.isSample')=1;`,
 `INSERT OR IGNORE INTO metadata(key,value) VALUES('admin',${literal(admin.value)});`,
 '-- Existing real workspace data and existing passwords are preserved; sessions are never copied.'
].join('\n');
const output=resolve(dataDir,'deployment','production-import.sql');await mkdir(resolve(dataDir,'deployment'),{recursive:true,mode:0o700});await writeFile(output,sql,{mode:0o600});
console.log(`Private migration saved to ${output}`);
console.log(`${state.people.filter(p=>p.active).length} active people. Includes the existing password hash; excludes signed-in sessions. Upload only through the backend database tools.`);
db.close();
