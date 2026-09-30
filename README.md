# 板書撮影アプリ

授業の板書をiPhoneで無音撮影し、Googleドライブの授業ごと・回ごとのフォルダへ保存するWebアプリ（PWA）です。個人用です。

- 設計書：[docs/design.md](docs/design.md)
- AIエージェント向けの約束事：[AGENTS.md](AGENTS.md)

## 開発の土台（Issue #2）

現在はホーム画面に追加できる空の画面だけです。カメラ、ログイン、保存は後続のIssueで実装します。

公開URL：<https://yukito04161020-design.github.io/bansho-camera/>
（この変更がmainにマージされ、Pagesへの公開が成功した後に利用できます。）

### ローカルでの確認

Node.js 24を使います（`.nvmrc`に指定）。

```sh
npm ci
npm test
```

テストはNode.js標準の`node:test`と`node:assert/strict`で実行します。
外部ライブラリのインストールやビルドは不要です。
`examples/add.js`と`tests/add.test.js`が、画面に依存しない関数とテストの最小例です。
後続のロジックのテストも`tests/`に`*.test.js`として追加できます。

画面は`public/`を静的HTTPサーバーで配信して確認します。
たとえばPython 3がある場合は、リポジトリのルートで以下を実行し、
`http://localhost:8000/`を開きます。このサーバーは開発時だけ使います。

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory public
```

### ファイルと設定

- `public/`：そのままPagesへ公開するHTML、CSS、manifest、仮アイコン、設定。
- `public/config.js`：公開してよい設定値の置き場所。GoogleクライアントIDは現在空欄です。
- `examples/`、`tests/`、`docs/`：Pagesの配信対象には含めません。

APIキー、クライアントシークレット、トークン、パスワードを設定ファイルやアプリに書かないでください。
仮アイコンは図形だけで作成しており、板書の画像は含みません。
URLは相対指定なので、Pagesの`/bansho-camera/`以下でも読み込めます。

ホーム画面からの起動はmanifestの`standalone`とSafari向けのメタ情報で指定しています。
この段階ではService Workerやオフライン用キャッシュを導入していません。
版番号の表示と更新の仕組みはIssue #4（設計書4.7、フェーズ1）で扱います。

### 自動テストと公開

- PRを作成・更新すると、`Tests`ワークフローが`npm ci`と`npm test`を実行し、PRに結果を表示します。
- mainへのマージ（push）で、`Deploy to GitHub Pages`ワークフローが同じテストを実行します。
  成功したときだけ`public/`をアップロードし、`github-pages`環境へ公開します。
- リポジトリのSettings → Pages → Sourceは`GitHub Actions`に設定してください。
  公開には組み込みのGitHubトークンを使うため、追加の秘密情報は不要です。

### マージ後のiPhone実機チェック

1. GitHubのActionsで、mainの`Deploy to GitHub Pages`が成功していることを確認する。
2. iPhoneのSafariで公開URLを開き、「板書カメラ」「ただいま準備中です。」が表示されることを確認する。
3. 共有メニュー →「ホーム画面に追加」を選ぶ。「Webアプリとして開く」が表示される場合はオンにする。
4. ホーム画面の仮アイコンから起動し、Safariのアドレスバーやツールバーが表示されないことを確認する。
5. 縦向き・横向きで文字が画面の切り欠きに隠れず表示されることを確認する。

実機での確認結果はPRに記録してください。版番号はIssue #4で追加するため、今回は表示されません。
