// macOS: osascript -l JavaScript tests/app-data.test.js /absolute/project/path
function run(argv) {
  ObjC.import('Foundation');
  const root = argv[0];
  function read(path) { return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(root+'/'+path,$.NSUTF8StringEncoding,null)); }
  function assert(condition,message) { if (!condition) throw new Error(message); }
  eval(read('assets/app-data.js'));

  const empty = TableData.initialize({},[],{});
  assert(empty.players.length === 0 && Object.keys(empty.state.results).length === 0,'fresh install must be empty');
  assert(TableData.statsFor('alice',empty.state).games === 0,'new account must have no games');
  const registered=TableData.rankingRows(empty.state,[],{alice:{},bob:{}});
  assert(registered.length === 2 && registered.every(function(row){return row.games === 0 && row.profit === 0 && row.position === 1;}),'registered accounts must appear automatically with zero stats and tied ranks');
  assert(empty.players.length === 0,'ranking membership must not invent game attendance');
  assert(TableData.rankingRows(empty.state,['alice'],{alice:{}}).length === 1,'registered participant must not appear twice');

  const legacy = {prize:21000,entries:{Yuta:3000,Mika:3000,Sota:6000,Anna:3000,Ryo:3000,Kei:3000},
    results:{Yuta:{rank:1,payout:10500,chips:1500},Mika:{rank:2,payout:6300,chips:800},Sota:{rank:3,payout:4200,chips:500},Anna:{rank:4,payout:0,chips:200},Ryo:{rank:5,payout:0,chips:100},Kei:{rank:6,payout:0,chips:0}},
    profiles:{Yuta:{displayName:'My name',photo:'data:image/jpeg;base64,photo'}},
    reports:{Ryo:{busts:1,chips:500,status:'pending'}},busts:{Ryo:1}};
  const untouched=JSON.parse(JSON.stringify(legacy));
  untouched.profiles={};untouched.reports={};untouched.busts={};
  const noSamples=TableData.initialize(untouched,Object.keys(untouched.entries),{});
  assert(noSamples.players.length === 0 && noSamples.state.prize === 0 && Object.keys(noSamples.state.results).length === 0,'all six untouched sample players should be removed');
  legacy.results.Mika.payout=7000; // A modified result must survive.
  const cleaned = TableData.initialize(legacy,Object.keys(legacy.entries),{});
  assert(cleaned.cleanupChanged,'old samples should be detected');
  assert(!cleaned.players.includes('Sota') && !cleaned.state.results.Sota,'untouched example should be removed');
  assert(cleaned.state.results.Mika.payout === 7000,'edited result should be preserved');
  assert(cleaned.state.reports.Ryo.chips === 500 && cleaned.state.busts.Ryo === 1,'report and bust records should survive');
  assert(cleaned.state.profiles.Yuta.photo === legacy.profiles.Yuta.photo,'profile photo should survive');
  assert(!cleaned.players.includes('Yuta') && !cleaned.state.results.Yuta,'sample profile should survive without putting a sample person in the roster');
  assert(legacy.results.Sota.chips === 500,'migration must not mutate the backup source');
  assert(!TableData.initialize(cleaned.state,cleaned.players,{}).cleanupChanged,'migration must run once');
  const previouslyCleaned=JSON.parse(JSON.stringify(legacy));previouslyCleaned.dataVersion=2;
  const recovered=TableData.initialize(previouslyCleaned,Object.keys(legacy.entries).concat(['alice']),{alice:{}});
  assert(recovered.players.join(',') === 'alice' && recovered.state.dataVersion === 3,'v2 leftovers must be removed from the roster while the real participant survives');
  assert(recovered.state.reports.Ryo.chips === 500 && recovered.state.results.Mika.payout === 7000,'cleaning the roster must preserve entered records');
  const registeredOnly=TableData.rankingRows(recovered.state,Object.keys(legacy.entries),{alice:{}});
  assert(registeredOnly.length === 1 && registeredOnly[0].name === 'alice','neither old participants nor historical sample results may appear as registered accounts');
  assert(TableData.initialize(previouslyCleaned,['Yuta'],{Yuta:{}}).players.includes('Yuta'),'a genuine registered account must not be removed solely because its name matches a sample');

  const game=empty.state;
  game.entries.alice=1000; game.results.alice={chips:500,busts:1,payout:1500};
  TableData.recordGame(game,['alice']);
  TableData.recordGame(game,['alice']);
  assert(game.history.length === 1,'resaving a result must not duplicate participation');
  let stats=TableData.statsFor('alice',game);
  assert(stats.games === 1 && stats.profit === 500 && stats.winRate === '100.0','stats must use actual saved results');
  assert(TableData.rankingRows(game,['alice'],{alice:{},bob:{}})[1].name === 'bob','account without results must remain visible alongside played accounts');
  game.results.alice.payout=500;
  assert(TableData.statsFor('alice',game).profit === 500,'unsaved edits must not change historical stats');
  TableData.recordGame(game,['alice']);
  assert(TableData.statsFor('alice',game).profit === -500,'saved corrections must update stats');

  const managed=TableData.initialize({},['alice','bob'],{}).state;
  managed.entries={alice:1000,bob:1000}; managed.results={alice:{payout:1000},bob:{payout:500}};
  managed.profiles.bob={photo:'data:image/jpeg;base64,test'};
  managed.reports.bob={chips:100,busts:1,status:'pending'};
  TableData.recordGame(managed,['alice','bob']);
  managed.history.push({id:'previous',title:'Earlier',entries:{bob:500},results:{bob:{payout:200,chips:100,busts:1}}});
  let roster=TableData.editPlayer(managed,['alice','bob'],'bob',{displayName:'Bob edited',style:'堅実派',participating:true,entry:2000,startStack:1000,busts:2,chips:800,payout:2800,history:[{index:1,entry:500,payout:700,chips:700,busts:0}]});
  assert(TableData.statsFor('bob',managed).profit === 1000,'edits to current and past games must immediately update cumulative profit');
  assert(managed.profiles.bob.photo && managed.reports.bob.chips === 800 && managed.reports.bob.status === 'approved','editing must retain the photo and synchronize reports');
  const beforeInvalid=JSON.stringify(managed);
  try { TableData.editPlayer(managed,roster,'bob',{entry:-1,startStack:1000,busts:0,chips:0,payout:0}); } catch(e) {}
  assert(JSON.stringify(managed) === beforeInvalid,'invalid edits must not partially mutate data');
  const managedAccounts={alice:{role:'admin'},bob:{role:'player'}};
  try { TableData.deletePlayer(managed,roster,managedAccounts,'alice','alice'); } catch(e) {}
  assert(managedAccounts.alice,'admin must not delete themselves');
  try { TableData.deletePlayer(managed,roster,managedAccounts,'alice','bob'); } catch(e) {}
  assert(managedAccounts.alice,'player must not delete an account');
  roster=TableData.deletePlayer(managed,roster,managedAccounts,'bob','alice');
  assert(!managedAccounts.bob && !roster.includes('bob') && !managed.profiles.bob && !managed.reports.bob && managed.history.every(function(g){return !g.results.bob && !g.entries.bob;}),'deletion must remove account, roster, profile, reports and historical records');
  assert(managed.prize === 1000,'deletion must recalculate game totals');

  const seats=TableData.initialize({},[],{}).state, seatAccounts={alice:{role:'admin'},bob:{role:'player'}};
  const today='2026-10-06T14:59:00Z', tomorrow='2026-10-06T15:00:00Z', token='ABCD2345';
  assert(TableData.japanDay(today) === '2026-10-06' && TableData.japanDay(tomorrow) === '2026-10-07','attendance must use midnight in Japan, not host timezone');
  try { TableData.createSeatInvite(seats,seatAccounts,'bob',token,today); } catch(e) {}
  assert(!seats.seatInvite,'non-admin cannot generate QR invitations');
  TableData.createSeatInvite(seats,seatAccounts,'alice',token,today);
  let sitting=TableData.joinSeat(seats,[],seatAccounts,'bob',token,today);
  assert(TableData.seatedNames(seats,sitting,today).join(',') === 'bob','valid QR must seat signed-in player');
  sitting=TableData.joinSeat(seats,sitting,seatAccounts,'bob',token,today);
  assert(sitting.length === 1,'scanning QR twice must not duplicate a player');
  try { TableData.joinSeat(seats,sitting,seatAccounts,'alice','b'.repeat(32),today); } catch(e) {}
  assert(!seats.seats.alice,'forged QR must not create a seat');
  seats.entries.bob=1000; seats.results.bob={payout:1500};TableData.recordGame(seats,sitting);
  const preserved=JSON.stringify(seats.history);
  assert(TableData.expireSeats(seats,tomorrow) && !seats.checkins.bob && !seats.seatInvite,'at midnight seats and QR must expire');
  assert(!TableData.expireSeats(seats,tomorrow),'expiry must be idempotent');
  assert(TableData.seatedNames(seats,sitting,tomorrow).length === 0 && seats.entries.bob === 1000 && JSON.stringify(seats.history) === preserved,'automatic checkout must preserve money and game history');
  try { TableData.joinSeat(seats,sitting,seatAccounts,'bob',token,tomorrow); } catch(e) {}
  assert(!seats.checkins.bob,'yesterday QR must not admit someone');
  try { TableData.setRole(seatAccounts,'bob','bob','admin'); } catch(e) {}
  assert(seatAccounts.bob.role === 'player','non-admin cannot promote themselves');
  TableData.setRole(seatAccounts,'alice','bob','admin');
  assert(seatAccounts.bob.role === 'admin','admin can grant admin role');
  TableData.setRole(seatAccounts,'alice','bob','player');
  try { TableData.setRole(seatAccounts,'alice','alice','player'); } catch(e) {}
  assert(seatAccounts.alice.role === 'admin','admin self-demotion must be blocked');

  // Exercise the real page script with a minimal DOM. This catches stale element
  // references and verifies the empty → check-in → saved result flow.
  const html=read('index.html'), elements={}, homeButtons=[], mobileButtons=[];
  assert(html.includes('ポーカードル（PD）') && html.includes('現金への換金・賞品への交換はできません。'),'currency must have a clear non-redeemable game-only description');
  assert(!html.includes('¥') && !html.includes('（円）') && !html.includes('精算額'),'UI must not present Poker Dollars as real money');
  function element(id) {
    const el={id:id,value:'',textContent:'',innerHTML:'',className:'',style:{},disabled:false,dataset:{}};
    const classes=new Set();
    el.classList={add:function(c){classes.add(c);},remove:function(c){classes.delete(c);},toggle:function(c,on){if(on)classes.add(c);else classes.delete(c);}};
    el.classList.contains=function(c){return classes.has(c);};
    el.focus=function(){}; el.showModal=function(){}; el.close=function(){};
    el.parentElement={querySelector:function(){return element('small');}};
    el.querySelector=function(selector){return selector === '.home-icon' && el.icon && el.icon.className === 'home-icon' ? el.icon : null;};
    el.querySelectorAll=function(){return [];};
    return el;
  }
  Array.from(html.matchAll(/\bid="([^"]+)"/g)).forEach(function(match){elements[match[1]]=element(match[1]);});
  ['timer','checkin','my','dashboard','admin','results'].forEach(function(key){
    const el=key === 'checkin' ? elements.checkIn : element(key);
    if(key !== 'checkin')el.dataset.open=key;
    el.icon=element('image');el.icon.className='home-icon';homeButtons.push(el);
  });
  ['home','timer','my','dashboard','admin'].forEach(function(key){
    const el=element(key);el.dataset.page=key;el.querySelector=function(){return element('span');};mobileButtons.push(el);
  });
  const stored={'table-accounts':JSON.stringify({alice:{role:'admin'},bob:{role:'player'}}),'table-user':JSON.stringify({name:'alice',role:'admin'}),
    'table-state':JSON.stringify(previouslyCleaned),'table-players':JSON.stringify(Object.keys(legacy.entries))};
  let resultInputs=[], editButtons=[];
  globalThis.localStorage={getItem:function(key){return stored[key] || null;},setItem:function(key,value){stored[key]=value;},removeItem:function(key){delete stored[key];}};
  globalThis.document={getElementById:function(id){return elements[id] || null;},querySelectorAll:function(selector){
    if(selector === '.home-link')return homeButtons;
    if(selector === '.mobile-tabs button' || selector === '[data-page]')return mobileButtons;
    if(selector === '[data-open]')return homeButtons.filter(function(el){return el.dataset.open;});
    if(selector === '[data-player]')return resultInputs;
    if(selector === '[data-edit-player]') {
      editButtons=Array.from(elements.adminPlayers.innerHTML.matchAll(/data-edit-player="([^"]+)"/g)).map(function(match){const button=element('edit');button.dataset.editPlayer=match[1];return button;});
      return editButtons;
    }
    return [];
  }};
  let scheduled=[], timerId=0;
  globalThis.window={location:{href:'https://table.example/index.html',protocol:'https:',hash:''},crypto:{getRandomValues:function(bytes){bytes.fill(1);return bytes;}},requestAnimationFrame:function(fn){fn();},setTimeout:function(fn,delay){const id=++timerId;scheduled.push({id:id,fn:fn,delay:delay});return id;},clearTimeout:function(id){scheduled=scheduled.filter(function(timer){return timer.id !== id;});}};
  globalThis.setInterval=function(){};
  globalThis.alert=function(){};
  const scripts=Array.from(html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)).map(function(match){return match[1];});
  function runPage() { homeButtons.forEach(function(button){button.icon.className='home-icon';}); new Function(scripts[0])(); new Function(scripts[1])(); }
  runPage();
  assert(elements.loadingScreen.classList.contains('hidden') && scheduled.length === 0,'successful boot must hide loader and cancel watchdog and paint fallback');
  assert(elements.homePlayerCount.textContent === 0,'page must boot without example participants');
  assert(elements.homeRankName.textContent === 'alice' && elements.homeRankValue.textContent === '—','account must not borrow another player rank');
  assert(elements.ranking.innerHTML.includes('alice') && elements.ranking.innerHTML.includes('bob') && elements.rankingMyValue.textContent === '#1','all registered accounts must be ranked before check-in');
  assert(!Object.keys(legacy.entries).some(function(name){return elements.ranking.innerHTML.includes(name);}), 'page must not render any of the six sample people even after the v2 cleanup');
  assert(Boolean(stored['table-before-sample-cleanup-v3']),'cleaned data must be backed up before persistence');
  homeButtons.find(function(el){return el.dataset.open === 'my';}).onclick();
  assert(elements.myGames.textContent === '0 回' && elements.myProfit.textContent.includes('0'),'registration must not create fake games or profit');
  assert(elements.myProfit.textContent === '0 PD','zero balance must use PD');
  elements.checkIn.onclick();
  assert(JSON.parse(stored['table-players']).length === 0,'seat button alone must not bypass QR');
  elements.displaySeatQr.onclick();
  assert(/^[A-HJ-NP-Z2-9]{4} [A-HJ-NP-Z2-9]{4}$/.test(elements.seatQrImage.textContent),'admin must display an automatically generated readable join code');
  elements.seatJoinLink.value=elements.seatQrImage.textContent;elements.seatJoinForm.onsubmit({preventDefault:function(){}});
  assert(JSON.parse(stored['table-players']).join(',') === 'alice','check-in must add the actual account');
  assert(elements.checkIn.icon.className === 'menu-photo','check-in must preserve its photo');
  elements.rebuyPlayer.value='alice';elements.rebuyValue.value='1000';elements.saveRebuy.onclick();
  resultInputs=['startStack','busts','chips','payout'].map(function(key,index){return {dataset:{player:'alice',key:key},value:[1000,1,500,1500][index]};});
  elements.saveResults.onclick();elements.saveResults.onclick();
  homeButtons.find(function(el){return el.dataset.open === 'my';}).onclick();
  assert(elements.myGames.textContent === '1 回' && elements.myWinRate.textContent === '100.0%','profile must show recorded stats');
  assert(elements.myProfit.textContent.includes('500') && JSON.parse(stored['table-state']).history.length === 1,'page must preserve real profit without duplicate history');
  assert(elements.myProfit.textContent === '+500 PD' && elements.ranking.innerHTML.includes('+500 PD'),'positive changes and ranking must show PD');
  resultInputs.find(function(input){return input.dataset.key === 'payout';}).value=500;
  elements.saveResults.onclick();
  homeButtons.find(function(el){return el.dataset.open === 'my';}).onclick();
  assert(elements.myProfit.textContent === '-500 PD','negative changes must use PD and retain the minus sign');
  resultInputs.find(function(input){return input.dataset.key === 'payout';}).value=1500;
  elements.saveResults.onclick();
  homeButtons.find(function(el){return el.dataset.open === 'admin';}).onclick();
  assert(elements.adminPlayers.innerHTML.includes('bob'),'admin must manage registered non-participants too');
  editButtons.find(function(button){return button.dataset.editPlayer === 'alice';}).onclick();
  assert(elements.deletePlayerAccount.disabled,'own admin deletion button must be disabled');
  elements.editEntry.value=2000;elements.editPayout.value=3000;elements.editChips.value=300;
  elements.playerEditForm.onsubmit({preventDefault:function(){}});
  assert(TableData.statsFor('alice',JSON.parse(stored['table-state'])).profit === 1000,'admin form must persist edits and update saved ranking');
  editButtons.find(function(button){return button.dataset.editPlayer === 'bob';}).onclick();
  globalThis.confirm=function(){return true;};
  elements.editRole.value='admin';elements.playerEditForm.onsubmit({preventDefault:function(){}});
  assert(JSON.parse(stored['table-accounts']).bob.role === 'admin','admin editor must persist granted permissions');
  editButtons.find(function(button){return button.dataset.editPlayer === 'bob';}).onclick();
  elements.editRole.value='player';elements.playerEditForm.onsubmit({preventDefault:function(){}});
  assert(JSON.parse(stored['table-accounts']).bob.role === 'player','admin editor must allow role revocation');
  editButtons.find(function(button){return button.dataset.editPlayer === 'bob';}).onclick();
  globalThis.confirm=function(){return false;}; elements.deletePlayerAccount.onclick();
  assert(JSON.parse(stored['table-accounts']).bob,'cancelled deletion must preserve account');
  globalThis.confirm=function(){return true;}; elements.deletePlayerAccount.onclick();
  assert(!JSON.parse(stored['table-accounts']).bob && !elements.ranking.innerHTML.includes('bob'),'confirmed deletion must persist and refresh ranking');
  assert(JSON.parse(stored['table-before-player-management']).accounts.bob,'deletion backup must preserve deleted account');

  const goodState=stored['table-state'];
  stored['table-state']='{broken-json';elements.startupError.classList.add('hidden');elements.loadingScreen.classList.remove('hidden');
  runPage();
  assert(elements.loadingScreen.classList.contains('hidden') && !elements.startupError.classList.contains('hidden'),'corrupt saved JSON must show recovery instead of an infinite loader');
  assert(stored['table-state'] === '{broken-json','failed boot must not overwrite unreadable data');
  stored['table-state']=goodState;
  const dataModule=globalThis.TableData;globalThis.TableData=undefined;
  elements.startupError.classList.add('hidden');elements.loadingScreen.classList.remove('hidden');runPage();
  assert(elements.loadingScreen.classList.contains('hidden') && !elements.startupError.classList.contains('hidden'),'missing helper file must escape loader');
  globalThis.TableData=dataModule;
  const normalSet=localStorage.setItem;
  localStorage.setItem=function(){throw new Error('QuotaExceededError');};
  elements.startupError.classList.add('hidden');elements.loadingScreen.classList.remove('hidden');runPage();
  assert(elements.loadingScreen.classList.contains('hidden') && !elements.startupError.classList.contains('hidden'),'storage write failure must escape loader');
  localStorage.setItem=normalSet;
  window.requestAnimationFrame=function(){};
  elements.startupError.classList.add('hidden');elements.loadingScreen.classList.remove('hidden');runPage();
  const fallback=scheduled.find(function(timer){return timer.delay === 80;});
  assert(Boolean(fallback),'paint fallback must exist when animation frames do not run');fallback.fn();
  assert(elements.loadingScreen.classList.contains('hidden') && scheduled.length === 0,'stalled animation frames must not block startup');
  elements.startupError.classList.add('hidden');elements.loadingScreen.classList.remove('hidden');
  new Function(scripts[0])();
  scheduled.find(function(timer){return timer.delay === 12000;}).fn();
  assert(elements.loadingScreen.classList.contains('hidden') && !elements.startupError.classList.contains('hidden'),'a stalled external script must show recovery on timeout');
  return 'PASS: Poker Dollar labels, positive/zero/negative PD changes, preserved records, join codes, roles and loading recovery';
}
