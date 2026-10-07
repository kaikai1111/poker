import copy
import http.client
import json
import pathlib
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server


class Client:
    def __init__(self, port):
        self.port, self.cookie = port, ''

    def call(self, method, path, data=None, origin=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        headers = {'Cookie': self.cookie}
        if data is not None:
            headers['Content-Type'] = 'application/json'
            if origin:
                headers['Origin'] = 'http://127.0.0.1:%s' % self.port
        conn.request(method, path, json.dumps(data) if data is not None else None, headers)
        response = conn.getresponse()
        if response.getheader('Set-Cookie'):
            self.cookie = response.getheader('Set-Cookie').split(';')[0]
        result = response.read()
        status = response.status
        conn.close()
        return status, json.loads(result)

    def session(self):
        status, data = self.call('GET', '/api/session')
        assert status == 200, data
        return data

    def save(self, snapshot, **options):
        return self.call('PUT', '/api/state', dict(snapshot, **options))


class SharedServerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='table-api-test-')
        server.DB_PATH = str(pathlib.Path(self.temp.name) / 'test.sqlite3')
        server.SETUP_CODE = 'test-setup'
        server.PUBLIC_ORIGIN = ''
        server.initialize()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.admin = Client(self.http.server_port)
        self.player = Client(self.http.server_port)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def register(self):
        self.assertEqual(self.admin.call('POST', '/api/register', {'id': 'alice', 'password': 'password123', 'setupCode': 'test-setup'})[0], 200)
        self.assertEqual(self.player.call('POST', '/api/register', {'id': 'bob', 'password': 'password456'})[0], 200)

    def test_shared_accounts_seating_and_roles(self):
        self.assertTrue(self.admin.session()['setupRequired'])
        self.assertEqual(self.admin.call('POST', '/api/register', {'id': 'alice', 'password': 'password123'})[0], 403)
        self.register()
        admin = self.admin.session()
        self.assertEqual(admin['accounts']['bob']['role'], 'player')
        self.assertNotIn('password_hash', json.dumps(admin))
        self.assertEqual(self.player.call('POST', '/api/seat-code', {})[0], 403)
        status, admin = self.admin.call('POST', '/api/seat-code', {})
        self.assertEqual(status, 200)
        code = admin['state']['seatInvite']['token']
        self.assertEqual(len(code), 8)
        player = self.player.session()
        self.assertNotIn('seatInvite', player['state'])
        self.assertEqual(self.player.save(player, seatToken='ZZZZZZZZ')[0], 403)
        status, player = self.player.save(self.player.session(), seatToken=code)
        self.assertEqual(status, 200)
        self.assertTrue(self.admin.session()['state']['checkins']['bob'])
        status, _ = self.admin.save(self.admin.session(), seatToken=code)
        self.assertEqual(status, 200)
        admin = self.admin.session()
        admin['accounts']['bob']['role'] = 'admin'
        self.assertEqual(self.admin.save(admin)[0], 200)
        self.assertEqual(self.player.session()['user']['role'], 'admin')
        admin = self.admin.session()
        admin['accounts']['bob']['role'] = 'player'
        self.assertEqual(self.admin.save(admin)[0], 200)
        self.assertEqual(self.player.session()['user']['role'], 'player')
        self.assertEqual(self.player.call('POST', '/api/seat-code', {})[0], 403)

    def test_server_permissions_and_conflicts(self):
        self.register()
        status, admin = self.admin.call('POST', '/api/seat-code', {})
        status, player = self.player.save(self.player.session(), seatToken=admin['state']['seatInvite']['token'])
        self.assertEqual(status, 200)
        original = copy.deepcopy(player)
        player['state']['entries']['bob'] = 99999
        self.assertEqual(self.player.save(player)[0], 403)
        player = self.player.session()
        player['accounts']['bob']['role'] = 'admin'
        self.assertEqual(self.player.save(player)[0], 403)
        player = self.player.session()
        player['state']['profiles']['alice'] = {'displayName': 'hacked'}
        self.assertEqual(self.player.save(player)[0], 403)
        player = self.player.session()
        player['state']['busts']['bob'] = 1
        self.assertEqual(self.player.save(player)[0], 200)
        self.assertEqual(self.player.save(original)[0], 409)
        self.assertEqual(self.player.call('PUT', '/api/state', self.player.session(), origin=False)[0], 403)
        admin = self.admin.session()
        admin['accounts']['alice']['role'] = 'player'
        self.assertEqual(self.admin.save(admin)[0], 400)

    def test_midnight_persistence_and_logout(self):
        self.register()
        status, admin = self.admin.call('POST', '/api/seat-code', {})
        status, _ = self.player.save(self.player.session(), seatToken=admin['state']['seatInvite']['token'])
        admin = self.admin.session()
        admin['state']['entries']['bob'] = 1000
        admin['state']['results']['bob'] = {'payout': 1500, 'chips': 500, 'busts': 1, 'startStack': 1000}
        self.assertEqual(self.admin.save(admin)[0], 200)
        with server.connect() as db:
            row = db.execute('SELECT payload FROM app_state').fetchone()
            data = json.loads(row['payload'])
            data['state']['seats']['bob']['day'] = '2000-01-01'
            data['state']['seatInvite']['day'] = '2000-01-01'
            db.execute('UPDATE app_state SET payload=?', (json.dumps(data),))
        player = self.player.session()
        self.assertFalse(player['state']['checkins']['bob'])
        self.assertEqual(player['state']['entries']['bob'], 1000)
        self.assertEqual(player['state']['results']['bob']['payout'], 1500)
        self.assertEqual(self.player.call('POST', '/api/logout', {})[0], 200)
        self.assertIsNone(self.player.session()['user'])
        self.assertEqual(self.player.save(player)[0], 401)
        # Reopening the database, rather than browser localStorage, retains records.
        with server.connect() as db:
            self.assertEqual(json.loads(db.execute('SELECT payload FROM app_state').fetchone()['payload'])['state']['entries']['bob'], 1000)

    def test_key_rotation_timer_and_account_deletion(self):
        self.register()
        _, first = self.admin.call('POST', '/api/seat-code', {})
        key = first['state']['seatInvite']['token']
        _, same = self.admin.call('POST', '/api/seat-code', {})
        self.assertEqual(same['state']['seatInvite']['token'], key)
        _, renewed = self.admin.call('POST', '/api/seat-code', {'renew': True})
        self.assertNotEqual(renewed['state']['seatInvite']['token'], key)
        self.assertEqual(self.player.save(self.player.session(), seatToken=key)[0], 403)
        _, player = self.player.save(self.player.session(), seatToken=renewed['state']['seatInvite']['token'])
        player['state']['started'], player['state']['paused'] = True, False
        self.assertEqual(self.player.save(player, timerAction=True)[0], 200)
        admin = self.admin.session()
        self.assertGreater(admin['state']['timerEndsAt'], 0)
        self.assertFalse(admin['state']['paused'])
        admin['state']['paused'] = True
        self.assertEqual(self.admin.save(admin, timerAction=True)[0], 200)
        self.assertTrue(self.player.session()['state']['paused'])
        admin = self.admin.session()
        del admin['accounts']['bob']
        self.assertEqual(self.admin.save(admin)[0], 200)
        self.assertIsNone(self.player.session()['user'])
        self.assertNotIn('bob', self.admin.session()['state']['seats'])
        self.assertNotIn('bob', self.admin.session()['players'])

    def test_static_routes_do_not_expose_database(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.http.server_port)
        conn.request('GET', '/assets/runtime-config.js')
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn(b'TABLE_SHARED = true', response.read())
        for path in ('/server.py', '/data/table.sqlite3', '/assets/../server.py'):
            conn.request('GET', path)
            response = conn.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
        conn.close()


if __name__ == '__main__':
    unittest.main()
