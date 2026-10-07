"""TABLE shared SQLite server. Put behind HTTPS for use outside localhost."""
import argparse
import copy
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
JST = timezone(timedelta(hours=9))
DB_PATH = os.environ.get('TABLE_DB_PATH', str(ROOT / 'data' / 'table.sqlite3'))
SETUP_CODE = os.environ.get('TABLE_SETUP_CODE') or secrets.token_urlsafe(18)
PUBLIC_ORIGIN = os.environ.get('TABLE_PUBLIC_ORIGIN', '').rstrip('/')
COOKIE_SECURE = PUBLIC_ORIGIN.startswith('https://')


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def day():
    return datetime.now(JST).date().isoformat()


def initial_state():
    return dict(dataVersion=3, remaining=1800, paused=True, started=False, prize=0,
                startStack=1000, entries={}, busts={}, results={}, dealerIndex=0,
                dealerMinutes=30, sb=100, bb=200, profiles={}, checkins={}, seats={},
                reports={}, history=[])


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def initialize():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript((ROOT / 'sqlite/schema.sql').read_text())
        db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS app_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS auth_sessions (
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS login_attempts (
            bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at REAL NOT NULL);
        ''')
        db.execute('INSERT OR IGNORE INTO app_state VALUES(1,?,0)',
                   (json.dumps({'state': initial_state(), 'players': []}),))


def password_hash(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 600000, 32)
    return 'pbkdf2$' + salt.hex() + '$' + digest.hex()


def verify_password(password, encoded):
    try:
        kind, salt, expected = encoded.split('$')
        if kind == 'pbkdf2':
            digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600000, 32)
        elif kind == 'pbkdf2-legacy':
            digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 150000, 32)
        else:
            return False
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def valid_name(value):
    return (isinstance(value, str) and 0 < len(value) <= 40 and value.strip() == value
            and value not in ('__proto__', 'constructor', 'prototype') and not any(ord(c) < 32 for c in value))


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 9007199254740991:
        raise ApiError(400, 'PD・点数・回数は範囲内の整数で入力してください。')


def validate_payload(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('state'), dict):
        raise ApiError(400, '保存データを確認してください。')
    state, players = payload['state'], payload.get('players')
    if not isinstance(players, list) or len(players) > 100 or not all(valid_name(p) for p in players) or len(players) != len(set(players)):
        raise ApiError(400, '参加者一覧を確認してください。')
    for key in ('entries', 'busts', 'results', 'profiles', 'reports', 'seats', 'checkins'):
        if not isinstance(state.get(key), dict) or not all(valid_name(p) for p in state[key]):
            raise ApiError(400, 'プレイヤーデータを確認してください。')
    for key in ('entries', 'busts'):
        for number in state[key].values():
            integer(number)
    for key in ('results', 'reports'):
        for row in state[key].values():
            if not isinstance(row, dict):
                raise ApiError(400, '成績データを確認してください。')
            for field in ('chips', 'busts', 'payout', 'startStack'):
                if field in row:
                    integer(row[field], 1 if field == 'startStack' else 0)
    for profile in state['profiles'].values():
        if not isinstance(profile, dict) or not isinstance(profile.get('displayName', ''), str) or len(profile.get('displayName', '')) > 40:
            raise ApiError(400, 'プロフィールを確認してください。')
        photo = profile.get('photo', '')
        if not isinstance(photo, str) or len(photo) > 1500000 or (photo and not re.fullmatch(r'data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}', photo)):
            raise ApiError(400, 'プロフィール写真を確認してください。')
        if profile.get('style', 'エンジョイ勢') not in ('アグレッシブ', '堅実派', 'ブラフ好き', '初心者', 'エンジョイ勢'):
            raise ApiError(400, 'プレイスタイルを確認してください。')
    for field in ('remaining', 'dealerIndex', 'sb', 'bb'):
        integer(state.get(field, 0))
    integer(state.get('startStack'), 1)
    integer(state.get('dealerMinutes'), 1)
    if not isinstance(state.get('history'), list):
        raise ApiError(400, '開催履歴を確認してください。')
    for game in state['history']:
        if not isinstance(game, dict) or not isinstance(game.get('entries'), dict) or not isinstance(game.get('results'), dict):
            raise ApiError(400, '開催履歴を確認してください。')
        for number in game['entries'].values():
            integer(number)
        for row in game['results'].values():
            if not isinstance(row, dict):
                raise ApiError(400, '開催履歴を確認してください。')
            for field in ('payout', 'chips', 'busts', 'startStack'):
                if field in row:
                    integer(row[field], 1 if field == 'startStack' else 0)


def load_payload(db):
    row = db.execute('SELECT * FROM app_state WHERE singleton=1').fetchone()
    payload, revision = json.loads(row['payload']), row['revision']
    state, changed = payload['state'], False
    for name, seat in list(state.get('seats', {}).items()):
        if seat.get('day') != day():
            del state['seats'][name]
            state['checkins'][name] = False
            changed = True
    if state.get('seatInvite', {}).get('day', day()) != day():
        state.pop('seatInvite', None)
        changed = True
    if changed:
        state.update(started=False, paused=True, dealerIndex=0, remaining=state['dealerMinutes'] * 60)
        state.pop('timerEndsAt', None)
        revision += 1
        db.execute('UPDATE app_state SET payload=?,revision=? WHERE singleton=1', (json.dumps(payload), revision))
    if state.get('started') and not state.get('paused') and state.get('timerEndsAt'):
        state['remaining'] = max(0, math.ceil(state['timerEndsAt'] - time.time()))
    return payload, revision


def purge_player(payload, name):
    state = payload['state']
    payload['players'] = [p for p in payload['players'] if p != name]
    for key in ('entries', 'busts', 'results', 'profiles', 'checkins', 'seats', 'reports'):
        state[key].pop(name, None)
    for game in state['history']:
        game['entries'].pop(name, None)
        game['results'].pop(name, None)


class Handler(BaseHTTPRequestHandler):
    def json(self, status, value, cookie=None):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 16000000:
                raise ApiError(413, '送信データが大きすぎます。')
            value = json.loads(self.rfile.read(size))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise ApiError(400, '送信内容を確認してください。')

    def cookie_token(self):
        try:
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            return cookie['table_session'].value if 'table_session' in cookie else ''
        except Exception:
            return ''

    def user(self, db):
        token = self.cookie_token()
        if not token:
            return None
        return db.execute('''SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id
                             WHERE s.token_hash=? AND s.expires_at>?''',
                          (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()

    def require_user(self, db):
        user = self.user(db)
        if not user:
            raise ApiError(401, 'ログインし直してください。')
        return user

    def snapshot(self, db, user):
        if not user:
            return {'user': None, 'setupRequired': not db.execute('SELECT 1 FROM users LIMIT 1').fetchone()}
        payload, revision = load_payload(db)
        if user['role'] != 'admin':
            payload['state'].pop('seatInvite', None)
        accounts = {row['account_id']: {'role': row['role'], 'createdAt': row['created_at']}
                    for row in db.execute('SELECT account_id,role,created_at FROM users')}
        return dict(payload, user={'name': user['account_id'], 'role': user['role']}, accounts=accounts, revision=revision)

    def rate_limit(self, db, category='login', subject=''):
        bucket = category + ':' + self.client_address[0] + ':' + subject
        row = db.execute('SELECT * FROM login_attempts WHERE bucket=?', (bucket,)).fetchone()
        count = row['count'] if row and row['reset_at'] > time.time() else 0
        reset = row['reset_at'] if count else time.time() + 60
        if count >= (20 if category == 'seat' else 60):
            raise ApiError(429, '試行回数が多いため、1分ほど待ってください。')
        db.execute('INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)', (bucket, count + 1, reset))
        db.commit()
        db.execute('BEGIN IMMEDIATE')

    def login(self, db, data, register=False):
        import re
        self.rate_limit(db)
        name, password = data.get('id', '').strip().lower(), data.get('password', '')
        if not re.fullmatch(r'[a-z0-9_-]{3,20}', name) or not valid_name(name) or not isinstance(password, str) or not 8 <= len(password) <= 256:
            raise ApiError(400, 'IDは3〜20文字の半角英数字、パスワードは8〜256文字で入力してください。')
        user = db.execute('SELECT * FROM users WHERE account_id=?', (name,)).fetchone()
        if register:
            if user:
                raise ApiError(409, 'このIDはすでに使われています。')
            first = not db.execute('SELECT 1 FROM users LIMIT 1').fetchone()
            if first and not hmac.compare_digest(str(data.get('setupCode', '')), SETUP_CODE):
                raise ApiError(403, '初回管理者設定コードを確認してください。')
            db.execute('INSERT INTO users(id,account_id,password_hash,display_name,role) VALUES(?,?,?,?,?)',
                       (name, name, password_hash(password), name, 'admin' if first else 'player'))
            db.execute('UPDATE app_state SET revision=revision+1 WHERE singleton=1')
            user = db.execute('SELECT * FROM users WHERE account_id=?', (name,)).fetchone()
        elif not user or not verify_password(password, user['password_hash']):
            raise ApiError(401, 'IDまたはパスワードが違います。')
        elif user['password_hash'].startswith('pbkdf2-legacy$'):
            db.execute('UPDATE users SET password_hash=? WHERE id=?', (password_hash(password), user['id']))
        token = secrets.token_urlsafe(32)
        db.execute('DELETE FROM auth_sessions WHERE expires_at<?', (time.time(),))
        db.execute('INSERT INTO auth_sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), user['id'], time.time()+7*86400))
        cookie = 'table_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800' + ('; Secure' if COOKIE_SECURE else '')
        return self.snapshot(db, user), cookie

    def save(self, db, user, data):
        if data.get('seatToken'):
            self.rate_limit(db, 'seat', user['account_id'])
        old, revision = load_payload(db)
        if data.get('revision') != revision:
            raise ApiError(409, 'ほかの端末でデータが更新されました。再読み込みしてやり直してください。')
        if user['role'] == 'admin':
            payload = {'state': data.get('state'), 'players': data.get('players')}
            validate_payload(payload)
            if data.get('seatToken'):
                invite = old['state'].get('seatInvite', {})
                issuer = db.execute('SELECT role FROM users WHERE account_id=?', (invite.get('createdBy', ''),)).fetchone()
                if not issuer or issuer['role'] != 'admin' or invite.get('day') != day() or not hmac.compare_digest(str(data['seatToken']), invite.get('token', '')):
                    raise ApiError(403, '参加キーが無効か期限切れです。')
                name = user['account_id']
                payload['state']['seats'][name] = {'day': day(), 'joinedAt': datetime.now(timezone.utc).isoformat()}
                payload['state']['checkins'][name] = True
                if name not in payload['players']:
                    payload['players'].append(name)
                    payload['state']['entries'][name] = 0
            requested = data.get('accounts')
            if not isinstance(requested, dict) or requested.get(user['account_id'], {}).get('role') != 'admin':
                raise ApiError(400, '自分自身の管理者権限は解除・削除できません。')
            known = {row['account_id']: row for row in db.execute('SELECT * FROM users')}
            if set(requested) - set(known):
                raise ApiError(400, 'アカウントは登録画面から作成してください。')
            for name, record in known.items():
                if name not in requested:
                    purge_player(payload, name)
                    db.execute('DELETE FROM users WHERE id=?', (record['id'],))
                else:
                    role = requested[name].get('role')
                    if role not in ('admin', 'player'):
                        raise ApiError(400, '権限を確認してください。')
                    db.execute('UPDATE users SET role=? WHERE id=?', (role, record['id']))
            state, prev = payload['state'], old['state']
            if data.get('timerAction'):
                state['timerEndsAt'] = time.time() + state['remaining'] if state.get('started') and not state.get('paused') else None
            else:
                for key in ('remaining', 'timerEndsAt', 'started', 'paused', 'dealerIndex'):
                    if key in prev:
                        state[key] = prev[key]
            invite = state.get('seatInvite')
            if invite and invite != prev.get('seatInvite'):
                import re
                if invite.get('day') != day() or invite.get('createdBy') != user['account_id'] or not re.fullmatch('[A-HJ-NP-Z2-9]{8}', invite.get('token', '')):
                    raise ApiError(400, '参加キーの発行内容を確認してください。')
        else:
            payload = copy.deepcopy(old)
            state, name = payload['state'], user['account_id']
            proposed = data.get('state', {})
            protected = ('entries', 'results', 'history', 'sb', 'bb', 'startStack', 'dealerMinutes', 'chips')
            if 'seatInvite' in proposed:
                raise ApiError(403, '参加キーは管理者のみ発行できます。')
            if any(proposed.get(k) != old['state'].get(k) for k in protected):
                raise ApiError(403, 'PD・ゲーム設定の変更は管理者のみ可能です。')
            for key in ('profiles', 'busts', 'reports', 'seats', 'checkins'):
                before = {p: v for p, v in old['state'].get(key, {}).items() if p != name}
                after = {p: v for p, v in proposed.get(key, {}).items() if p != name}
                if before != after:
                    raise ApiError(403, '他のプレイヤーのデータは変更できません。')
            if data.get('accounts') != self.snapshot(db, user)['accounts']:
                raise ApiError(403, '権限・アカウントの変更は管理者のみ可能です。')
            token = data.get('seatToken')
            if token:
                invite = state.get('seatInvite', {})
                issuer = db.execute('SELECT role FROM users WHERE account_id=?', (invite.get('createdBy', ''),)).fetchone()
                if not issuer or issuer['role'] != 'admin' or invite.get('day') != day() or not hmac.compare_digest(str(token), invite.get('token', '')):
                    raise ApiError(403, '参加キーが無効か期限切れです。管理者に再発行してもらってください。')
                state['checkins'][name] = True
                state['seats'][name] = {'day': day(), 'joinedAt': datetime.now(timezone.utc).isoformat()}
                if name not in payload['players']:
                    payload['players'].append(name)
                    state['entries'][name] = 0
            elif proposed.get('seats') != state['seats'] or proposed.get('checkins') != state['checkins'] or data.get('players') != payload['players']:
                raise ApiError(403, '着席には管理者が発行した参加キーが必要です。')
            profile = proposed.get('profiles', {}).get(name)
            if profile is not None:
                state['profiles'][name] = profile
            seated = state['seats'].get(name, {}).get('day') == day() and state['checkins'].get(name)
            for key in ('busts', 'reports'):
                if proposed.get(key, {}).get(name) != state[key].get(name):
                    if not seated:
                        raise ApiError(403, '先に席に座ってください。')
                    state[key][name] = proposed[key][name]
                    if key == 'reports':
                        state[key][name]['status'] = 'pending'
            # Starting an idle dealer timer is available to seated players only.
            if proposed.get('started') and not state.get('started'):
                if not seated:
                    raise ApiError(403, 'タイマーの開始には着席が必要です。')
                state.update(started=True, paused=False, timerEndsAt=time.time()+state['remaining'])
            validate_payload(payload)
        payload['state']['prize'] = sum(payload['state']['entries'].get(p, 0) for p in payload['players'])
        db.execute('UPDATE app_state SET payload=?,revision=? WHERE singleton=1', (json.dumps(payload), revision+1))
        return self.snapshot(db, self.require_user(db))

    def api(self, method):
        path = urlsplit(self.path).path
        try:
            if method != 'GET':
                expected = PUBLIC_ORIGIN or ('http://' + self.headers.get('Host', ''))
                if self.headers.get('Origin') != expected:
                    raise ApiError(403, '同じサイトから操作してください。')
                if not self.headers.get('Content-Type', '').startswith('application/json'):
                    raise ApiError(415, 'JSON形式で送信してください。')
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                cookie = None
                if method == 'GET' and path == '/api/session':
                    result = self.snapshot(db, self.user(db))
                elif method == 'POST' and path in ('/api/login', '/api/register'):
                    result, cookie = self.login(db, self.body(), path.endswith('register'))
                elif method == 'POST' and path == '/api/logout':
                    db.execute('DELETE FROM auth_sessions WHERE token_hash=?', (hashlib.sha256(self.cookie_token().encode()).hexdigest(),))
                    result, cookie = {}, 'table_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + ('; Secure' if COOKIE_SECURE else '')
                elif method == 'PUT' and path == '/api/state':
                    result = self.save(db, self.require_user(db), self.body())
                elif method == 'POST' and path == '/api/seat-code':
                    user = self.require_user(db)
                    if user['role'] != 'admin':
                        raise ApiError(403, '参加キーは管理者のみ発行できます。')
                    data = self.body()
                    payload, revision = load_payload(db)
                    invite = payload['state'].get('seatInvite')
                    issuer = db.execute('SELECT role FROM users WHERE account_id=?', (invite.get('createdBy', ''),)).fetchone() if invite else None
                    if data.get('renew') or not invite or not issuer or issuer['role'] != 'admin':
                        code = ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(8))
                        payload['state']['seatInvite'] = {'token': code, 'day': day(), 'createdBy': user['account_id']}
                        db.execute('UPDATE app_state SET payload=?,revision=? WHERE singleton=1', (json.dumps(payload), revision+1))
                    result = self.snapshot(db, user)
                else:
                    raise ApiError(404, 'この操作は見つかりません。')
            self.json(200, result, cookie)
        except ApiError as error:
            self.json(error.status, {'error': error.message})
        except (sqlite3.Error, TypeError, ValueError, KeyError, AttributeError):
            self.json(500, {'error': '保存に失敗しました。入力内容を確認して再度お試しください。'})

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            return self.api('GET')
        if path == '/assets/runtime-config.js':
            data = b'window.TABLE_SHARED = true;'
            content_type = 'text/javascript'
        else:
            if path in ('/', '/index.html'):
                target = ROOT / 'index.html'
            elif path.startswith('/assets/'):
                target = (ROOT / path.lstrip('/')).resolve()
                if not target.is_relative_to(ROOT / 'assets'):
                    return self.send_error(404)
            else:
                return self.send_error(404)
            if not target.is_file():
                return self.send_error(404)
            import mimetypes
            data = target.read_bytes()
            content_type = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.api('POST')

    def do_PUT(self):
        self.api('PUT')

    def log_message(self, fmt, *args):
        # Do not log credentials, cookies or QR tokens.
        print('%s %s' % (self.client_address[0], fmt % args))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    if args.host not in ('127.0.0.1', 'localhost') and not PUBLIC_ORIGIN.startswith('https://'):
        parser.error('外部公開にはTABLE_PUBLIC_ORIGIN（HTTPS公開URL）を設定してください。')
    initialize()
    with connect() as db:
        if not db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
            print('初回管理者設定コード: ' + SETUP_CODE, flush=True)
    print('TABLE: http://%s:%s' % (args.host, args.port), flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
