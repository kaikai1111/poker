Deno.test('GitHub client uses the shared API, refreshes JWTs and never sends a secret key', async () => {
  const g:any={};
  const stored=new Map<string,string>(), calls:any[]=[];
  g.window={TABLE_SUPABASE:{url:'https://test.supabase.co',key:'sb_publishable_test'}};
  g.localStorage={getItem:(k:string)=>stored.get(k) || null,setItem:(k:string,v:string)=>stored.set(k,v),removeItem:(k:string)=>stored.delete(k)};
  let expired=false;
  g.fetch=async (url:string,init:RequestInit) => {
    const headers=new Headers(init.headers);
    const body=init.body ? JSON.parse(String(init.body)) : null;
    calls.push({url,headers,body});
    if(url.includes('/auth/v1/token'))return Response.json({access_token:'renewed-token',refresh_token:'renewed-refresh',expires_in:3600});
    if(url.endsWith('/login'))return Response.json({user:{name:'alice'},revision:2,session:{access_token:'user-token',refresh_token:'user-refresh',expires_at:Date.now()/1000+3600}});
    if(url.endsWith('/session') && expired && headers.has('Authorization'))return Response.json({error:'expired'}, {status:401});
    if(url.endsWith('/state'))return Response.json({revision:3});
    return Response.json({user:null,setupRequired:true,revision:1});
  };
  function assert(value:unknown,message:string){if(!value)throw new Error(message);}
  try {
    new Function('window','localStorage','fetch',await Deno.readTextFile(new URL('../assets/shared-api.js',import.meta.url)))(g.window,g.localStorage,g.fetch);
    const api=g.window.TableAPI;
    await api.request('/api/session');
    assert(calls[0].url==='https://test.supabase.co/functions/v1/table-api/session','must not call nonexistent GitHub Pages API');
    assert(!calls[0].headers.has('Authorization'),'anonymous startup must not send a fabricated bearer token');
    await api.request('/api/login','POST',{id:'alice',password:'not-a-real-password'});
    await api.write({state:{},players:[],accounts:{}});
    assert(calls.at(-1).headers.get('Authorization')==='Bearer user-token','only the user JWT is used');
    assert(calls.at(-1).body.revision===2,'write must carry the last server revision');
    const sessionKey='table-cloud-session:https://test.supabase.co';
    assert(stored.has(sessionKey),'session keys: '+JSON.stringify([...stored.keys()]));
    const saved=JSON.parse(stored.get(sessionKey)!);saved.expires_at=0;stored.set(sessionKey,JSON.stringify(saved));
    await api.request('/api/session');
    assert(calls.some(c=>c.url.includes('grant_type=refresh_token')),'expired tokens must refresh');
    assert(calls.at(-1).headers.get('Authorization')==='Bearer renewed-token','refreshed token must be used');
    expired=true;
    await api.request('/api/session');
    assert(!calls.at(-1).headers.has('Authorization') && !stored.has(sessionKey),'invalid session must return to public login, not an endless loader');
    assert(calls.every(c=>c.headers.get('apikey')==='sb_publishable_test'),'only a public API key belongs in the browser');
  } finally {stored.clear();}
});
