import test from "node:test";
import assert from "node:assert/strict";
import { createDriveUpload } from "../public/drive-upload.js";
import { TokenSession, driveFileScope } from "../public/login-logic.js";
import { UploadFailure, createUploadQueue } from "../public/upload-queue.js";
import { IDBFactory } from "fake-indexeddb";

const item = { id: 1, blob: new Blob(["synthetic-bytes"], { type: "image/jpeg" }), className: "数学",
  sessionFolderName: "第01回_2026-10-02", capturedAt: Date.parse("2026-10-02T10:00:00+09:00"), driveFileId: null };
const name = "板書_2026-10-02T01-00-00-000Z_1.jpg";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const metadata = { id: "image_id", name, mimeType: "image/jpeg", size: String(item.blob.size), parents: ["folder_id"] };
const reason = (value) => (error) => error instanceof UploadFailure && error.reason === value;
function fixture(hook) {
  const session = new TokenSession(() => 0);
  session.accept({ access_token: "synthetic-only", token_type: "Bearer", expires_in: 3600, scope: driveFileScope });
  const calls = [];
  const savedIds = [];
  let active = true;
  const folders = { async ensureSessionFolder(selection) {
    assert.deepEqual(selection, { className: "数学", capturedAt: item.capturedAt, manualSession: 1 });
    return { name: item.sessionFolderName, folderId: "folder_id" };
  } };
  const fetcher = async (address, options) => {
    const url = new URL(address);
    calls.push({ url, options });
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic-only");
    const override = await hook?.(url, options, calls, session);
    if (override) return override;
    if (url.pathname.endsWith("generateIds")) return json({ ids: ["image_id"] });
    if (url.pathname === "/drive/v3/files/image_id") return json({}, 404);
    if (options.method === "POST") {
      assert.ok(savedIds.includes("image_id"), "POST前にIDの保存を確認する");
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { id: "image_id", name, mimeType: "image/jpeg", parents: ["folder_id"] });
      return new Response(null, { headers: { Location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic" } });
    }
    assert.equal(options.method, "PUT");
    assert.equal(options.body, item.blob);
    return json(metadata);
  };
  return { session, calls, savedIds, folders, setActive: (value) => { active = value; },
    uploader: createDriveUpload({ session, folders, fetcher, isActive: () => active }),
    persistDriveFileId: async (id) => { savedIds.push(id); } };
}

test("IDの永続化後にresumableを開始し、JPEGと保存先・サイズを確認して成功を返す", async () => {
  const f = fixture();
  assert.deepEqual(await f.uploader(item, { persistDriveFileId: f.persistDriveFileId }), { ok: true });
  assert.deepEqual(f.savedIds, ["image_id"]);
  assert.deepEqual(f.calls.map((call) => call.options.method || "GET"), ["GET", "GET", "POST", "PUT"]);
});

test("IDを保存できなければフォルダ作成・画像送信を始めない", async () => {
  const f = fixture();
  f.folders.ensureSessionFolder = () => assert.fail("永続化失敗時は保存先を作らない");
  await assert.rejects(f.uploader(item, { persistDriveFileId: async () => { throw new Error("sensitive-test-value"); } }), reason("upload"));
  assert.equal(f.calls.length, 1);
});

test("保存済みIDで成功済みファイルを再確認し、再生成・再送しない", async () => {
  const f = fixture(() => json(metadata));
  assert.deepEqual(await f.uploader({ ...item, driveFileId: "image_id" }), { ok: true });
  assert.equal(f.calls.length, 1);
});

test("409だけでは成功扱いせず、同じIDのファイルが一致する場合だけ成功にする", async () => {
  for (const bad of [false, true]) {
    const f = fixture((url, options, calls) => {
      if (options.method === "POST") return json({}, 409);
      if (url.pathname === "/drive/v3/files/image_id" && calls.length > 2) return json({ ...metadata, ...(bad ? { parents: ["wrong_folder"] } : {}) });
    });
    if (bad) await assert.rejects(f.uploader(item, { persistDriveFileId: f.persistDriveFileId }), reason("upload"));
    else assert.deepEqual(await f.uploader(item, { persistDriveFileId: f.persistDriveFileId }), { ok: true });
    assert.equal(f.calls.some((call) => call.options.method === "PUT"), false);
  }
});

test("成功応答でもID・名前・種類・サイズ・親・ゴミ箱状態の不一致は失敗にする", async () => {
  for (const override of [{ id: "wrong" }, { name: "wrong" }, { mimeType: "text/plain" }, { size: "0" },
    { parents: [] }, { parents: ["folder_id", "another"] }, { trashed: true }]) {
    const f = fixture(() => json({ ...metadata, ...override }));
    await assert.rejects(f.uploader({ ...item, driveFileId: "image_id" }), reason("upload"));
  }
});

test("アップロードURLが別ホスト・別パス・認証情報付きなら画像とトークンを送らない", async () => {
  for (const address of ["https://other.invalid/upload", "https://www.googleapis.com/wrong?upload_id=x",
    "https://user:secret@www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x",
    "http://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x", "not-a-url"]) {
    const f = fixture((url, options) => options.method === "POST" ? new Response(null, { headers: { Location: address } }) : undefined);
    await assert.rejects(f.uploader(item, { persistDriveFileId: f.persistDriveFileId }), reason("upload"));
    assert.equal(f.calls.some((call) => call.options.method === "PUT"), false);
  }
});

test("401・期限切れ・通信断・403・429・5xxを分類し、外部のエラーを漏らさない", async () => {
  for (const [status, expected] of [[401, "authentication"], [403, "permission"], [429, "server"], [503, "server"]]) {
    const f = fixture(() => json({ secret: "sensitive-test-value" }, status));
    await assert.rejects(f.uploader(item, { persistDriveFileId: f.persistDriveFileId }), (error) => {
      assert.ok(reason(expected)(error)); assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes("sensitive-test-value"), false); return true;
    });
    if (status === 401) assert.equal(f.session.snapshot().status, "invalid");
  }
  const expired = fixture(); expired.session.clear();
  await assert.rejects(expired.uploader(item, { persistDriveFileId: expired.persistDriveFileId }), reason("authentication"));
  assert.equal(expired.calls.length, 0);
  const failed = fixture(() => { throw new Error("sensitive-test-value"); });
  await assert.rejects(failed.uploader(item, { persistDriveFileId: failed.persistDriveFileId }), reason("network"));
});

test("裏へ移る・中断する・セッションを取り直すと後続の画像送信を開始しない", async () => {
  const hidden = fixture(() => { hidden.setActive(false); return json({ ids: ["image_id"] }); });
  await assert.rejects(hidden.uploader(item, { persistDriveFileId: hidden.persistDriveFileId }), reason("network"));
  assert.equal(hidden.calls.length, 1);
  const controller = new AbortController(); controller.abort();
  const stopped = fixture();
  await assert.rejects(stopped.uploader(item, { signal: controller.signal, persistDriveFileId: stopped.persistDriveFileId }), reason("network"));
  assert.equal(stopped.calls.length, 0);
  const renewed = fixture((url, options, calls, session) => {
    session.accept({ access_token: "new-synthetic", token_type: "Bearer", expires_in: 3600, scope: driveFileScope });
    return json({}, 401);
  });
  await assert.rejects(renewed.uploader(item, { persistDriveFileId: renewed.persistDriveFileId }), reason("authentication"));
  assert.equal(renewed.session.snapshot().status, "valid");
});

test("IndexedDBと送信待ちを開き直しても、応答消失後は同じDrive IDを再利用する", async () => {
  const indexedDB = new IDBFactory();
  let uploaded = false;
  const f = fixture((url, options) => {
    if (options.method === "PUT") { uploaded = true; throw new Error("lost response"); }
    if (url.pathname === "/drive/v3/files/image_id" && uploaded) return json(metadata);
  });
  const document = new EventTarget(); document.visibilityState = "visible";
  const locks = { request: async (name, options, callback) => (callback || options)({}) };
  const options = { indexedDB, document, window: new EventTarget(), navigator: { onLine: true }, locks,
    upload: (queued, context) => f.uploader(queued, { persistDriveFileId: async (id) => {
      await context.persistDriveFileId(id);
      await f.persistDriveFileId(id);
    } }), setTimer: () => 1, clearTimer: () => {}, now: () => 0 };
  const first = await createUploadQueue(options);
  await first.enqueue(item);
  await first.retry();
  assert.equal(await first.count(), 1);
  await first.dispose();
  const second = await createUploadQueue({ ...options, now: () => 10000 });
  await second.retry();
  assert.equal(await second.count(), 0);
  assert.equal(f.calls.filter((call) => call.url.pathname.endsWith("generateIds")).length, 1);
  assert.equal(f.calls.filter((call) => call.options.method === "PUT").length, 1);
  await second.dispose();
});
