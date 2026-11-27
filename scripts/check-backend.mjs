import {backendOrigin} from './deployment-config.mjs';
const base=backendOrigin(process.env.TNS_API_BASE,{required:true});
const publicOrigin=backendOrigin(process.env.TNS_PUBLIC_ORIGIN||`https://${(process.env.GITHUB_REPOSITORY||'').split('/')[0]}.github.io`,{required:true});
if(publicOrigin==='https://.github.io')throw new Error('Set TNS_PUBLIC_ORIGIN to the exact Pages or custom-domain origin.');
const request=async(path,cors=false)=>{
 const response=await fetch(base+path,{headers:cors?{Origin:publicOrigin}:{},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error(`Backend ${path} returned ${response.status}.`);
 if(cors&&response.headers.get('access-control-allow-origin')!==publicOrigin)throw new Error(`Set the backend PUBLIC_ORIGIN to ${publicOrigin} before publishing Pages.`);
 return response.json();
};
let health;
for(let attempt=0;attempt<90;attempt++){
 health=await request('/api/health',true);
 if(health.features?.nightPlanner>=1)break;
 if(attempt===89)throw new Error('The night-planner backend has not finished deploying. Retry this workflow after Cloudflare is ready.');
 if(attempt===0)console.log('Waiting for the matching night-planner backend deployment…');
 await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!health.ok)throw new Error('The backend is not healthy.');
const state=await request('/api/public',true);
if(!state.backendReady||!Array.isArray(state.people))throw new Error('The backend is not serving a TNS workspace.');
if(state.isSample)throw new Error('Migrate the current team workspace before publishing. The backend still contains sample data.');
const auth=await request('/api/auth');
if(!auth.configured)throw new Error('Configure or migrate the shared admin passphrase before publishing.');
console.log('Backend connected; public-origin access, real roster, and admin setup verified.');
