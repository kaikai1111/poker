(function () {
  'use strict';
  function fail(message,status) { const e=new Error(message); e.status=status || 400; throw e; }
  function equal(a,b) {
    if(a===b)return true;
    if(!a || !b || typeof a!=='object' || typeof b!=='object')return false;
    const keys=Object.keys(a).sort(), other=Object.keys(b).sort();
    return keys.length===other.length && keys.every(function(k,i){return k===other[i] && equal(a[k],b[k]);});
  }
  const clone=function(v){return JSON.parse(JSON.stringify(v));};
  const object=function(v){return v && typeof v==='object' && !Array.isArray(v);};
  const name=function(v){return typeof v==='string' && v.trim()===v && v.length>0 && v.length<=40 && !['__proto__','constructor','prototype'].includes(v) && !/[\x00-\x1f]/.test(v);};
  function integer(v,min) { if(!Number.isSafeInteger(v) || v<(min || 0))fail('PD・点数・回数は正しい整数で入力してください。'); }
  function validate(payload) {
    const s=payload && payload.state,p=payload && payload.players;
    if(!object(s) || !Array.isArray(p) || p.length>100 || !p.every(name) || new Set(p).size!==p.length)fail('参加者一覧を確認してください。');
    ['entries','busts','results','profiles','checkins','seats','reports'].forEach(function(k){if(!object(s[k]) || !Object.keys(s[k]).every(name))fail('プレイヤーデータを確認してください。');});
    ['entries','busts'].forEach(function(k){Object.values(s[k]).forEach(function(v){integer(v);});});
    function result(r){if(!object(r))fail('成績を確認してください。');['payout','chips','busts','startStack'].forEach(function(k){if(r[k]!==undefined)integer(r[k],k==='startStack'?1:0);});}
    ['results','reports'].forEach(function(k){Object.values(s[k]).forEach(result);});
    Object.values(s.profiles).forEach(function(profile){
      if(!object(profile) || typeof (profile.displayName || '')!=='string' || (profile.displayName || '').length>40)fail('プロフィールを確認してください。');
      const photo=profile.photo || '';
      if(typeof photo!=='string' || photo.length>1500000 || photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo))fail('プロフィール写真を確認してください。');
      if(!['アグレッシブ','堅実派','ブラフ好き','初心者','エンジョイ勢'].includes(profile.style || 'エンジョイ勢'))fail('プレイスタイルを確認してください。');
    });
    ['remaining','dealerIndex','sb','bb'].forEach(function(k){integer(s[k]);});
    ['startStack','dealerMinutes'].forEach(function(k){integer(s[k],1);});
    if(typeof s.started!=='boolean' || typeof s.paused!=='boolean' || !Array.isArray(s.history))fail('ゲーム設定を確認してください。');
    s.history.forEach(function(game){if(!object(game) || !object(game.entries) || !object(game.results))fail('履歴を確認してください。');Object.values(game.entries).forEach(function(v){integer(v);});Object.values(game.results).forEach(result);});
    Object.values(s.seats).forEach(function(seat){if(!object(seat) || !/^\d{4}-\d{2}-\d{2}$/.test(seat.day))fail('着席情報を確認してください。');});
  }
  function purge(payload,n) {
    payload.players=payload.players.filter(function(p){return p!==n;});
    ['entries','busts','results','profiles','checkins','seats','reports'].forEach(function(k){delete payload.state[k][n];});
    payload.state.history.forEach(function(g){delete g.entries[n];delete g.results[n];});
  }
  function reconcile(snapshot,data,invite,now) {
    const actor=snapshot.user, n=actor.name;
    if(data.revision!==snapshot.revision)fail('ほかの端末で更新されました。再読み込みしてやり直してください。',409);
    const today=new Date(now+9*3600000).toISOString().slice(0,10);
    const payload=actor.role==='admin' ? {state:clone(data.state),players:clone(data.players)} : {state:clone(snapshot.state),players:clone(snapshot.players)};
    const s=payload.state, proposed=data.state;
    if(!object(proposed))fail('保存データを確認してください。');
    let roles=null;
    if(actor.role==='admin') {
      validate(payload);
      if(!object(data.accounts) || !data.accounts[n] || data.accounts[n].role!=='admin')fail('自分自身の管理者権限は解除・削除できません。');
      if(Object.keys(data.accounts).some(function(p){return !snapshot.accounts[p];}))fail('アカウントは登録画面から作成してください。');
      Object.values(data.accounts).forEach(function(a){if(!object(a) || !['admin','player'].includes(a.role))fail('権限を確認してください。');});
      Object.keys(snapshot.accounts).forEach(function(p){if(!data.accounts[p])purge(payload,p);});
      roles=data.accounts;
      if(!equal(s.seatInvite,snapshot.state.seatInvite))fail('参加キーは専用の発行ボタンから生成してください。',403);
      if(data.timerAction)s.timerEndsAt=s.started && !s.paused ? now/1000+s.remaining : null;
      else ['remaining','timerEndsAt','started','paused','dealerIndex'].forEach(function(k){if(snapshot.state[k]!==undefined)s[k]=snapshot.state[k];else delete s[k];});
    } else {
      ['entries','results','history','sb','bb','startStack','dealerMinutes','chips'].forEach(function(k){if(!equal(proposed[k],s[k]))fail('PD・ゲーム設定の変更は管理者のみ可能です。',403);});
      if(proposed.seatInvite || !equal(data.accounts,snapshot.accounts))fail('権限・参加キーの変更は管理者のみ可能です。',403);
      ['profiles','busts','reports','seats','checkins'].forEach(function(k){
        if(!object(proposed[k]))fail('保存データを確認してください。');
        const a=clone(s[k]),b=clone(proposed[k]);delete a[n];delete b[n];
        if(!equal(a,b))fail('他のプレイヤーのデータは変更できません。',403);
      });
      if(invite)s.seatInvite=clone(invite);
    }
    if(data.seatToken) {
      if(!invite || invite.token!==data.seatToken || invite.day!==today || !snapshot.accounts[invite.createdBy] || snapshot.accounts[invite.createdBy].role!=='admin')fail('参加キーが無効か期限切れです。',403);
      s.checkins[n]=true;s.seats[n]={day:today,joinedAt:new Date(now).toISOString()};
      if(!payload.players.includes(n)){payload.players.push(n);s.entries[n]=0;}
    } else if(actor.role!=='admin' && (!equal(proposed.seats,snapshot.state.seats) || !equal(proposed.checkins,snapshot.state.checkins) || !equal(data.players,snapshot.players)))fail('着席には管理者の参加キーが必要です。',403);
    if(actor.role!=='admin') {
      if(proposed.profiles[n])s.profiles[n]=clone(proposed.profiles[n]);
      const seated=s.seats[n] && s.seats[n].day===today && s.checkins[n];
      ['busts','reports'].forEach(function(k){
        if(!equal(proposed[k][n],s[k][n])){
          if(!seated)fail('先に席に座ってください。',403);
          if(proposed[k][n]===undefined)fail('申告データを確認してください。');
          s[k][n]=clone(proposed[k][n]);if(k==='reports')s[k][n].status='pending';
        }
      });
      if(proposed.started && !s.started){if(!seated)fail('タイマーの開始には着席が必要です。',403);s.started=true;s.paused=false;s.timerEndsAt=now/1000+s.remaining;}
    }
    validate(payload);
    s.prize=payload.players.reduce(function(sum,p){return sum+(s.entries[p] || 0);},0);
    return {payload:payload,roles:roles};
  }
  globalThis.TableCloudPolicy={reconcile:reconcile,validate:validate,equal:equal};
}());
