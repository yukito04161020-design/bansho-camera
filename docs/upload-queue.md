# 送信待ちと再送のロジック（Issue #15）

`public/upload-queue.js`は送信待ちの管理、`public/upload-store.js`はIndexedDBを担当します。
画面とGoogleへのアクセスは含みません。撮影・保存先の選択・認証が決まった後の本実装で、
送信関数と表示側を接続してください。

## 呼び出し方

```js
import { createUploadQueue, UploadFailure } from "./upload-queue.js";
import { initializeUpdates } from "./app-update.js";

// 呼び出した直後にIndexedDBの件数読み込みを更新機能へ登録する。
const opening = createUploadQueue({
  upload: async ({ id, blob, className, sessionFolderName, capturedAt }) => {
    // 本実装で送信する。認証情報はこの関数の外側のメモリ内だけで扱う。
    // 成功が確認できた場合だけ return { ok: true };
    // 認証切れは throw new UploadFailure("authentication");
    // その他は return { ok: false, reason: "network" } など。
    return { ok: false, reason: "upload" }; // この例は送信せず保存したまま待つ。
  },
});
initializeUpdates(/* 既存の撮影・画像確認の状態を読む関数 */);
const queue = await opening;
const unsubscribe = queue.subscribe(({ pendingCount, status, reason, nextRetryAt }) => {
  // 後続のIssueで日本語の画面へ反映する。画像そのものは購読情報に含めない。
});
await queue.enqueue({ blob: imageBlob, className: "数学", sessionFolderName: "第01回_2026-09-30", capturedAt: Date.now() });
// IndexedDBの保存完了で戻る。送信完了を待たず次の撮影へ進める。
// 認証の取り直しが完了した後だけ await queue.resumeAfterAuthentication();
// 使用を終える時: unsubscribe(); await queue.dispose();
```

- `enqueue`は非空の`image/*` Blob、非空の授業名と回フォルダ名、撮影日時を受け取ります。
  日時はDate、Unixミリ秒、タイムゾーン付き日時文字列で、保存はUnixミリ秒に統一します。
  フォルダ名の提案・検証はIssue #14の呼び出し元で行います。
  保存するフィールドは限定し、引数の余分な情報をコピーしません。
- 送信関数は**成功の確認後だけ**`{ ok: true }`を返してください。
  `{ ok: false, reason }`または`UploadFailure(reason)`で失敗を通知できます。
  理由は`network`、`server`、`permission`、`authentication`、`upload`の5分類です。
  未知の応答・通常の例外・外部エラー本文は`upload`にまとめ、詳細を保存しません。
  本モジュールは送信関数に画像と宛先と安定したローカルIDだけを渡します。
- `subscribe`は登録時と変更時に件数・状態・理由・次の再送時刻を通知し、解除関数を返します。
  `pendingCount: null`は件数不明です。状態は`waiting`、`sending`、`authentication-required`。
  保存領域の異常は`reason: "storage"`。表示側の例外で送信を止めません。
- `count()`はIndexedDBの件数、`snapshot()`は最後の購読状態を返します。
  `retry()`は現在送れるものを再確認しますが、再送待ち時刻と認証待ちを飛ばしません。
  `resumeAfterAuthentication()`だけが保存済みの認証待ちを解除します。
- `dispose()`はイベントとタイマーを解除し、進行中の1件の結果を記録してから接続を閉じます。
  保存済みの画像は消しません。終了後の件数取得は失敗して更新を保留するため、
  次のコントローラを作成して読み込み関数を登録し直してください。

## 保存と送信の規則

IndexedDBの`bansho-camera-uploads`（版1）に、Blob・宛先・撮影時刻・試行回数・最後の失敗分類・
次の再送時刻を保存します。認証待ちも別ストアに保存し、開き直しても維持します。
保存完了はリクエストの成功ではなくトランザクションの完了で判定します。
保存できなかった場合は`enqueue`がエラーになるので、呼び出し元で撮影画像を保持してください。

撮影時刻が古い順、同時刻なら保存順で1件ずつ送信します。先頭の失敗を飛ばして後続を送りません。
送信前に試行回数を保存し、成功した1件だけを削除します。停止・終了時にも画像は残ります。
通常の失敗は1秒、2秒、4秒…最大60秒待ちます。`baseDelay`・`maximumDelay`で変更できます。
待ち時刻は保存するので、再起動で待ち時間をリセットしません。
DB操作が失敗した場合は画像を残して待機し、前面なら最大間隔後に読み込みを再試行します。

送信が先方で成功してから応答を失った場合や、端末内の削除が失敗した場合は、再送で重複し得ます。
外部送信関数はローカルIDを使うなど、重複の確認・防止を本実装で扱ってください。
このIssueだけで通信越しの「必ず1回」を保証しません。

起動、`online`、前面への`visibilitychange`、`pageshow`で再確認します。
裏やオフラインでは新しい送信を開始せず、タイマーも予約しません。途中で裏へ移った場合は
進行中の1件の結果だけを記録し、次の1件は前面に戻るまで待ちます。裏の処理継続に依存しません。

同じDBはWeb Locksで排他制御し、複数タブ・複数コントローラの同時送信を避けます。
Web Locks非対応の場合は`locking-unavailable`として保存したまま待機します。
本番はHTTPS、開発はlocalhostで利用してください。
Safariでは15.4でWeb Locksが追加されています（[WebKitの公開情報](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)）。

## Issue #4との接続・確認

`createUploadQueue`はDBを開く前に`registerPendingUploadCounter`へ実際の件数取得を登録します。
**同じページで更新機能より先に呼ぶ**必要があります。DBを開く間は読み込み完了を待ち、
取得失敗時は0を返さずエラーにするので更新を保留します。
このIssueでは既存の検証ページを送信機能へ接続せず、画面変更を含めません。

`npm ci`・`npm test`で保存、接続の開き直し、順番、再送間隔、認証待ち、オンライン・前面復帰、
排他制御、件数購読と更新保留、保存・削除トランザクション中断を検証します。
Node.jsにはIndexedDBがないため、[fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB)を
テスト専用の開発依存にしました。実際の保存コードを通し、独自のメモリリストによる代替を避けます。
公開物には依存・テスト・画像ファイルを追加しません。テストBlobは実行時に文字列から作ります。

このIssueの受け入れ条件には実機項目はありません。本実装へ接続した後、iPhoneで保存容量不足、
アプリの終了・再起動、送信中の通信断・認証切れと復帰を確認してください。
