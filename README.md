# 板書撮影アプリ

授業の板書をiPhoneで無音撮影し、Googleドライブの授業ごと・回ごとのフォルダへ保存するWebアプリ（PWA）です。個人用です。

- 設計書：[docs/design.md](docs/design.md)
- AIエージェント向けの約束事：[AGENTS.md](AGENTS.md)
- 送信待ちと再送のロジック：[docs/upload-queue.md](docs/upload-queue.md)

## 開発の土台（Issue #2）

ホーム画面に追加できるPWAの土台です。Issue #3のカメラ検証用の試作も用意しています。

公開URL：<https://yukito04161020-design.github.io/bansho-camera/>
（この変更がmainにマージされ、Pagesへの公開が成功した後に利用できます。）

### ローカルでの確認

Node.js 24を使います（`.nvmrc`に指定）。

```sh
npm ci
npm test
```

テストはNode.js標準の`node:test`と`node:assert/strict`で実行します。
IndexedDBのテスト専用に`fake-indexeddb`を`npm ci`で導入します（公開物には含めません）。
`examples/add.js`と`tests/add.test.js`が、画面に依存しない関数とテストの最小例です。
後続のロジックのテストも`tests/`に`*.test.js`として追加できます。

画面は`public/`を静的HTTPサーバーで配信して確認します。
たとえばPython 3がある場合は、リポジトリのルートで以下を実行し、
`http://localhost:8000/`を開きます。このサーバーは開発時だけ使います。

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory public
```

### ファイルと設定

- `public/`：編集用のHTML、CSS、JavaScript、manifest、仮アイコン、設定。
- `dist/`：`npm run build`で版番号を埋め込んだPages公開用の出力（Gitには含めません）。
- `public/config.js`：公開してよい設定値の置き場所。Issue #1のGoogleクライアントIDを設定しています。
- `examples/`、`tests/`、`docs/`：Pagesの配信対象には含めません。

APIキー、クライアントシークレット、トークン、パスワードを設定ファイルやアプリに書かないでください。
仮アイコンは図形だけで作成しており、板書の画像は含みません。
URLは相対指定なので、Pagesの`/bansho-camera/`以下でも読み込めます。

ホーム画面からの起動はmanifestの`standalone`とSafari向けのメタ情報で指定しています。
この段階ではService Workerやオフライン用キャッシュを導入していません。
版番号の表示と起動時の更新については、[版番号と更新](docs/app-updates.md)を参照してください。

### 自動テストと公開

- PRを作成・更新すると、`Tests`ワークフローが`npm ci`と`npm test`を実行し、PRに結果を表示します。
- mainへのマージ（push）で、`Deploy to GitHub Pages`ワークフローが同じテストを実行します。
  成功したときだけ公開対象コミットの版番号を埋め込み、`dist/`を`github-pages`環境へ公開します。
- リポジトリのSettings → Pages → Sourceは`GitHub Actions`に設定してください。
  公開には組み込みのGitHubトークンを使うため、追加の秘密情報は不要です。

### マージ後のiPhone実機チェック

1. GitHubのActionsで、mainの`Deploy to GitHub Pages`が成功していることを確認する。
2. iPhoneのSafariで公開URLを開き、「板書カメラ」が表示されることを確認する。
3. 共有メニュー →「ホーム画面に追加」を選ぶ。「Webアプリとして開く」が表示される場合はオンにする。
4. ホーム画面の仮アイコンから起動し、Safariのアドレスバーやツールバーが表示されないことを確認する。
5. 縦向き・横向きで文字が画面の切り欠きに隠れず表示されることを確認する。

実機での確認結果はPRに記録してください。画面の版番号が公開対象コミットと一致することも確認します。

## 無音撮影の解像度検証（Issue #3）

ホーム画面から「カメラの解像度を検証する」を開き、カメラを開始して
「1コマを撮影」を押すと、切り出した画像を等倍で確認できます。
実際に取得した映像のサイズを画面に表示します。
要求の設定、iPhoneでの確認手順、Issueへ記録する結果のテンプレートは
[解像度検証の手順](docs/camera-resolution-test.md)にまとめています。

## レンズ・ズームの検証（Issue #9）

同じ検証ページで、許可後のカメラ一覧から背面レンズを選び、対応する場合は
ズームを操作できます。カメラ名・現在倍率を表示し、選択を端末内に記憶します。
iPhoneでの確認手順と記録用テンプレートは
[レンズ・ズーム検証の手順](docs/camera-zoom-test.md)にまとめています。

## Googleログインと維持の検証（Issue #6）

トップページから「Googleログインを検証する」を開けます。
Google Identity Servicesでdrive.fileだけを許可し、ログイン後に検証用テキストを
ドライブへ作成します。取得時刻・期限の表示と、トークンを取り直すボタンを用意しています。
トークンはメモリ内だけに保持し、画面を閉じると破棄します。
この検証ページではGoogleの公式スクリプトを通信で読み込みます。
手順と結果テンプレートは[Googleログイン検証](docs/google-login-test.md)にあります。
