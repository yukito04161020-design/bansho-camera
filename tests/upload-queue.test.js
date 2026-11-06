import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, forceCloseDatabase } from "fake-indexeddb";
import { openUploadStore, QueueStorageError } from "../public/upload-store.js";
import { createUploadQueue, retryDelay, UploadFailure, failureDetail } from "../public/upload-queue.js";
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
    // iPhoneで開き直した後も読めるよう、Blobではなくバイト列で保存する。
    assert.equal("blob" in state.head, false);
    assert.ok(state.head.bytes instanceof ArrayBuffer);
    const stored = await second.readImage(id);
    assert.equal(await stored.text(), "synthetic test payload");
    assert.equal(stored.type, "image/jpeg");
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
    assert.equal(await (await second.readImage(id)).text(), "synthetic test payload");
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

test("応答のない送信は制限時間で中断し、送信中のまま止まらず再送を予約する", async (t) => {
  let signal = null;
  let calls = 0;
  const sample = await setup(t, { attemptTimeout: 5000, upload: async (item, context) => {
    calls += 1;
    if (calls > 1) return { ok: true };
    signal = context.signal;
    return new Promise(() => {});
  } });
  await sample.queue.enqueue(image());
  sample.document.visibilityState = "visible";
  sample.document.dispatchEvent(new Event("visibilitychange"));
  for (let i = 0; i < 50 && sample.queue.snapshot().status !== "sending"; i += 1) await new Promise((done) => setTimeout(done, 1));
  assert.equal(sample.queue.snapshot().status, "sending");
  await sample.advance(5000);
  assert.equal(signal.aborted, true);
  assert.equal(sample.queue.snapshot().status, "waiting");
  assert.equal(sample.queue.snapshot().reason, "timeout");
  assert.equal(sample.queue.snapshot().pendingCount, 1);
  await sample.advance(retryDelay(1));
  assert.equal(calls, 2);
  assert.equal(sample.queue.snapshot().pendingCount, 0);
});

