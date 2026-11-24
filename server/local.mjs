import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir,readFile,stat,chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve,extname,sep } from 'node:path';
import { Store } from './store.mjs';
import { createSeed } from '../core/seed.mjs';
import { handleApi,initializePassword,tick } from './api.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dataDir=resolve(process.env.TNS_DATA_DIR || resolve(root,'.data'));
await mkdir(dataDir,{recursive:true,mode:0o700});
const db=new DatabaseSync(resolve(dataDir,'workspace.sqlite'));
await chmod(resolve(dataDir,'workspace.sqlite'),0o600);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
const adapter={exec:async sql=>db.exec(sql),first:async(sql,args)=>db.prepare(sql).get(...args),run:async(sql,args)=>db.prepare(sql).run(...args)};
const store=new Store(adapter,createSeed); await store.initialize();
await initializePassword(store,process.env.TNS_ADMIN_PASSWORD);
const port=+(process.env.PORT || 4173),host=process.env.HOST || '127.0.0.1';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.ttf':'font/ttf'};
const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"};
const server=createServer(async(req,res)=>{
  try {
    const origin=`http://${req.headers.host}`;
    const url=new URL(req.url,origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks=[];let length=0;
      for await (const chunk of req) {length+=chunk.length;if(length>4000000){res.writeHead(413,headers);res.end('Request too large');return;}chunks.push(chunk);}
      const request=new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
      const response=await handleApi(request,store,{localSetup:['127.0.0.1','::1'].includes(req.socket.remoteAddress) && ['127.0.0.1','localhost'].includes(url.hostname),ip:req.socket.remoteAddress,publicOrigin:process.env.TNS_PUBLIC_ORIGIN});
      res.writeHead(response.status,{...headers,...Object.fromEntries(response.headers)});res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405,headers);res.end();return;}
    let filename=resolve(root,'public','.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if (!filename.startsWith(resolve(root,'public')+sep)) {res.writeHead(403,headers);res.end();return;}
    const data=await readFile(filename);
    res.writeHead(200,{...headers,'Content-Type':mime[extname(filename)] || 'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:data);
  } catch (error) {res.writeHead(error.code==='ENOENT'?404:500,headers);res.end(error.code==='ENOENT'?'Not found':'The server could not complete this request.');}
});
await new Promise(resolve=>server.listen(port,host,resolve));
console.log(`TNS workspace: http://${host}:${port}`);
console.log('Persistent data is in the ignored .data directory. Create the shared admin password in the Admin screen.');
const interval=setInterval(()=>tick(store).catch(()=>{}),60000); interval.unref();
await tick(store);
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{clearInterval(interval);server.close(()=>{db.close();process.exit(0);});});
