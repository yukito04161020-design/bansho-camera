import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { captureDestination, captureSettings, saveCapturedImage } from "../public/capture-save.js";
import { openUploadStore } from "../public/upload-store.js";

const blob = new Blob(["synthetic-only"], { type: "image/jpeg" });
const destination = { className: "数学", sessionFolderName: "第02回_2026-10-02", capturedAt: Date.parse("2026-10-02T00:00:00+09:00") };

test("撮影時の授業・回・日本時間を固定し、手動指定と別日の衝突を検証する", () => {
  const input = { className: "数学", existingNames: ["第01回_2026-10-01"], capturedAt: "2026-10-01T15:00:00Z" };
  assert.deepEqual(captureDestination(input), destination);
  assert.equal(captureDestination({ ...input, manualSession: 7 }).sessionFolderName, "第07回_2026-10-02");
  assert.throws(() => captureDestination({ ...input, manualSession: 1 }), (error) => error.reason === "collision");
});

test("JPEG変換を待つ間に選択を変えても宛先を変えず、保存完了を待って戻る", async () => {
  let convert;
  let complete;
  let enqueued;
  const mutable = { ...destination };
  const canvas = { width: 1920, height: 1080, toBlob(callback, type, quality) {
    assert.equal(type, "image/jpeg"); assert.equal(quality, 0.95); convert = callback;
  } };
  const saving = saveCapturedImage({ canvas, destination: mutable, enqueue: (item) => {
    enqueued = item;
    return new Promise((resolve) => { complete = resolve; });
  } });
  mutable.className = "別授業";
  mutable.capturedAt += 86400000;
  convert(blob);
  await Promise.resolve();
  assert.deepEqual(enqueued, { ...destination, blob });
  let finished = false;
  saving.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  complete(5);
  assert.equal(await saving, 5);
});

test("JPEG化・端末内保存の失敗では成功を返さず、元のcanvasを消さない", async () => {
  for (const value of [null, new Blob([], { type: "image/jpeg" }), new Blob(["x"], { type: "image/png" })]) {
    const canvas = { width: 1920, height: 1080, toBlob: (callback) => callback(value) };
    await assert.rejects(saveCapturedImage({ canvas, destination, enqueue: () => assert.fail("変換失敗時は保存しない") }));
    assert.equal(canvas.width, 1920);
  }
  const canvas = { width: 1920, height: 1080, toBlob: (callback) => callback(blob) };
  await assert.rejects(saveCapturedImage({ canvas, destination, enqueue: async () => { throw new Error("storage"); } }));
  assert.equal(canvas.width, 1920);
});

test("授業設定は必要なフィールドだけを保存し、認証情報を複製しない", async () => {
  const indexedDB = new IDBFactory();
  const store = await openUploadStore({ indexedDB });
  const input = { classes: ["数学", "数学"], lessons: [{ className: "数学", names: ["第01回_2026-10-01"], token: "omit" }],
    selectedClass: "数学", accessToken: "omit", uploadUrl: "omit" };
  assert.deepEqual(captureSettings(input), { classes: ["数学"], lessons: [{ className: "数学", names: ["第01回_2026-10-01"] }], selectedClass: "数学" });
  await store.writeCaptureSettings(input);
  store.close();
  const reopened = await openUploadStore({ indexedDB });
  assert.deepEqual(await reopened.readCaptureSettings(), captureSettings(input));
  assert.equal(JSON.stringify(await reopened.readCaptureSettings()).includes("omit"), false);
  reopened.close();
});

test("Drive IDは既存レコードへ永続化し、上書きや不正IDを拒否する", async () => {
  const indexedDB = new IDBFactory();
  const store = await openUploadStore({ indexedDB });
  const id = await store.add({ ...destination, blob });
  await store.setDriveFileId(id, "generated_id");
  await store.setDriveFileId(id, "generated_id");
  await assert.rejects(store.setDriveFileId(id, "another_id"));
  assert.throws(() => store.setDriveFileId(id, "bad/id"));
  await assert.rejects(store.setDriveFileId(id + 10, "generated_id"));
  store.close();
  const reopened = await openUploadStore({ indexedDB });
  const state = await reopened.snapshot();
  assert.equal(state.head.driveFileId, "generated_id");
  assert.equal(state.head.blob.size, blob.size);
  assert.deepEqual(await reopened.pendingDestinations(), [{ className: "数学", sessionFolderName: "第02回_2026-10-02" }]);
  reopened.close();
});

test("撮影画面を離れても起動時の更新判定はIndexedDBの未送信件数を読む", async () => {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  try {
    const store = await openUploadStore();
    await store.add({ ...destination, blob });
    store.close();
    // 新しいページのモジュールを想定し、queueの件数関数を登録する前に確認する。
    const { readPendingUploadCount } = await import("../public/app-update.js?startup-counter");
    assert.equal(await readPendingUploadCount(), 1);
  } finally {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  }
});

test("授業未選択で撮影した画像を残し、選択するまで保存せず、撮影日時で宛先を確定する", async () => {
  const { createCapturedDraft } = await import("../public/capture-save.js");
  let selected = false;
  const draft = createCapturedDraft(destination.capturedAt, (capturedAt) => {
    if (!selected) throw new Error("授業未選択");
    return captureDestination({ className: "数学", existingNames: ["第01回_2026-10-01"], capturedAt });
  });
  const canvas = { width: 1920, height: 1080, toBlob: (callback) => callback(blob) };
  assert.equal(draft.destination, null);
  await assert.rejects(saveCapturedImage({ canvas, destination: draft.resolve(), enqueue: () => assert.fail("未選択では保存しない") }), /保存前に授業/);
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);
  selected = true;
  assert.deepEqual(draft.resolve(), destination);
  let item;
  await saveCapturedImage({ canvas, destination: draft.destination, enqueue: (value) => { item = value; } });
  assert.deepEqual(item, { ...destination, blob });
  selected = false;
  assert.equal(draft.resolve(), null);
  const fixed = createCapturedDraft(destination.capturedAt, () => ({ ...destination }));
  assert.deepEqual(fixed.resolve(), destination);
});

test("撮影不可のすべての状態に日本語の理由を返し、撮影可能なら空にする", async () => {
  const { captureDisabledReason } = await import("../public/capture-save.js");
  const ready = { ready: true };
  assert.equal(captureDisabledReason(ready), "");
  for (const state of [{ starting: true }, { hidden: true }, { ready: false }, { zoomApplying: true }, { blocked: true }]) {
    assert.match(captureDisabledReason({ ...ready, ...state }), /[ぁ-んァ-ヶ一-龠]/);
  }
  assert.equal(captureDisabledReason({ ...ready, blocked: "画像を保存しています。" }), "画像を保存しています。");
});
