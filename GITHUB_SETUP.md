# GitHubから公開する（推奨）

画面はGitHub Pages、共有データとログイン処理はSupabaseに置きます。Pythonサーバーの契約・運用は不要です。GitHub Pages単体では共有データベースや安全なパスワード検証を実行できません。

公開先への実際の接続・デプロイはまだしていません。以下の初期設定が必要です。

## 1. Supabaseのプロジェクトを一つ作る

[Supabase](https://supabase.com/dashboard)で自分のプロジェクトを作成します。SQL Editorで [setup.sql](supabase/setup.sql) を実行してください。既存のローカル保存データは移行せず残します。

Authenticationの設定で、一般向けの「Allow new users to sign up」をオフにしてください。本アプリの共有APIがサーバー側でアカウントを作成するため、アプリのID・パスワード登録は利用できます。この設定は、外部からAuth APIを直接使った登録を防ぐためです。内部の認証用識別子は `ID@table.invalid` ですが、利用者のメールアドレスを収集したり、確認メールを送ったりはしません。メールによるパスワード復旧はできません。

次の値を確認します。

- Project URL（例：`https://xxxx.supabase.co`）
- Publishable key（`sb_publishable_...`）。旧anonキーも使用可能
- Project Reference ID
- SupabaseアカウントのPersonal Access Token（Edge Functionの公開用。秘密情報）

料金や利用条件は利用時のサービス表示を確認してください。プロジェクトを作っただけで利用可能になるわけではなく、SQLとAPIの公開も必要です。

## 2. GitHubへこのフォルダーの内容を上げる

`main` ブランチを使います。隠しフォルダー `.github` も含めて上げてください。`.env`、データベース、秘密キーはアップロードしません。

リポジトリの Settings → Secrets and variables → Actions で設定します。

### Variables（公開してよい設定）

| 名前 | 値 |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key、またはanonキー |
| `SUPABASE_PROJECT_REF` | Project Reference ID |

### Secrets（非公開の設定）

| 名前 | 値 |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | SupabaseのPersonal Access Token |
| `TABLE_SETUP_CODE` | 自分で決める長いランダムな初回管理者設定コード |

`service_role` や `sb_secret_...` は公開用Variablesに入れないでください。ビルドでもこれらの秘密キーを検出して拒否します。API用のservice-roleキーはSupabase Edge Functionの環境にあり、HTMLへ配布しません。

## 3. GitHubから共有APIを公開する

リポジトリのActionsでテスト結果を確認し、**Publish shared API to Supabase** → **Run workflow** を実行します。APIのコードと初回設定コードがSupabaseへ配置されます。以降、共有APIを変更した時もこの操作で更新します。

Edge FunctionのゲートウェイJWT検証は公開のアカウント作成・ログインを可能にするため無効にしています。ただし、保護されたAPIでは関数内部でAuthトークンを検証し、DB上の最新権限を確認します。ブラウザからDBテーブルや特権RPCを直接操作できないようRLSと権限も制限しています。

## 4. GitHub Pagesを有効にする

Settings → Pages → Build and deployment → Source を **GitHub Actions** にします。

Actionsで **Publish TABLE to GitHub Pages** → **Run workflow** を実行してください。以後は `main` にpushするたびに画面が自動更新されます。完了するとPagesに公開URLが表示されます。

公開するファイルは `index.html` と `assets` だけです。サーバーコード、SQLite、SQL、GitHubのSecretsは公開用の成果物に含めません。

## 5. 最初の管理者と友達のアカウントを作る

公開URLを開き「アカウント作成」でID・パスワードを決めます。最初の一人だけ、GitHub Secretsに設定した `TABLE_SETUP_CODE` を入力します。最初の管理者が作成された後、友達はID・パスワードだけで登録できます。

管理者は「設定」から参加キーを表示し、友達はホームでキーを入力して着席します。PD記録や管理者付与・解除が別のスマホにも反映されることを確認してください。

削除したアカウントは無効化され、既存のAuthトークンでもアプリのAPIを使えなくなります。Auth側のアカウントは監査・安全な無効化のため保持するので、削除したIDの再登録はできません。

## LINEミニアプリにするとき

このGitHub Pagesの公開URLをLINE DevelopersのエンドポイントURLとして登録できます。LIFF SDK連携はまだ追加していません。[LINEミニアプリ手順](LINE_MINI_APP.md)を参照してください。

参考：[GitHub Pagesのカスタムワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Supabase Edge Functionsの公開](https://supabase.com/docs/guides/functions/deploy)、[管理APIによるアカウント作成](https://supabase.com/docs/reference/javascript/auth-admin-createuser)。
