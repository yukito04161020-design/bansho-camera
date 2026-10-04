import { registerPendingUploadCounter } from "./app-update.js";
import { openUploadStore } from "./upload-store.js";

// 外部エラー本文には認証情報が含まれ得るため、既知の分類だけを記録する。
const reasons = new Set(["network", "server", "permission", "authentication", "upload"]);
export class UploadFailure extends Error {
  constructor(reason) {
    super("送信が完了しませんでした。");
    this.name = "UploadFailure";
    this.reason = reasons.has(reason) ? reason : "upload";
  }
}

export function retryDelay(attempts, baseDelay = 1000, maximumDelay = 60000) {
  return Math.min(maximumDelay, baseDelay * 2 ** Math.min(30, Math.max(0, attempts - 1)));
}

// 作成時に件数読み込みを登録する。DBを開く間や失敗時にも更新を許可しない。
export async function createUploadQueue({
  upload,
  indexedDB = globalThis.indexedDB,
  databaseName = "bansho-camera-uploads",
  locks = globalThis.navigator?.locks,
  document = globalThis.document,
  window = globalThis.window,
  navigator = globalThis.navigator,
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  baseDelay = 1000,
  maximumDelay = 60000,
} = {}) {
  if (typeof upload !== "function") throw new TypeError("送信関数を指定してください。");
  if (!Number.isFinite(baseDelay) || baseDelay < 1 || !Number.isFinite(maximumDelay)
    || maximumDelay < baseDelay || maximumDelay > 2147483647) throw new TypeError("再送間隔が不正です。");
  const opening = openUploadStore({ indexedDB, databaseName });
  registerPendingUploadCounter(async () => (await opening).count());
  const store = await opening;
  const subscribers = new Set();
  let state = { pendingCount: null, status: "waiting", reason: null, nextRetryAt: null };
  let running = null;
  let requested = false;
  let disposed = false;
  let timer = null;
  const lockName = `bansho-camera-send:${databaseName}`;
  const eligible = () => !disposed && document?.visibilityState === "visible" && navigator?.onLine !== false;

  function publish(patch) {
    state = { ...state, ...patch };
    for (const subscriber of subscribers) {
      try { subscriber({ ...state }); } catch { /* 表示側の例外で送信を止めない。 */ }
    }
  }
  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule(delay) {
    clearScheduled();
    if (!eligible()) return;
    timer = setTimer(() => { timer = null; void kick(); }, Math.max(1, Math.min(2147483647, delay)));
  }
  async function refresh() {
    const snapshot = await store.snapshot();
    publish({
      pendingCount: snapshot.pendingCount,
      status: snapshot.authenticationRequired ? "authentication-required" : "waiting",
      reason: snapshot.authenticationRequired ? "authentication" : snapshot.head?.lastFailure || null,
      nextRetryAt: snapshot.head?.nextRetryAt || null,
    });
    return snapshot;
  }

  async function drain() {
    while (!disposed) {
      const snapshot = await refresh();
      if (!eligible() || snapshot.authenticationRequired || !snapshot.head) return;
      const delay = snapshot.head.nextRetryAt - now();
      if (delay > 0) { schedule(delay); return; }
      const item = await store.beginAttempt(snapshot.head.id);
      // DB処理を待つ間に裏へ移った場合も、新たな送信は開始しない。
      if (!item || !eligible()) return;
      publish({ status: "sending", reason: null, nextRetryAt: null });
      let reason = null;
      try {
        // 明示的に成功と返した場合だけ消す。undefined等は成功扱いしない。
        const result = await upload({
          id: item.id, blob: item.blob, className: item.className,
          sessionFolderName: item.sessionFolderName, capturedAt: item.capturedAt,
          driveFileId: item.driveFileId || null,
        }, { persistDriveFileId: (fileId) => store.setDriveFileId(item.id, fileId) });
        if (result?.ok !== true) reason = result?.reason;
        if (result?.ok !== true && !reasons.has(reason)) reason = "upload";
      } catch (error) { reason = error instanceof UploadFailure ? error.reason : "upload"; }
      if (reason) {
        const nextRetryAt = reason === "authentication" ? 0 : now() + retryDelay(item.attempts, baseDelay, maximumDelay);
        await store.fail(item.id, reason, nextRetryAt);
        await refresh();
        if (reason !== "authentication") schedule(nextRetryAt - now());
        return;
      }
      // 保存が失敗したときは削除せず待機する。裏へ移ってもこの結果だけは記録する。
      await store.succeed(item.id);
    }
  }

  function kick() {
    if (disposed) return Promise.resolve();
    requested = true;
    if (running) return running;
    running = (async () => {
      do {
        requested = false;
        clearScheduled();
        try {
          if (!eligible()) { await refresh(); continue; }
          if (!locks?.request) {
            await refresh();
            publish({ reason: "locking-unavailable" });
            continue;
          }
          // 同じDBを複数タブ・複数コントローラで開いても送信は1つだけ。
          await locks.request(lockName, { ifAvailable: true }, async (lock) => {
            if (!lock) { await refresh(); schedule(1000); return; }
            await drain();
          });
        } catch {
          publish({ status: "waiting", reason: "storage", pendingCount: null });
          schedule(maximumDelay);
        }
      } while (requested && !disposed);
    })().finally(() => {
      running = null;
      // 終了のPromiseが解決する直前に追加された再開要求も取りこぼさない。
      if (requested && !disposed) void kick();
    });
    return running;
  }
  const onVisibility = () => { if (eligible()) void kick(); else clearScheduled(); };
  const onOnline = () => { void kick(); };
  const onOffline = () => { clearScheduled(); };
  const onPageShow = () => { void kick(); };
  document?.addEventListener("visibilitychange", onVisibility);
  window?.addEventListener("online", onOnline);
  window?.addEventListener("offline", onOffline);
  window?.addEventListener("pageshow", onPageShow);

  const queue = {
    async enqueue(input) {
      if (disposed) throw new Error("送信待ち機能は終了しています。");
      const id = await store.add(input);
      // 保存後は送信完了を待たず戻り、次の撮影を妨げない。
      try { publish({ pendingCount: await store.count() }); }
      catch { publish({ pendingCount: null, reason: "storage" }); }
      void kick();
      return id;
    },
    count: () => store.count(),
    readCaptureSettings: () => store.readCaptureSettings(),
    writeCaptureSettings: (value) => store.writeCaptureSettings(value),
    readManualLesson: () => store.readManualLesson(),
    writeManualLesson: (value) => store.writeManualLesson(value),
    readTimetable: () => store.readTimetable(),
    writeTimetable: (value) => store.writeTimetable(value),
    pendingDestinations: () => store.pendingDestinations(),
    snapshot: () => ({ ...state }),
    subscribe(subscriber) {
      if (typeof subscriber !== "function") throw new TypeError("購読する関数を指定してください。");
      subscribers.add(subscriber);
      try { subscriber({ ...state }); } catch { /* 初回の表示例外も送信に影響させない。 */ }
      return () => subscribers.delete(subscriber);
    },
    retry: kick,
    async resumeAfterAuthentication() {
      if (disposed) return;
      if (!locks?.request) throw new Error("送信の排他制御を利用できません。");
      await locks.request(lockName, async () => { await store.resumeAuthentication(); });
      await kick();
    },
    async dispose() {
      disposed = true;
      clearScheduled();
      document?.removeEventListener("visibilitychange", onVisibility);
      window?.removeEventListener("online", onOnline);
      window?.removeEventListener("offline", onOffline);
      window?.removeEventListener("pageshow", onPageShow);
      // 処理中の1件の結果を保存してから閉じる。次の1件は開始しない。
      await running;
      subscribers.clear();
      store.close();
    },
  };
  try { await refresh(); }
  catch { publish({ pendingCount: null, status: "waiting", reason: "storage" }); }
  void kick();
  return queue;
}
