(function () {
  'use strict';
  let revision=0, busy=false;
  const cloud=window.TABLE_SUPABASE;
  const sessionKey=cloud ? 'table-cloud-session:'+cloud.url : '';
  function session() { try { return cloud ? JSON.parse(localStorage.getItem(sessionKey) || 'null') : null; } catch (_) { return null; } }
  function storeSession(value) { if(value)localStorage.setItem(sessionKey,JSON.stringify(value));else localStorage.removeItem(sessionKey); }
  async function refresh(signal) {
    const saved=session();
    if(!saved || saved.expires_at>Date.now()/1000+60)return saved;
    const response=await fetch(cloud.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',signal:signal,headers:{apikey:cloud.key,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:saved.refresh_token})});
    const data=await response.json();
    if(!response.ok){storeSession(null);return null;}
    const next={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at || Date.now()/1000+data.expires_in};
    storeSession(next);return next;
  }
  async function request(path, method, body) {
    const controller=new AbortController();
    const timeout=setTimeout(function () { controller.abort(); },12000);
    try {
      let endpoint=path, headers=body ? {'Content-Type':'application/json'} : {};
      if(cloud){
        const saved=await refresh(controller.signal);
        endpoint=cloud.url+'/functions/v1/table-api'+path.replace(/^\/api/,'');
        headers.apikey=cloud.key;
        if(saved)headers.Authorization='Bearer '+saved.access_token;
      }
      const response=await fetch(endpoint,{method:method || 'GET',credentials:cloud ? 'omit' : 'same-origin',cache:'no-store',signal:controller.signal,headers:headers,body:body ? JSON.stringify(body) : undefined});
      const data=await response.json();
      if(!response.ok){
        if(cloud && response.status===401){storeSession(null);if(path==='/api/session' && headers.Authorization)return await request(path);}
        const error=new Error(data.error || 'サーバーと通信できませんでした。');error.status=response.status;throw error;
      }
      if(cloud && data.session)storeSession(data.session);
      if(cloud && path==='/api/logout')storeSession(null);
      if (data.revision !== undefined) revision=data.revision;
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('通信に時間がかかっています。接続を確認して再度お試しください。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function write(payload) {
    if (busy) throw new Error('保存中です。少し待ってから操作してください。');
    busy=true;
    try { return await request('/api/state','PUT',Object.assign({},payload,{revision:revision})); }
    finally { busy=false; }
  }
  window.TableAPI={request:request,write:write,isBusy:function(){return busy;},revision:function(){return revision;}};
}());
