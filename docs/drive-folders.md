# Driveフォルダ操作（Issue #20）

`public/drive-folders.js`は、Issue #14の命名規則とDrive API v3を接続します。
画面やカメラにはまだ接続していません。実際の画像送信も行いません。
認証には既存の`TokenSession`を渡し、リクエストごとに有効期限を確認します。
認証スコープは既存の`drive.file`のままです。トークンの延長や永続保存は行いません。

```js
import { createDriveFolders } from "./drive-folders.js";

// sessionは既存のログイン処理で認証済みのTokenSession。
const folders = createDriveFolders({ session });
const selection = { className: "数学Ⅰ", capturedAt: "2026-10-02T10:00:00+09:00" };
const classes = await folders.listClasses(); // [{ id, name }]。作成しない。
const suggested = await folders.suggestSession(selection); // { name, folderId }。作成しない。
const destination = await folders.ensureSessionFolder(selection); // 不足する階層を作る。
// { name: "第01回_2026-10-02", folderId: "..." }
```

手動変更は`selection.manualSession`に回数を渡します。命名・同日再利用・休講・
日本時間・別日の回との衝突は`folder-logic.js`が判定します。
`folderId: null`は提案先が未作成であることを表します。
通信の中断は各メソッドの第2引数（`listClasses`では第1引数）に`{ signal }`を渡します。

## 検索と作成

マイドライブ直下の「板書」、その直下の授業、さらにその直下の回を扱います。
親ID・フォルダのMIME型・ゴミ箱除外・名前の完全一致で検索します。
名前の引用符とバックスラッシュはクエリ内でエスケープし、URLSearchParamsで符号化します。
一覧は空ページでも次のページがあれば読み続け、全件を得てから回を決めます。
不完全な検索、壊れた応答、循環するページ、途中の通信失敗は「存在しない」と扱いません。

同じ親の同名フォルダが複数あれば`ambiguous`で停止します。勝手にIDを選ばず、
Drive上で名前を変えるなどして整理してから再操作してください。
授業一覧では命名規則に反する授業名を除外します。
アプリを入れ直しても端末内のIDを前提にせず、既存をDriveから検索します。
drive.fileで見える範囲に限るため、アプリに許可していない手作業のフォルダは対象になりません。

同じインスタンス内の`ensureSessionFolder`は直列で処理します。
結果不明のPOSTを内部で繰り返さず、再操作では必ず一覧から検索し直します。
Driveにはフォルダ名の一意制約がないので、別タブ・別端末からの同時作成や、
作成直後にまだ検索へ反映されない場合の重複まで防ぐ保証はありません。
画面統合時はIssue #15の送信処理の排他制御の中で呼び出し、
裏に回った際は新しい処理を始めず、必要ならsignalで中断してください。

## 失敗と確認

`DriveFolderError.reason`は`authentication`（未認証・期限切れ・401）、
`permission`（403）、`server`（429・5xx）、`network`（通信失敗）、
`response`（不正な応答など）、`incomplete`、`ambiguous`、`cancelled`です。
401ではセッションを無効にします。外部エラー本文・例外のcause・トークンは返しません。
入力不正や回の衝突は既存の`FolderNameError`です。

`node --test tests/drive-folders.test.js`で実際の通信をせず検証します。
既存再利用、不足階層、全ページ、日本時間と手動変更、重複、引用符、
認証・HTTP失敗・中断、同時依頼、応答消失後の再操作を確認します。
依存と画像の追加はありません。

このPR単独では公開画面に変化がないため、iPhoneからこの処理は呼び出せません。
保存画面への統合後に、初回作成・同日の再利用・別日の次回・手動変更・
アプリを開き直した際の回の復元を、DriveとiPhoneの両方で確認してください。
実際の認証とDriveの権限・通信は、その段階で確認します。

参考：[フォルダ作成と親の指定](https://developers.google.com/workspace/drive/api/guides/folder)、
[検索クエリ](https://developers.google.com/workspace/drive/api/guides/search-files)、
[files.listのページ分割・不完全検索](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)。
