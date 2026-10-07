import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import './policy.js';

type Json = Record<string, any>;
const policy = (globalThis as any).TableCloudPolicy;
const url = Deno.env.get('SUPABASE_URL')!;
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};
function fail(status: number, message: string): never {
  const e = new Error(message) as Error & { status: number }; e.status = status; throw e;
}
async function rpc(name: string, args: Json) {
  const { data, error } = await service.rpc(name, args);
  if (error) {
    if (error.message.includes('REVISION_CONFLICT')) fail(409, 'ほかの端末で更新されました。再読み込みしてやり直してください。');
    if (error.message.includes('ACCOUNT_DISABLED')) fail(401, 'このアカウントは削除されています。');
    if (error.message.includes('ADMIN_REQUIRED')) fail(403, '管理者のみ操作できます。');
    fail(503, '共有データベースの設定を確認してください。');
  }
  return data;
}
async function snapshot(userId: string | null) { return await rpc('table_snapshot', { p_user: userId }); }
async function actor(token: string) {
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) fail(401, 'ログインし直してください。');
  const view = await snapshot(data.user.id);
  return { id: data.user.id, view };
}
async function throttle(bucket: string, limit: number) {
  if (!await rpc('table_allow_attempt', { p_bucket: bucket, p_limit: limit })) fail(429, '試行回数が多いため、1分ほど待ってください。');
}
function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8))).map((v) => alphabet[v % 32]).join('');
}
async function commit(userId: string, view: Json, payload: Json, accounts: Json | null) {
  await rpc('table_commit', { p_user: userId, p_revision: view.revision, p_payload: payload, p_accounts: accounts, p_actor_role: view.user.role });
  return await snapshot(userId);
}
async function login(data: Json, register: boolean) {
  await throttle('authentication', 60);
  const id = typeof data.id === 'string' ? data.id.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{3,20}$/.test(id) || ['__proto__','constructor','prototype'].includes(id) || typeof data.password !== 'string' || data.password.length < 8 || data.password.length > 256) fail(400, 'IDは3〜20文字、パスワードは8〜256文字で入力してください。');
  const first = (await snapshot(null)).setupRequired;
  if (register) {
    const setup = Deno.env.get('TABLE_SETUP_CODE');
    if (first && (!setup || data.setupCode !== setup)) fail(403, '初回管理者設定コードを確認してください。');
    // Inactive members remain blocked even if their Auth JWT has not expired.
    const { data: existing, error: lookupError } = await service.from('table_members').select('user_id').eq('account_id', id).maybeSingle();
    if (lookupError) fail(503, '共有データベースの設定を確認してください。');
    if (existing) fail(409, 'このIDはすでに使われています。');
    const { data: created, error } = await service.auth.admin.createUser({ email: id + '@table.invalid', password: data.password, email_confirm: true });
    if (error || !created.user) fail(400, 'アカウントを作成できませんでした。IDまたは設定を確認してください。');
    await rpc('table_finish_signup', { p_user: created.user.id, p_bootstrap: Boolean(first) });
  }
  // A separate Auth client prevents sign-in from replacing the service-role token.
  const auth = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: result, error } = await auth.auth.signInWithPassword({ email: id + '@table.invalid', password: data.password });
  if (error || !result.user || !result.session) fail(401, 'IDまたはパスワードが違います。');
  return { ...await snapshot(result.user.id), session: { access_token: result.session.access_token, refresh_token: result.session.refresh_token, expires_at: result.session.expires_at } };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let status = 200, result: Json;
  try {
    const path = new URL(request.url).pathname.split('/table-api').pop() || '/';
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    let data: Json = {};
    if (request.method !== 'GET') {
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'JSON形式で送信してください。');
      const text = await request.text();
      if (text.length > 16_000_000) fail(413, '送信データが大きすぎます。');
      try { data = JSON.parse(text); } catch { fail(400, '送信内容を確認してください。'); }
      if (!data || Array.isArray(data) || typeof data !== 'object') fail(400, '送信内容を確認してください。');
    }
    if (request.method === 'POST' && (path === '/login' || path === '/register')) {
      result = await login(data, path === '/register');
    } else if (request.method === 'GET' && path === '/session' && !token) {
      result = await snapshot(null);
    } else if (request.method === 'POST' && path === '/logout') {
      if (token) await service.auth.admin.signOut(token);
      result = {};
    } else {
      const { id, view } = await actor(token);
      if (request.method === 'GET' && path === '/session') {
        result = view;
      } else if (request.method === 'POST' && path === '/seat-code') {
        if (view.user.role !== 'admin') fail(403, '参加キーは管理者のみ発行できます。');
        const invite = view.state.seatInvite;
        if (!data.renew && invite && view.accounts[invite.createdBy]?.role === 'admin') result = view;
        else {
          const payload = { state: structuredClone(view.state), players: view.players };
          payload.state.seatInvite = { token: randomCode(), day: new Date(Date.now() + 9*3600000).toISOString().slice(0,10), createdBy: view.user.name };
          result = await commit(id, view, payload, null);
        }
      } else if (request.method === 'PUT' && path === '/state') {
        if (data.seatToken) await throttle('seat:' + id, 20);
        // The member snapshot hides the invite; only the trusted backend reads it.
        const { data: row, error } = await service.from('table_state').select('payload,revision').eq('id', 1).single();
        if (error) fail(503, '共有データベースに接続できません。');
        if (row.revision !== view.revision) fail(409, 'ほかの端末で更新されました。');
        const decision = policy.reconcile(view, data, row.payload.state.seatInvite, Date.now());
        result = await commit(id, view, decision.payload, decision.roles);
      } else fail(404, 'この操作は見つかりません。');
    }
  } catch (error) {
    const e = error as Error & { status?: number };
    status = e.status || 500;
    result = { error: e.status ? e.message : '処理に失敗しました。設定と入力内容を確認してください。' };
  }
  return new Response(JSON.stringify(result), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
});
