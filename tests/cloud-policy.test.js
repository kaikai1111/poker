// macOS: osascript -l JavaScript tests/cloud-policy.test.js /absolute/project/path
// CI: node tests/cloud-policy.test.js
function run(argv) {
  if(typeof require==='function')require('../supabase/functions/table-api/policy.js');
  else {ObjC.import('Foundation');eval(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0]+'/supabase/functions/table-api/policy.js',$.NSUTF8StringEncoding,null)));}
  const policy=globalThis.TableCloudPolicy;
  function assert(v,m){if(!v)throw new Error(m);}
  function clone(v){return JSON.parse(JSON.stringify(v));}
  function denied(fn,status){let caught=false;try{fn();}catch(e){caught=true;assert(e.status===status,e.message);}assert(caught,'operation should have been denied');}
  const now=Date.parse('2026-10-07T12:00:00Z');
  const s={dataVersion:3,remaining:1800,paused:true,started:false,prize:0,startStack:1000,entries:{},busts:{},results:{},dealerIndex:0,dealerMinutes:30,sb:100,bb:200,profiles:{},checkins:{},seats:{},reports:{},history:[]};
  const accounts={alice:{role:'admin',createdAt:'today'},bob:{role:'player',createdAt:'today'}};
  const invite={token:'ABCD2345',day:'2026-10-07',createdBy:'alice'};
  const view={user:{name:'bob',role:'player'},state:s,players:[],accounts:accounts,revision:1};
  let data=clone(view);data.seatToken=invite.token;
  const joined=policy.reconcile(view,data,invite,now);
  assert(joined.payload.state.checkins.bob && joined.payload.players[0]==='bob','join requires valid issued code');
  assert(joined.roles===null,'player must not update account roles');
  assert(!s.checkins.bob,'policy must not mutate the stored snapshot');
  data.seatToken='INVALID2';denied(function(){policy.reconcile(view,data,invite,now);},403);
  data.seatToken=invite.token;denied(function(){policy.reconcile(view,data,invite,now+86400000);},403);
  data=clone(view);data.accounts.bob.role='admin';denied(function(){policy.reconcile(view,data,invite,now);},403);
  data=clone(view);data.state.entries.bob=10000;denied(function(){policy.reconcile(view,data,invite,now);},403);
  data=clone(view);data.state.profiles.alice={displayName:'hacked'};denied(function(){policy.reconcile(view,data,invite,now);},403);
  data=clone(view);data.state.seats.bob={day:invite.day};denied(function(){policy.reconcile(view,data,invite,now);},403);
  data=clone(view);data.revision=0;denied(function(){policy.reconcile(view,data,invite,now);},409);
  const seated={...clone(view),state:joined.payload.state,players:joined.payload.players};delete seated.state.seatInvite;
  data=clone(seated);data.state.reports.bob={chips:500,busts:1,startStack:1000,status:'approved'};
  const report=policy.reconcile(seated,data,invite,now);
  assert(report.payload.state.reports.bob.status==='pending','a player cannot approve their own report');
  const admin={...clone(seated),user:{name:'alice',role:'admin'}};admin.state.seatInvite=clone(invite);
  data=clone(admin);data.accounts.bob.role='admin';
  assert(policy.reconcile(admin,data,invite,now).roles.bob.role==='admin','admin can grant admin role');
  data.accounts.alice.role='player';denied(function(){policy.reconcile(admin,data,invite,now);},400);
  data=clone(admin);delete data.accounts.bob;
  const deleted=policy.reconcile(admin,data,invite,now);
  assert(!deleted.payload.state.seats.bob && !deleted.payload.players.includes('bob'),'deletion must purge attendance and player data');
  data=clone(admin);data.state.seatInvite.token='ZZZZ2345';denied(function(){policy.reconcile(admin,data,invite,now);},403);
  data=clone(admin);data.state.profiles.alice={photo:'javascript:alert(1)'};denied(function(){policy.reconcile(admin,data,invite,now);},400);
  data=clone(view);data.state.profiles.bob={photo:'data:image/jpeg;base64,test" onerror="alert(1)'};denied(function(){policy.reconcile(view,data,invite,now);},400);
  return 'PASS: cloud server policy: roles, codes, expiry, isolation, validation and conflicts';
}
if(typeof module!=='undefined' && module.exports)console.log(run([]));
