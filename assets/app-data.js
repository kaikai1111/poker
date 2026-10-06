(function () {
  'use strict';

  // The old prototype persisted these example records. Only matching examples
  // without a report or a saved game are removed during the one-time migration.
  const legacySamples = {
    Yuta: {entry:3000, rank:1, payout:10500, chips:[1500,15000]},
    Mika: {entry:3000, rank:2, payout:6300, chips:[800,8000]},
    Sota: {entry:6000, rank:3, payout:4200, chips:[500,5000]},
    Anna: {entry:3000, rank:4, payout:0, chips:[200,2000]},
    Ryo: {entry:3000, rank:5, payout:0, chips:[100,1000]},
    Kei: {entry:3000, rank:6, payout:0, chips:[0]}
  };

  function defaults() {
    return {dataVersion:3,remaining:1800,paused:true,started:false,prize:0,
      startStack:1000,entries:{},busts:{},results:{},dealerIndex:0,
      dealerMinutes:30,sb:100,bb:200,profiles:{},checkins:{},reports:{},history:[]};
  }

  function initialize(saved, savedPlayers, accounts) {
    const state = Object.assign(defaults(), JSON.parse(JSON.stringify(saved || {})));
    ['entries','busts','results','profiles','checkins','reports'].forEach(function (key) {
      state[key] = state[key] || {};
    });
    state.history = Array.isArray(state.history) ? state.history : [];
    let players = Array.from(new Set((Array.isArray(savedPlayers) ? savedPlayers : []).filter(function (p) { return typeof p === 'string' && p.trim(); })));
    let cleanupChanged = false;

    if (!saved || (Number(saved.dataVersion) || 0) < 3) {
      Object.keys(legacySamples).forEach(function (name) {
        const sample = legacySamples[name], result = state.results[name];
        const hasRealRecord = Boolean(state.reports[name] || state.busts[name] || state.history.some(function (game) {
          return game.results && Object.prototype.hasOwnProperty.call(game.results,name);
        }));
        const matches = result && result.rank === sample.rank && result.payout === sample.payout
          && sample.chips.includes(result.chips) && !result.busts
          && state.entries[name] === sample.entry;
        if (!matches || hasRealRecord) return;
        delete state.entries[name];
        delete state.results[name];
        cleanupChanged = true;
      });
      // Earlier cleanups left example people in the roster when they had a
      // profile or a report. Keep that data recoverable, but remove the six
      // built-in names from the active roster unless they have an account.
      const originalCount = players.length;
      players = players.filter(function (name) {
        return !Object.prototype.hasOwnProperty.call(legacySamples,name)
          || Object.prototype.hasOwnProperty.call(accounts || {},name);
      });
      cleanupChanged = cleanupChanged || players.length !== originalCount;
    }

    state.dataVersion = 3;
    if (state.startStack === 20000 && !(saved && saved.busts)) state.startStack = 1000;
    if (cleanupChanged) state.prize = players.reduce(function (sum,name) { return sum + (Number(state.entries[name]) || 0); },0);
    if (!players.length) { state.dealerIndex=0; state.started=false; state.paused=true; state.remaining=state.dealerMinutes*60; }
    else state.dealerIndex = (Number(state.dealerIndex) || 0) % players.length;
    return {state:state,players:players,cleanupChanged:cleanupChanged};
  }

  function statsFor(name, state) {
    const records = state.history.filter(function (game) {
      return game.results && Object.prototype.hasOwnProperty.call(game.results,name);
    }).map(function (game) {
      const result = game.results[name];
      return {id:game.id,title:game.title,playedAt:game.playedAt,
        profit:(Number(result.payout) || 0) - (Number((game.entries || {})[name]) || 0)};
    });
    const wins = records.filter(function (r) { return r.profit > 0; }).length;
    return {games:records.length,wins:wins,winRate:records.length ? (wins / records.length * 100).toFixed(1) : '0',
      profit:records.reduce(function (sum,r) { return sum+r.profit; },0),
      recent:records.slice().sort(function (a,b) { return String(b.playedAt).localeCompare(String(a.playedAt)); })};
  }

  function recordGame(state, players) {
    if (!players.length) return;
    const now = new Date().toISOString();
    const id = state.currentGameId || ('game-' + Date.now().toString(36));
    const entries = {}, results = {};
    players.forEach(function (p) { entries[p]=Number(state.entries[p]) || 0; results[p]=Object.assign({},state.results[p] || {}); });
    const snapshot = {id:id,title:state.gameTitle || 'キャッシュゲーム',playedAt:state.finalizedAt || now,entries:entries,results:results};
    const index = state.history.findIndex(function (game) { return game.id === id; });
    if (index < 0) state.history.push(snapshot); else state.history[index]=snapshot;
    state.currentGameId = id;
    state.finalizedAt = snapshot.playedAt;
  }

  function rankingRows(state, players, accounts) {
    const names = Object.keys(accounts || {});
    const rows = names.map(function (name) { return Object.assign({name:name},statsFor(name,state)); })
      .sort(function (a,b) { return b.profit-a.profit; });
    rows.forEach(function (row,index) { row.position=index && row.profit === rows[index-1].profit ? rows[index-1].position : index+1; });
    return rows;
  }

  function editPlayer(state, players, name, edit) {
    const numbers = ['entry','startStack','busts','chips','payout'];
    numbers.forEach(function (key) {
      if (!Number.isSafeInteger(edit[key]) || edit[key] < (key === 'startStack' ? 1 : 0)) throw new Error('金額・点数・回数は正しい整数で入力してください。');
    });
    (edit.history || []).forEach(function (row) {
      if (!state.history[row.index] || !Object.prototype.hasOwnProperty.call(state.history[row.index].results || {},name)) throw new Error('履歴が見つかりません。');
      ['entry','payout','chips','busts'].forEach(function (key) {
        if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error('過去の記録は0以上の整数で入力してください。');
      });
    });
    state.profiles[name] = Object.assign({},state.profiles[name],{displayName:edit.displayName || name,style:edit.style});
    state.entries[name] = edit.entry;
    state.busts[name] = edit.busts;
    state.results[name] = Object.assign({},state.results[name],{startStack:edit.startStack,busts:edit.busts,chips:edit.chips,payout:edit.payout});
    if (state.reports[name]) Object.assign(state.reports[name],{startStack:edit.startStack,busts:edit.busts,chips:edit.chips,status:'approved'});
    (edit.history || []).forEach(function (row) {
      const game = state.history[row.index];
      game.entries = game.entries || {};
      game.entries[name] = row.entry;
      Object.assign(game.results[name],{payout:row.payout,chips:row.chips,busts:row.busts});
      if (game.id === state.currentGameId) {
        state.entries[name] = row.entry;
        Object.assign(state.results[name],{payout:row.payout,chips:row.chips,busts:row.busts});
        state.busts[name] = row.busts;
        if (state.reports[name]) Object.assign(state.reports[name],{chips:row.chips,busts:row.busts});
      }
    });
    const current = state.history.find(function (game) { return game.id === state.currentGameId; });
    if (current && Object.prototype.hasOwnProperty.call(current.results || {},name)) {
      current.entries = current.entries || {};
      current.entries[name] = state.entries[name];
      current.results[name] = Object.assign({},state.results[name]);
    }
    let next = players.filter(function (p) { return p !== name; });
    if (edit.participating) next = players.includes(name) ? players.slice() : players.concat(name);
    state.checkins[name] = Boolean(edit.participating);
    normalizeRoster(state,players,next);
    return next;
  }

  function normalizeRoster(state, before, after) {
    const dealer = before[state.dealerIndex];
    state.dealerIndex = Math.max(0,after.indexOf(dealer));
    state.prize = after.reduce(function (sum,p) { return sum + (Number(state.entries[p]) || 0); },0);
    if (!after.length) { state.started=false; state.paused=true; state.remaining=state.dealerMinutes*60; }
  }

  function deletePlayer(state, players, accounts, name, actor) {
    if (!accounts[actor] || accounts[actor].role !== 'admin') throw new Error('管理者のみ削除できます。');
    if (name === actor) throw new Error('ログイン中の管理者自身は削除できません。');
    delete accounts[name];
    ['entries','busts','results','profiles','checkins','reports'].forEach(function (key) { delete state[key][name]; });
    state.history.forEach(function (game) { if (game.entries) delete game.entries[name]; if (game.results) delete game.results[name]; });
    const next = players.filter(function (p) { return p !== name; });
    normalizeRoster(state,players,next);
    return next;
  }

  globalThis.TableData = {initialize:initialize,statsFor:statsFor,recordGame:recordGame,rankingRows:rankingRows,editPlayer:editPlayer,deletePlayer:deletePlayer};
}());