// 以前の版が保存した形（Blobだけのレコード）を直接書き込む。
async function putLegacy(indexedDB, record) {
  const store = await openUploadStore({ indexedDB });
  store.close();
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("bansho-camera-uploads", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const id = await new Promise((resolve, reject) => {
    const tx = db.transaction("uploads", "readwrite");
    let key;
    tx.objectStore("uploads").add({ className: "数学", sessionFolderName: "第01回_2026-09-30", capturedAt: 1000,
      attempts: 0, lastFailure: null, nextRetryAt: 0, ...record }).onsuccess = (event) => { key = event.target.result; };
    tx.oncomplete = () => resolve(key);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return id;
}

test("以前の版のBlobだけの画像も読み出せたら、同じ内容のバイト列に置き換える", async () => {
  const indexedDB = new IDBFactory();
  const id = await putLegacy(indexedDB, { blob: new Blob(["legacy payload"], { type: "image/jpeg" }) });
  const store = await openUploadStore({ indexedDB });
  try {
    assert.equal(await (await store.readImage(id)).text(), "legacy payload");
    const { head } = await store.snapshot();
    assert.ok(head.bytes instanceof ArrayBuffer);
    assert.equal(head.type, "image/jpeg");
    // 以後の書き込みでBlobを保存し直さないよう、レコードからBlobを外す。
    assert.equal("blob" in head, false);
    assert.equal(head.className, "数学");
    assert.equal(await (await store.readImage(id)).text(), "legacy payload");
  } finally { store.close(); }
});

test("読めない画像は消さずに残し、後の画像の送信を止めず、再開操作で読み出しを再試行する", async (t) => {
  const indexedDB = new IDBFactory();
  const broken = await putLegacy(indexedDB, { blob: null, capturedAt: 500 });
  const sent = [];
  const sample = await setup(t, { indexedDB, visible: true, upload: async (item) => {
    sent.push(await item.blob.text());
    return { ok: true };
  } });
  await sample.queue.enqueue(image(2000));
  await sample.queue.retry();
  assert.deepEqual(sent, ["synthetic test payload"]);
  let state = sample.queue.snapshot();
  assert.equal(state.pendingCount, 1);
  assert.equal(state.unreadableCount, 1);
  const store = await openUploadStore({ indexedDB, databaseName: "bansho-camera-uploads" });
  try {
    const images = await store.images();
    assert.deepEqual(images.map((image) => image.id), [broken]);
    await assert.rejects(store.readImage(broken), { name: "ImageUnreadableError" });
  } finally { store.close(); }
  await sample.queue.retryUnreadable();
  state = sample.queue.snapshot();
  assert.equal(state.pendingCount, 1, "再試行しても読めない画像は消さない");
  assert.equal(state.unreadableCount, 1);
});

test("撮影画像を読み出せないときは保存せず失敗を返し、呼び出し側が画像を保持できる", async () => {
  const store = await openUploadStore({ indexedDB: new IDBFactory() });
  try {
    const blob = new Blob(["x"], { type: "image/jpeg" });
    blob.arrayBuffer = async () => { throw new Error("読めない"); };
    await assert.rejects(store.add({ ...image(), blob }), { name: "ImageUnreadableError" });
    assert.equal(await store.count(), 0);
  } finally { store.close(); }
});

test("先頭の画像がDrive側の理由で失敗しても後の画像を送り、失敗した画像だけを再送時刻まで後回しにする", async (t) => {
  for (const reason of ["permission", "folder", "duplicate-folder", "upload", "timeout"]) {
    const calls = [];
    let first;
    let fixed = false;
    const sample = await setup(t, { upload: async (item) => {
      calls.push(item.id);
      if (item.id === first && !fixed) throw new UploadFailure(reason, { stage: "send", status: 403 });
      return { ok: true };
    } });
    first = await sample.queue.enqueue(image(1000));
    const second = await sample.queue.enqueue(image(2000));
    const third = await sample.queue.enqueue(image(3000));
    await sample.foreground();
    assert.deepEqual(calls, [first, second, third], reason);
    assert.equal(await sample.queue.count(), 1);
    assert.equal(sample.queue.snapshot().reason, reason);
    assert.deepEqual(sample.queue.snapshot().detail, { stage: "send", status: 403 });
    await sample.advance(999);
    assert.deepEqual(calls, [first, second, third], "再送時刻までは失敗した画像を送らない");
    fixed = true;
    await sample.advance(1);
    assert.deepEqual(calls, [first, second, third, first]);
    assert.equal(await sample.queue.count(), 0);
  }
});

test("通信断・Driveの混雑・容量不足では、先頭の再送時刻まで後の画像も送らない", async (t) => {
  for (const reason of ["network", "server", "quota"]) {
    const calls = [];
    let first;
    let fixed = false;
    const sample = await setup(t, { upload: async (item) => {
      calls.push(item.id);
      return item.id === first && !fixed ? { ok: false, reason } : { ok: true };
    } });
    first = await sample.queue.enqueue(image(1000));
    const second = await sample.queue.enqueue(image(2000));
    await sample.foreground();
    assert.deepEqual(calls, [first], reason);
    assert.equal(sample.queue.snapshot().reason, reason);
    await sample.advance(1000);
    assert.deepEqual(calls, [first, first], reason);
    fixed = true;
    await sample.advance(2000);
    assert.deepEqual(calls, [first, first, first, second], reason);
    assert.equal(await sample.queue.count(), 0);
  }
});

test("失敗した段階・HTTP番号・理由コードだけを記録し、外部の本文や不正な値は残さない", async (t) => {
  const sample = await setup(t, { upload: async () => {
    throw new UploadFailure("quota", { stage: "send", status: 403, code: "storageQuotaExceeded", message: "sensitive-test-value" });
  } });
  await sample.queue.enqueue(image());
  await sample.foreground();
  const expected = { stage: "send", status: 403, code: "storageQuotaExceeded" };
  assert.deepEqual(sample.queue.snapshot().detail, expected);
  const inspect = await openUploadStore({ indexedDB: sample.indexedDB });
  t.after(() => inspect.close());
  const { head } = await inspect.snapshot();
  assert.deepEqual(head.lastFailureDetail, expected);
  assert.equal(JSON.stringify(head).includes("sensitive-test-value"), false);
  for (const [input, value] of [
    [{ stage: "unknown", status: 403 }, null], [null, null],
    [{ stage: "send", status: 4030, code: "ya29.synthetic-token" }, { stage: "send" }],
    [{ stage: "folder", status: "403", code: "has space" }, { stage: "folder" }],
  ]) assert.deepEqual(failureDetail(input), value);
  const returned = await setup(t, { upload: async () => ({ ok: false, reason: "permission", detail: { stage: "start", status: 403, extra: "x" } }) });
  await returned.queue.enqueue(image());
  await returned.foreground();
  assert.deepEqual(returned.queue.snapshot().detail, { stage: "start", status: 403 });
});

test("制限時間で中断したときは、応答がなかった段階を記録する", async (t) => {
  let calls = 0;
  const sample = await setup(t, { attemptTimeout: 5000, upload: async (item, context) => {
    calls += 1;
    context.progress("folder");
    context.progress("send");
    context.progress("不明な段階");
    return new Promise(() => {});
  } });
  await sample.queue.enqueue(image());
  sample.document.visibilityState = "visible";
  sample.document.dispatchEvent(new Event("visibilitychange"));
  for (let i = 0; i < 50 && sample.queue.snapshot().status !== "sending"; i += 1) await new Promise((done) => setTimeout(done, 1));
  await sample.advance(5000);
  assert.equal(calls, 1);
  assert.equal(sample.queue.snapshot().reason, "timeout");
  assert.deepEqual(sample.queue.snapshot().detail, { stage: "send" });
});

test("端末内DBの接続が切れても開き直し、送信待ちの保存と送信を続ける", async (t) => {
  const real = new IDBFactory();
  const connections = [];
  const indexedDB = { open(...args) {
    const request = real.open(...args);
    request.addEventListener("success", () => connections.push(request.result));
    return request;
  } };
  const sent = [];
  const sample = await setup(t, { indexedDB, upload: async (item) => { sent.push(item.id); return { ok: true }; } });
  // iPhoneのSafariで裏から戻ったときのように、開いている接続を強制的に閉じる。
  for (const connection of connections) forceCloseDatabase(connection);
  const id = await sample.queue.enqueue(image());
  await sample.foreground();
  assert.deepEqual(sent, [id]);
  assert.equal(await sample.queue.count(), 0);
  assert.ok(connections.length >= 2, "新しい接続を開いた");
  // closeイベントを受け取る前に操作した場合も、開き直してやり直す。
  const store = await openUploadStore({ indexedDB });
  t.after(() => store.close());
  const latest = connections.at(-1);
  latest.onclose = null;
  forceCloseDatabase(latest);
  assert.equal(await store.count(), 0);
});

test("端末内DBの処理が返らないときは制限時間で失敗にし、開き直してやり直す", async () => {
  const real = new IDBFactory();
  let hanging = 0;
  const indexedDB = { open(...args) {
    const request = real.open(...args);
    request.addEventListener("success", () => {
      const db = request.result;
      const original = db.transaction.bind(db);
      db.transaction = (...parameters) => {
        const tx = original(...parameters);
        if (hanging > 0) {
          hanging -= 1;
          // 完了の知らせが届かない状態を再現する。
          Object.defineProperty(tx, "oncomplete", { set() {}, configurable: true });
        }
        return tx;
      };
    });
    return request;
  } };
  const store = await openUploadStore({ indexedDB, timeout: 30 });
  try {
    hanging = 1;
    assert.equal(await store.count(), 0);
    hanging = 2;
    await assert.rejects(store.count(), QueueStorageError);
    assert.equal(await store.count(), 0);
  } finally { store.close(); }
});

test("読めない画像は記録を書き換えずに後回しにし、書き戻せない以前の版のレコードがあっても後の画像を送る", async (t) => {
  const real = new IDBFactory();
  const broken = await putLegacy(real, { blob: null, capturedAt: 500 });
  // iPhoneで、以前の版のBlobを含むレコードを書き戻すと失敗する状態を再現する。
  const indexedDB = { open(...args) {
    const request = real.open(...args);
    request.addEventListener("success", () => {
      const db = request.result;
      const original = db.transaction.bind(db);
      db.transaction = (...parameters) => {
        const tx = original(...parameters);
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const target = objectStore(name);
          if (name !== "uploads") return target;
          const put = target.put.bind(target);
          target.put = (value, ...rest) => {
            if ("blob" in value) throw new DOMException("Blobを保存し直せません", "UnknownError");
            return put(value, ...rest);
          };
          return target;
        };
        return tx;
      };
    });
    return request;
  } };
  const sent = [];
  const sample = await setup(t, { indexedDB, visible: true, upload: async (item) => {
    sent.push(await item.blob.text());
    return { ok: true };
  } });
  await sample.queue.enqueue(image(2000));
  await sample.queue.retry();
  assert.deepEqual(sent, ["synthetic test payload"]);
  const state = sample.queue.snapshot();
  assert.equal(state.pendingCount, 1);
  assert.equal(state.unreadableCount, 1);
  assert.equal(state.reason, null);
  await sample.queue.retryUnreadable();
  assert.equal(sample.queue.snapshot().unreadableCount, 1);
  assert.equal(sample.queue.snapshot().pendingCount, 1, "読めない画像を消さない");
  const store = await openUploadStore({ indexedDB: real });
  t.after(() => store.close());
  assert.deepEqual((await store.images()).map((item) => item.id), [broken]);
});
