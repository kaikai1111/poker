"""Build only static public assets. Never package databases or server secrets."""
import json
import os
from pathlib import Path
import shutil
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def build(output):
    url = os.environ.get('SUPABASE_URL', '').strip().rstrip('/')
    key = os.environ.get('SUPABASE_PUBLISHABLE_KEY', '').strip()
    if not url:
        raise ValueError('SUPABASE_URLが実行環境に届いていません。Repository variablesとpages.ymlのenvを確認してください。')
    try:
        parsed = urlsplit(url)
        valid_url = parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and not parsed.path and not any(c.isspace() for c in url)
    except ValueError:
        valid_url = False
    if not valid_url:
        raise ValueError('SUPABASE_URLの形式が違います。https://ogqorpaqxyuyslpoguxl.supabase.co の文字列だけを入力してください。Markdownのリンク・引用符・dashboardのURLは使えません。')
    if not key:
        raise ValueError('SUPABASE_PUBLISHABLE_KEYが実行環境に届いていません。Repository variablesとpages.ymlのenvを確認してください。')
    if key.startswith('sb_secret_'):
        raise ValueError('秘密キーは公開できません。Publishable keyを使用してください。')
    # Also reject the old JWT-form service_role key.
    if key.count('.') == 2:
        import base64
        try:
            claims = json.loads(base64.urlsafe_b64decode(key.split('.')[1] + '==='))
        except (ValueError, UnicodeError):
            raise ValueError('公開キーの形式を確認してください。')
        if claims.get('role') != 'anon':
            raise ValueError('service_roleキーは公開できません。anonキーを使用してください。')
    elif not key.startswith('sb_publishable_'):
        raise ValueError('SupabaseのPublishable keyまたはanonキーを使用してください。')
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'index.html', output / 'index.html')
    shutil.copytree(ROOT / 'assets', output / 'assets', dirs_exist_ok=True)
    config = dict(url=url, key=key)
    (output / 'assets/runtime-config.js').write_text('window.TABLE_SHARED = true;\nwindow.TABLE_SUPABASE = ' + json.dumps(config) + ';\n')
    (output / '.nojekyll').touch()


if __name__ == '__main__':
    build(ROOT / 'dist')

