import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openUploadStore, QueueStorageError } from "../public/upload-store.js";
import { createUploadQueue, retryDelay, UploadFailure } from "../public/upload-queue.js";
import { readPendingUploadCount } from "../public/app-update.js";
import { createUpdateChecker } from "../public/update-policy.js";

const image = (capturedAt = 1000) => ({
  blob: new Blob(["synthetic test payload"], { type: "image/jpeg" }),
  className: "数学", sessionFolderName: "第01回_2026-09-30", capturedAt,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// ブラウザ境界の代替。IDB本体にはfake-indexeddbを使い、実装の保存処理を通す。
function lockManager() {
  const active = new Map();
  return { async request(name, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    while (active.has(name)) {
      if (options.ifAvailable) return callback(null);
      await active.get(name).promise;
    }
    const held = deferred();
    active.set(name, held);
    try { return await callback({ name }); }
    finally { active.delete(name); held.resolve(); }
  } };
}

async function setup(t, options = {}) {
  const indexedDB = options.indexedDB || new IDBFactory();
  const document = new EventTarget();
  document.visibilityState = options.visible ? "visible" : "hidden";
  const window = new EventTarget();
  const navigator = { onLine: true };
  let clock = 10000;
  let timerId = 0;
  const timers = new Map();
  const queue = await createUploadQueue({
    indexedDB, locks: lockManager(), document, window, navigator,
    now: () => clock,
    setTimer: (callback, delay) => { timers.set(++timerId, { callback, at: clock + delay }); return timerId; },
    clearTimer: (id) => timers.delete(id),
    upload: async () => ({ ok: true }),
    ...options,
  });
  t.after(() => queue.dispose());
  await queue.retry();
  return {
    queue, indexedDB, document, window, navigator, timers,
    async foreground() { document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange")); await queue.retry(); },
    async advance(milliseconds) {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
      await queue.retry();
    },
    now: () => clock,
  };
}

test("IndexedDBにBlobと宛先を保存し、新しい接続から同じデータを読み込める", async () => {
  const indexedDB = new IDBFactory();
  const first = await openUploadStore({ indexedDB });
  const id = await first.add({ ...image("2026-09-30T09:00:00+09:00"), extraneous: "保存しない" });
  first.close();
  const second = await openUploadStore({ indexedDB });
  try {
    const state = await second.snapshot();
    assert.equal(state.pendingCount, 1);
    assert.equal(state.head.id, id);
    assert.equal(await state.head.blob.text(), "synthetic test payload");
    assert.equal(state.head.blob.type, "image/jpeg");
    assert.equal(state.head.className, "数学");
    assert.equal(state.head.sessionFolderName, "第01回_2026-09-30");
    assert.equal(state.head.capturedAt, Date.parse("2026-09-30T00:00:00Z"));
    assert.equal(state.head.attempts, 0);
    assert.equal("extraneous" in state.head, false);
  } finally { second.close(); }
});

test("撮影日時が古い順に1件ずつ送り、同時刻は保存順で成功したものだけ消す", async (t) => {
  const order = [];
  let concurrent = 0;
  let maximum = 0;
  const sample = await setup(t, { upload: async (item) => {
    maximum = Math.max(maximum, ++concurrent);
    order.push(item.id);
    await Promise.resolve();
    concurrent -= 1;
    return { ok: true };
  } });
  const newest = await sample.queue.enqueue(image(3000));
  const oldest = await sample.queue.enqueue(image(1000));
  const equal = await sample.queue.enqueue(image(1000));
  await sample.foreground();
  assert.deepEqual(order, [oldest, equal, newest]);
  assert.equal(maximum, 1);
  assert.equal(await sample.queue.count(), 0);
});

test("失敗した画像を残し、先頭を飛ばさず指数バックオフ後に再送する", async (t) => {
  const calls = [];
  let success = false;
  const sample = await setup(t, { maximumDelay: 4000, upload: async (item) => {
    calls.push(item.id);
    return success ? { ok: true } : { ok: false, reason: "network" };
  } });
  const first = await sample.queue.enqueue(image(1000));
  const second = await sample.queue.enqueue(image(2000));
  await sample.foreground();
  assert.deepEqual(calls, [first]);
  const inspect = await openUploadStore({ indexedDB: sample.indexedDB });
  t.after(() => inspect.close());
  assert.equal((await inspect.snapshot()).head.attempts, 1);
  assert.equal((await inspect.snapshot()).head.lastFailure, "network");
  assert.equal((await inspect.snapshot()).head.nextRetryAt, 11000);
  assert.equal(await sample.queue.count(), 2);
  await sample.advance(999);
  assert.equal(calls.length, 1);
  await sample.advance(1);
  assert.equal((await inspect.snapshot()).head.nextRetryAt, 13000);
  await sample.advance(2000);
  assert.equal((await inspect.snapshot()).head.nextRetryAt, 17000);
  await sample.advance(4000);
  assert.equal((await inspect.snapshot()).head.nextRetryAt, 21000);
  assert.equal((await inspect.snapshot()).head.attempts, 4);
  success = true;
  await sample.advance(4000);
  assert.deepEqual(calls, [first, first, first, first, first, second]);
  assert.equal(await sample.queue.count(), 0);
});

test("再送待ち時刻と回数は開き直しても保持され、起動時に期限後のものを送る", async (t) => {
  const indexedDB = new IDBFactory();
  const first = await setup(t, { indexedDB, upload: async () => ({ ok: false, reason: "server" }) });
  const id = await first.queue.enqueue(image());
  await first.foreground();
  await first.queue.dispose();
  const calls = [];
  const second = await setup(t, { indexedDB, visible: true, upload: async (item) => { calls.push(item.id); return { ok: true }; } });
  assert.equal(await second.queue.count(), 1);
  assert.deepEqual(calls, []);
  await second.advance(1000);
  assert.deepEqual(calls, [id]);
  assert.equal(await second.queue.count(), 0);
});

test("認証切れを保存して停止し、オンライン・前面復帰・開き直しでも認証待ちを維持する", async (t) => {
  const indexedDB = new IDBFactory();
  const first = await setup(t, { indexedDB, upload: async () => { throw new UploadFailure("authentication"); } });
  const id = await first.queue.enqueue(image());
  await first.foreground();
  assert.equal(first.queue.snapshot().status, "authentication-required");
  assert.equal(first.timers.size, 0);
  assert.equal(await first.queue.count(), 1);
  await first.queue.dispose();
  const calls = [];
  const second = await setup(t, { indexedDB, visible: true, upload: async (item) => { calls.push(item.id); return { ok: true }; } });
  second.window.dispatchEvent(new Event("online"));
  await second.foreground();
  await second.advance(60000);
  assert.deepEqual(calls, []);
  assert.equal(second.queue.snapshot().status, "authentication-required");
  await second.queue.resumeAfterAuthentication();
  assert.deepEqual(calls, [id]);
  assert.equal(await second.queue.count(), 0);
});

test("失敗理由は固定の分類だけを保存し、外部エラーの本文・不明な応答を成功扱いしない", async (t) => {
  for (const upload of [async () => { throw new Error("外部APIの詳細メッセージ"); }, async () => ({ ok: false, reason: "未知の理由" }), async () => undefined]) {
    const sample = await setup(t, { upload });
    await sample.queue.enqueue(image());
    await sample.foreground();
    const inspect = await openUploadStore({ indexedDB: sample.indexedDB });
    try {
      assert.equal((await inspect.snapshot()).head.lastFailure, "upload");
      assert.equal(await sample.queue.count(), 1);
      assert.equal(sample.queue.snapshot().reason, "upload");
    } finally { inspect.close(); }
  }
});

test("裏・オフラインでは送らず、onlineとvisibilitychangeとpageshowで再開する", async (t) => {
  let calls = 0;
  const sample = await setup(t, { upload: async () => { calls += 1; return { ok: true }; } });
  await sample.queue.enqueue(image());
  assert.equal(calls, 0);
  sample.navigator.onLine = false;
  await sample.foreground();
  assert.equal(calls, 0);
  sample.navigator.onLine = true;
  sample.window.dispatchEvent(new Event("online"));
  await sample.queue.retry();
  assert.equal(calls, 1);
  sample.document.visibilityState = "hidden";
  sample.document.dispatchEvent(new Event("visibilitychange"));
  await sample.queue.enqueue(image());
  sample.window.dispatchEvent(new Event("pageshow"));
  await sample.queue.retry();
  assert.equal(calls, 1);
  await sample.foreground();
  assert.equal(calls, 2);
});

test("送信中に裏へ移ったら、その1件の結果だけ保存し次の送信を止める", async (t) => {
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  const sample = await setup(t, { upload: async () => {
    calls += 1;
    started.resolve();
    await gate.promise;
    return { ok: true };
  } });
  await sample.queue.enqueue(image(1));
  await sample.queue.enqueue(image(2));
  sample.document.visibilityState = "visible";
  const run = sample.queue.retry();
  await started.promise;
  assert.equal(sample.queue.snapshot().status, "sending");
  sample.document.visibilityState = "hidden";
  sample.document.dispatchEvent(new Event("visibilitychange"));
  gate.resolve();
  await run;
  assert.equal(calls, 1);
  assert.equal(await sample.queue.count(), 1);
  await sample.foreground();
  assert.equal(calls, 2);
});

test("送信中に追加・再開が重なっても同時送信せず、保存完了でenqueueが戻る", async (t) => {
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  let active = 0;
  const sample = await setup(t, { upload: async () => {
    assert.equal(++active, 1);
    calls += 1;
    started.resolve();
    await gate.promise;
    active -= 1;
    return { ok: true };
  } });
  await sample.queue.enqueue(image(1));
  sample.document.visibilityState = "visible";
  const run = sample.queue.retry();
  await started.promise;
  await sample.queue.enqueue(image(2));
  sample.queue.retry();
  sample.window.dispatchEvent(new Event("online"));
  assert.equal(await sample.queue.count(), 2);
  assert.equal(calls, 1);
  gate.resolve();
  await run;
  assert.equal(calls, 2);
  assert.equal(await sample.queue.count(), 0);
});

test("別コントローラも同じDBのWeb Lockを使い、同じ画像を二重送信しない", async (t) => {
  const indexedDB = new IDBFactory();
  const locks = lockManager();
  const gate = deferred();
  const started = deferred();
  const calls = [];
  const upload = async (item) => { calls.push(item.id); started.resolve(); await gate.promise; return { ok: true }; };
  const first = await setup(t, { indexedDB, locks, upload });
  const id = await first.queue.enqueue(image());
  first.document.visibilityState = "visible";
  const run = first.queue.retry();
  await started.promise;
  const second = await setup(t, { indexedDB, locks, upload, visible: true });
  assert.deepEqual(calls, [id]);
  gate.resolve();
  await run;
  await second.queue.retry();
  assert.deepEqual(calls, [id]);
  assert.equal(await second.queue.count(), 0);
});

test("件数と状態を購読でき、登録したIndexedDBの件数で新版への切り替えを保留する", async (t) => {
  const sample = await setup(t);
  const states = [];
  const unsubscribe = sample.queue.subscribe((state) => states.push(state));
  sample.queue.subscribe(() => { throw new Error("表示側の失敗"); });
  await sample.queue.enqueue(image());
  await sample.queue.retry();
  assert.equal(await readPendingUploadCount(), 1);
  const applied = [];
  const check = createUpdateChecker({
    currentVersion: "old", readLatestVersion: async () => "new", readPendingUploads: readPendingUploadCount,
    getActivity: () => ({ cameraActive: false, imagePreview: false, pageVisible: true }),
    applyUpdate: (version) => applied.push(version),
  });
  assert.equal(await check(), "deferred");
  await sample.foreground();
  assert.equal(await readPendingUploadCount(), 0);
  assert.equal(await check(), "applied");
  assert.deepEqual(applied, ["new"]);
  assert.ok(states.some((state) => state.pendingCount === 1 && state.status === "waiting"));
  assert.ok(states.some((state) => state.status === "sending"));
  assert.equal(states.at(-1).pendingCount, 0);
  assert.equal("blob" in states.at(-1), false);
  unsubscribe();
});

test("保存処理が中断したら成功扱いせず、残ったリストから送信しない", async (t) => {
  const real = new IDBFactory();
  const indexedDB = { open(...args) {
    const request = real.open(...args);
    request.addEventListener("success", () => {
      const db = request.result;
      const original = db.transaction.bind(db);
      db.transaction = (...parameters) => {
        const tx = original(...parameters);
        if (parameters[1] === "readwrite") {
          const uploads = tx.objectStore("uploads");
          const add = uploads.add.bind(uploads);
          uploads.add = (...values) => {
            const adding = add(...values);
            adding.addEventListener("success", () => tx.abort());
            return adding;
          };
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => name === "uploads" ? uploads : objectStore(name);
        }
        return tx;
      };
    });
    return request;
  } };
  let sent = false;
  const sample = await setup(t, { indexedDB, upload: async () => { sent = true; return { ok: true }; } });
  await assert.rejects(sample.queue.enqueue(image()), QueueStorageError);
  await sample.foreground();
  assert.equal(await sample.queue.count(), 0);
  assert.equal(sent, false);
});

test("削除トランザクションが失敗したときも画像は消えず、件数取得失敗なら更新しない", async (t) => {
  const real = new IDBFactory();
  let breakReads = false;
  const indexedDB = { open(...args) {
    const request = real.open(...args);
    request.addEventListener("success", () => {
      const db = request.result;
      const original = db.transaction.bind(db);
      db.transaction = (...parameters) => {
        if (breakReads && parameters[1] === "readonly") throw new Error("保存領域が利用不可");
        const tx = original(...parameters);
        if (parameters[1] === "readwrite") {
          const uploads = tx.objectStore("uploads");
          const remove = uploads.delete.bind(uploads);
          uploads.delete = (...values) => { const deleting = remove(...values); deleting.addEventListener("success", () => tx.abort()); return deleting; };
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => name === "uploads" ? uploads : objectStore(name);
        }
        return tx;
      };
    });
    return request;
  } };
  const sample = await setup(t, { indexedDB });
  await sample.queue.enqueue(image());
  await sample.foreground();
  assert.equal(await sample.queue.count(), 1);
  assert.equal(sample.queue.snapshot().reason, "storage");
  breakReads = true;
  const check = createUpdateChecker({
    currentVersion: "old", readLatestVersion: async () => "new", readPendingUploads: readPendingUploadCount,
    getActivity: () => ({ cameraActive: false, imagePreview: false, pageVisible: true }),
    applyUpdate: () => assert.fail("取得できない時は切り替えない"),
  });
  assert.equal(await check(), "unavailable");
});

test("Web Locks非対応では安全に待機し、画像を保持する", async (t) => {
  const sample = await setup(t, { locks: null, upload: async () => assert.fail("排他制御なしで送信しない") });
  await sample.queue.enqueue(image());
  await sample.foreground();
  assert.equal(sample.queue.snapshot().reason, "locking-unavailable");
  assert.equal(await sample.queue.count(), 1);
});

test("既存画像を起動時に再開し、送信完了を待たずコントローラを返す", async (t) => {
  const indexedDB = new IDBFactory();
  const store = await openUploadStore({ indexedDB });
  await store.add(image());
  store.close();
  const gate = deferred();
  const started = deferred();
  const document = new EventTarget();
  document.visibilityState = "visible";
  const queue = await createUploadQueue({
    indexedDB, locks: lockManager(), document, window: new EventTarget(), navigator: { onLine: true },
    upload: async () => { started.resolve(); await gate.promise; return { ok: true }; },
  });
  t.after(() => queue.dispose());
  await started.promise;
  assert.equal(queue.snapshot().status, "sending");
  assert.equal(await queue.count(), 1);
  gate.resolve();
  await queue.retry();
  assert.equal(await queue.count(), 0);
});

test("DB読み込み中の前面から裏への変化を送信の直前にも判定する", async (t) => {
  const sample = await setup(t, { upload: async () => assert.fail("裏へ移った後は開始しない") });
  await sample.queue.enqueue(image());
  const unsubscribe = sample.queue.subscribe((state) => {
    if (state.status === "waiting" && sample.document.visibilityState === "visible") sample.document.visibilityState = "hidden";
  });
  await sample.foreground();
  assert.equal(await sample.queue.count(), 1);
  unsubscribe();
});

test("送信開始を記録した後に終了しても、画像と試行回数が残る", async () => {
  const indexedDB = new IDBFactory();
  const first = await openUploadStore({ indexedDB });
  const id = await first.add(image());
  await first.beginAttempt(id);
  first.close();
  const second = await openUploadStore({ indexedDB });
  try {
    const snapshot = await second.snapshot();
    assert.equal(snapshot.pendingCount, 1);
    assert.equal(snapshot.head.attempts, 1);
    assert.equal(await snapshot.head.blob.text(), "synthetic test payload");
  } finally { second.close(); }
});

test("空画像・不正な宛先と日時を保存せず、再送間隔を上限内に収める", async (t) => {
  const sample = await setup(t);
  for (const invalid of [
    { blob: new Blob([], { type: "image/jpeg" }) }, { blob: new Blob(["text"], { type: "text/plain" }) },
    { className: "" }, { sessionFolderName: "" }, { capturedAt: "2026-09-30T09:00:00" }, { capturedAt: Infinity },
  ]) await assert.rejects(sample.queue.enqueue({ ...image(), ...invalid }), TypeError);
  assert.equal(await sample.queue.count(), 0);
  assert.deepEqual([1, 2, 3, 10, 1000].map((count) => retryDelay(count)), [1000, 2000, 4000, 60000, 60000]);
});
