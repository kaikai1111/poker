# TABLE — GitHub公開版

GitHub Pagesで画面を公開し、Supabaseでアカウント・着席・成績を共有する構成です。QRではなく、管理者が発行する当日限りの8文字の参加キーで着席します。

**公開の初期設定は [GITHUB_SETUP.md](GITHUB_SETUP.md) を参照してください。** `main` にpushすると画面が自動更新され、共有APIはGitHub ActionsからSupabaseに公開できます。GitHub Pagesだけではデータ共有・安全な認証はできないため、Supabaseプロジェクトの初期設定が必要です。実際の公開先への接続・デプロイは未実施です。

通貨名は **ポーカードル（PD）**。現金への換金・賞品への交換ができないゲーム内専用通貨です。表示は `1,000 PD`、成績は「回収PD − 投入PD」で計算します。名称変更に伴う数値の変換・既存記録の削除は行いません。保存済みの `entries` / `payout` はそのままPDとして扱います。

## SQLite版をローカルで使う場合（代替）

Python 3.9以上で、プロジェクトのフォルダーから実行します。追加パッケージは不要です。

```sh
python3 server.py
```

表示された `http://127.0.0.1:8080` を開きます。最初の管理者を作る際だけ、起動時に表示された「初回管理者設定コード」が必要です。友達のアカウント作成にはIDとパスワードだけを使用します。

ファイルを直接開いた場合は従来のブラウザ内保存の試作版です。SQLiteサーバーではログイン・権限・参加キーの検証をサーバーで行い、HttpOnly Cookieによるセッションを使用します。パスワードはランダムsalt付きPBKDF2-SHA256（600,000回）で保存します。GitHub公開版はSupabase Authとサーバー側の権限確認を使う別構成です。

## SQLite版の仕組み

- SQLiteの `users` がアカウントと管理者権限を保存します。
- `app_state` が現在のゲームと開催履歴を保存します。既存画面との互換性のためJSONを保存し、revisionで同時更新の上書きを防ぎます。既存の正規化されたゲーム用テーブルへはまだ書き込んでいません。
- 管理者だけが参加キーの発行、PD・成績の編集、アカウント削除、管理者付与・解除をできます。
- 一般プレイヤーは自分のプロフィール・飛び回数・持ち点申告のみ変更できます。
- 参加キーの検証と当日着席はサーバー側で実行します。キーは管理者以外へのAPIレスポンスに含めません。
- 日本時間の翌日0時で着席と参加キーが失効します。閉じたアプリでは、次のAPIアクセス時に失効を反映します。PD記録・開催履歴は削除しません。
- 開いている画面は10秒ごとに更新を確認します。入力中・ダイアログ表示中の自動反映は保留します。

## SQLite版を外部公開する場合

GitHubはソース管理先であり、このSQLiteサーバーの実行先にはなりません。実行できるサーバー、HTTPSの公開URL、永続ストレージが必要です。

```sh
TABLE_PUBLIC_ORIGIN=https://your-domain.example \
TABLE_DB_PATH=/persistent-data/table.sqlite3 \
TABLE_SETUP_CODE=your-private-bootstrap-code \
python3 server.py --host 0.0.0.0 --port 8080
```

このHTTPサーバーは小規模な試作用です。外部公開時はHTTPSのリバースプロキシの背後に配置し、SQLiteファイルとWALを含む適切なバックアップを設定してください。SQLiteを一つのプロセス群で共有する構成を前提にしており、複数の独立したインスタンスへ分散しないでください。公開サーバーへの配置は未実施です。

このブラウザに保存済みの古い試作データは消しません。共有サーバーへは自動で移しません。移行が必要な場合はデータを確認してから取り込みます。

## LINEミニアプリ

LINEミニアプリはLIFF上のWebアプリで、技術的にはこの画面を利用できます。ただし現時点でLINE Developersのチャネル作成、LIFF SDK連携、LINEユーザー識別、公開設定は実装・実施していません。

[LINEミニアプリ化の手順](LINE_MINI_APP.md)を参照してください。用途は換金・賞品交換のないポーカードルによる成績管理です。名称や画面表示を変えるだけで公開条件を満たすわけではありません。[LINEミニアプリポリシー](https://terms2.line.me/LINE_MINI_App?lang=ja)は未認証ミニアプリにも適用され、公開可否は提供元の判断によります。

## テスト

```sh
python3 -m unittest discover -s tests -p 'test_server.py'
osascript -l JavaScript tests/app-data.test.js /absolute/project/path
osascript -l JavaScript tests/cloud-policy.test.js /absolute/project/path
```

GitHubのTest TABLEワークフローでは、Supabase APIの型チェック、権限ポリシーのテスト、PostgreSQLでのSQL・権限テスト、静的公開ファイルへの秘密キー混入防止も確認します。
