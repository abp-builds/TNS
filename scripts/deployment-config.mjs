export function backendOrigin(value,{required=false}={}){
 const normalized=(value||'').replace(/\/$/,'');
 if(!normalized){if(required)throw new Error('Set TNS_API_BASE to the HTTPS origin of the deployed backend.');return '';}
 const url=new URL(normalized);
 if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('Use an HTTPS origin without a path, credentials, query, or fragment.');
 return url.origin;
}
