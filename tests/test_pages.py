import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from scripts.build_pages import build


class PagesBuildTest(unittest.TestCase):
    def test_public_artifact_contains_no_server_or_db(self):
        with tempfile.TemporaryDirectory(prefix='table-pages-test-') as directory:
            output = Path(directory)
            with patch.dict(os.environ, {'SUPABASE_URL': 'https://test.supabase.co', 'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_test'}):
                build(output)
            self.assertTrue((output / 'index.html').exists())
            self.assertIn('TABLE_SHARED = true', (output / 'assets/runtime-config.js').read_text())
            self.assertFalse((output / 'server.py').exists())
            self.assertFalse((output / 'data').exists())
            self.assertFalse((output / 'supabase').exists())

    def test_secret_keys_and_missing_config_are_rejected(self):
        secret_jwt = 'header.' + base64.urlsafe_b64encode(json.dumps({'role': 'service_role'}).encode()).decode().rstrip('=') + '.signature'
        for key in ('', 'sb_secret_private', secret_jwt):
            with tempfile.TemporaryDirectory(prefix='table-pages-test-') as directory:
                with patch.dict(os.environ, {'SUPABASE_URL': 'https://test.supabase.co', 'SUPABASE_PUBLISHABLE_KEY': key}):
                    with self.assertRaises(ValueError):
                        build(Path(directory))


if __name__ == '__main__':
    unittest.main()
