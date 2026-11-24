import { Store,d1Adapter } from '../server/store.mjs';
import { handleApi,tick } from '../server/api.mjs';
import { createSeed } from '../core/seed.mjs';

async function getStore(env) { const store=new Store(d1Adapter(env.DB),createSeed); await store.initialize(); return store; }
export default {
  async fetch(request,env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return handleApi(request,await getStore(env),{publicOrigin:env.PUBLIC_ORIGIN,bootstrapToken:env.BOOTSTRAP_TOKEN,ip:request.headers.get('CF-Connecting-IP') || 'unknown'});
    const response=await env.ASSETS.fetch(request);
    const headers=new Headers(response.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('X-Frame-Options','DENY');headers.set('Referrer-Policy','strict-origin-when-cross-origin');
    return new Response(response.body,{status:response.status,headers});
  },
  async scheduled(_controller,env,ctx) { ctx.waitUntil(getStore(env).then(store=>tick(store))); }
};
