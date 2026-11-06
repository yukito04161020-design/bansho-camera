import { registerPendingUploadCounter } from "./app-update.js";
import { openUploadStore, ImageUnreadableError } from "./upload-store.js";

// 外部エラー本文には認証情報が含まれ得るため、既知の分類だけを記録する。
const reasons = new Set(["network", "server", "permission", "duplicate-folder", "folder", "timeout", "unreadable",
  "authentication", "upload", "quota"]);
// 通信断・Driveの混雑・容量不足・認証切れは後の画像も同じく失敗するため、送信待ち全体を待たせる。
// それ以外（権限・保存先・送信結果の不一致・制限時間・読めない画像）は、その画像だけを後回しにする。
export const waitingReasons = Object.freeze(["network", "server", "quota", "authentication"]);
const stages = new Set(["read", "id", "folder", "check", "start", "send", "verify"]);

// 実機で原因を切り分けられるよう、失敗した段階・HTTP番号・Driveの既知の理由コードだけを残す。
export function failureDetail(input) {
  if (!input || !stages.has(input.stage)) return null;
  const detail = { stage: input.stage };
  if (Number.isInteger(input.status) && input.status >= 100 && input.status <= 599) detail.status = input.status;
  if (typeof input.code === "string" && /^[A-Za-z]{1,40}$/.test(input.code)) detail.code = input.code;
  return detail;
}

export class UploadFailure extends Error {
  constructor(reason, detail) {
    super("送信が完了しませんでした。");
    this.name = "UploadFailure";
    this.reason = reasons.has(reason) ? reason : "upload";
    this.detail = failureDetail(detail);
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
  attemptTimeout = 120000,
} = {}) {
  if (typeof upload !== "function") throw new TypeError("送信関数を指定してください。");
  if (!Number.isFinite(baseDelay) || baseDelay < 1 || !Number.isFinite(maximumDelay)
    || maximumDelay < baseDelay || maximumDelay > 2147483647) throw new TypeError("再送間隔が不正です。");
  if (!Number.isFinite(attemptTimeout) || attemptTimeout < 1 || attemptTimeout > 2147483647) {
    throw new TypeError("送信の制限時間が不正です。");
  }
  const opening = openUploadStore({ indexedDB, databaseName });
  registerPendingUploadCounter(async () => (await opening).count());
  const store = await opening;
  const subscribers = new Set();
  let state = { pendingCount: null, unreadableCount: 0, status: "waiting", reason: null, nextRetryAt: null };
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
  async function refresh({ continuing = false } = {}) {
    const snapshot = await store.snapshot({ now: now(), waitAll: waitingReasons });
    // 続けて送る画像があるときは、画像の間に「送信待ち」や先頭の失敗を挟まず送信中のまま示す。
    if (continuing && !snapshot.authenticationRequired && snapshot.next && eligible()) {
      publish({ pendingCount: snapshot.pendingCount, unreadableCount: snapshot.unreadableCount || 0,
        status: "sending", reason: null, detail: null, nextRetryAt: null });
      return snapshot;
    }
    publish({
      pendingCount: snapshot.pendingCount,
      unreadableCount: snapshot.unreadableCount || 0,
      status: snapshot.authenticationRequired ? "authentication-required" : "waiting",
      reason: snapshot.authenticationRequired ? "authentication" : snapshot.head?.lastFailure || null,
      detail: snapshot.authenticationRequired ? null : failureDetail(snapshot.head?.lastFailureDetail),
      nextRetryAt: snapshot.head?.nextRetryAt || null,
    });
    return snapshot;
  }

  async function drain() {
    while (!disposed) {
      const snapshot = await refresh({ continuing: state.status === "sending" });
      if (!eligible() || snapshot.authenticationRequired) { if (state.status === "sending") await refresh(); return; }
      const next = snapshot.next;
      if (!next) {
        // 今送れる画像がなければ、最も早い再送時刻に予約する。
        if (snapshot.wakeAt !== null) schedule(snapshot.wakeAt - now());
        return;
      }
      let blob = null;
      try { blob = await store.readImage(next.id); }
      catch (error) { if (!(error instanceof ImageUnreadableError)) throw error; /* 読めない画像も消さずに残す。 */ }
      if (!(blob instanceof Blob)) {
        // 読めない画像は送信の対象から外して記録を残し、後の画像の送信を続ける。
        await store.fail(next.id, "unreadable", 0);
        continue;
      }
      // DB処理を待つ間に裏へ移った場合も、新たな送信は開始しない。
      // 送信中の表示のまま止まらないよう、送らずに戻るときは状態を読み直す。
      if (!eligible()) { await refresh(); return; }
      const item = await store.beginAttempt(next.id);
      if (!item || !eligible()) { await refresh(); return; }
      publish({ status: "sending", reason: null, detail: null, nextRetryAt: null });
      let reason = null;
      let detail = null;
      let stage = null;
      // 応答が返らない通信でも送信中のまま止まらないよう、制限時間で中断して再送に回す。
      const controller = new AbortController();
      let deadline = null;
      const expired = new Promise((resolve, reject) => {
        deadline = setTimer(() => { controller.abort(); reject(new UploadFailure("timeout", stage && { stage })); }, attemptTimeout);
      });
      try {
        // 明示的に成功と返した場合だけ消す。undefined等は成功扱いしない。
        const result = await Promise.race([upload({
          id: item.id, blob, className: item.className,
          sessionFolderName: item.sessionFolderName, capturedAt: item.capturedAt,
          driveFileId: item.driveFileId || null,
        }, { persistDriveFileId: (fileId) => store.setDriveFileId(item.id, fileId), signal: controller.signal,
          // 制限時間で止まったときに、どの段階で応答がなかったかを残す。
          progress: (value) => { if (stages.has(value)) stage = value; } }), expired]);
        if (result?.ok !== true) { reason = result?.reason; detail = failureDetail(result?.detail); }
        if (result?.ok !== true && !reasons.has(reason)) reason = "upload";
      } catch (error) {
        reason = error instanceof UploadFailure ? error.reason : "upload";
        detail = error instanceof UploadFailure ? error.detail : null;
      }
      finally { clearTimer(deadline); expired.catch(() => {}); }
      if (reason) {
        const nextRetryAt = reason === "authentication" ? 0 : now() + retryDelay(item.attempts, baseDelay, maximumDelay);
        await store.fail(item.id, reason, nextRetryAt, detail);
        // 後の画像を送るか全体で待つかは、保存した失敗理由をもとに次のsnapshotが決める。
        continue;
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
    // 読めなかった画像の読み出しをもう一度試してから送信を再開する。
    async retryUnreadable() {
      if (disposed) return;
      await store.retryUnreadable();
      await kick();
    },
    images: () => store.images(),
    readImage: (id) => store.readImage(id),
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
