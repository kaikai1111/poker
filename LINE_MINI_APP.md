# TABLEをLINEミニアプリにする手順

確認日：2026-10-07。現時点ではLINEとの連携・LINE側への登録・インターネット公開はしていません。

## 先に確認すること

ポーカードル（PD）は現金への換金・賞品への交換ができないゲーム内専用通貨です。ゲームを現金の勝敗や精算に使用しない前提です。単に通貨名を変更して規約を回避することはできません。LINEミニアプリポリシーにはギャンブル関連の制限があるため、換金のないゲームでもサービスの内容に基づく確認が必要です。未認証ミニアプリでも規約は適用されます。[公式ポリシー](https://terms2.line.me/LINE_MINI_App?lang=ja)

## 1. 共有版をHTTPSで公開する

推奨構成はGitHub PagesとSupabaseです。[GitHub公開の初期設定](GITHUB_SETUP.md)を行い、GitHub Actionsで公開します。画面はGitHub PagesのHTTPS URL、共有データとログイン処理はSupabaseに配置します。

公開後はブラウザを2つ使ってログイン、参加キー、PD記録の共有を確認してください。ローカルのSQLite版も代替として残していますが、GitHub PagesでそのPythonサーバーは動かせません。

## 2. LINE Developersでミニアプリ用の設定を作る

1. [LINE Developersコンソール](https://developers.line.biz/console/)へログインする。
2. サービスの運営者としてプロバイダーを作成、または選択する。
3. ［新規チャネル作成］から［LINEミニアプリ］を選ぶ。
4. 提供地域に「日本」を選び、アプリ名・説明・運営者情報などを実際の内容で登録する。
5. 規約とポリシーを確認してチャネルを作成する。

「チャネル」は、このWebアプリとLINEをつなぐ設定です。ビジネスIDでミニアプリを作成できない場合は、そのIDとLINEアカウントの連携を確認してください。[公式作成手順](https://developers.line.biz/ja/docs/line-mini-app/develop/develop-overview/)

サービス説明の例（実際の提供内容と一致する場合のみ使用）：

> 友人同士のポーカーの参加受付と成績を管理するアプリです。ゲーム内専用のポーカードル（PD）を使用し、現金への換金・賞品への交換は行いません。

## 3. 公開URLを登録してLIFF IDを確認する

チャネルの［ウェブアプリ設定］で、公開したHTTPSのURLをエンドポイントURLに設定します。エンドポイントURLとは、LINEから開くアプリの実際のURLです。開発用・審査用・本番用の内部チャネルにはそれぞれLIFF IDがあるため、対象を取り違えないでください。[コンソールガイド](https://developers.line.biz/ja/docs/line-mini-app/discover/console-guide/)

GitHub公開版では、共有APIはSupabase Edge Functionへ接続します。GitHub Pages上にPythonやSQLiteを置く必要はありません。リポジトリ名を含む公開URL（例：`https://ユーザー名.github.io/リポジトリ名/`）を正確に設定してください。

## 4. アプリにLIFF SDKを組み込む

LINE用のJavaScriptライブラリ「LIFF SDK」を読み込み、ページごとに `liff.init({ liffId: '対象のLIFF ID' })` を呼ぶ実装を追加します。現在のプロジェクトにはこの処理はまだありません。[公式実装ガイド](https://developers.line.biz/ja/docs/liff/developing-liff-apps/)

現在のID・パスワード方式を維持してLINE内で開く構成と、LINEアカウントでアプリにログインする構成は別です。後者を選ぶ場合はLINEのトークンをサーバー側で検証してユーザーを識別し、既存アカウントとの連携も設計します。クライアントから渡されたLINEユーザーIDだけで本人確認や管理者付与をしてはいけません。LINE Developersの管理権限と、TABLEアプリ内の管理者権限も別物です。

SDKの読み込み・初期化が失敗した場合はタイムアウトとエラー表示を用意し、ローディングを残さないようにします。LIFF初期化前にLINEが付けたURLパラメーターを書き換えないでください。

## 5. LINE内で実機テストする

開発用のLIFF URLをスマホのLINEで開き、ログイン、参加キーでの着席、プロフィール写真、PD追加・記録、管理者権限、翌日の自動退席を確認します。開発用チャネルでは権限を付与されて承認したテスターだけが利用できます。友達にも開発用を試してもらう場合は、LINE Developers側でテスター登録してください。[内部チャネル・テスターの説明](https://developers.line.biz/ja/docs/line-mini-app/discover/console-guide/)

## 6. 未認証ミニアプリとして使う／認証審査を依頼する

公式手順ではチャネル作成後、未認証ミニアプリとして利用可能になります。友達に共有する場合は、コンソールで本番用の公開データ・URLと反映された設定を確認し、本番用のLIFF URLを使います。未認証だから利用規約が免除されるわけではありません。

認証済ミニアプリにする場合は、必要な運営者情報、アイコン、プライバシー説明・利用規約などを整え、公式の認証審査を依頼します。審査通過後の認証済ミニアプリでのみ利用できる機能もあります。[開発から公開までの公式案内](https://developers.line.biz/ja/docs/line-mini-app/quickstart/)

## 次に用意するもの

- GitHub PagesのHTTPS公開URLと、初期設定済みのSupabaseプロジェクト
- LINE Developersのチャネルと、開発用／本番用のLIFF ID
- アプリの運営者情報と、取得するデータ・使用目的・問い合わせ先の説明

チャネルシークレットやパスワードはチャットや公開リポジトリに貼らないでください。LIFF IDは公開可能な識別子ですが、シークレットとは別です。
