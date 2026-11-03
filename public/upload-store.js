import { timetableRecord, manualLessonRecord } from "./timetable-logic.js";
import { captureSettings } from "./capture-save.js";

export class QueueStorageError extends Error {
  constructor() { super("送信待ちを端末内に保存・読み込みできませんでした。"); this.name = "QueueStorageError"; }
}
export class ImageUnreadableError extends Error {
  constructor() { super("端末内の画像を読み込めませんでした。"); this.name = "ImageUnreadableError"; }
}

// iPhoneのSafariは裏から戻ったとき、DBとの接続が切れて操作が失敗し続けることがある。
// 接続の問題による失敗だけに印を付け、開き直して1回だけやり直す。
function connectionLost() {
  const error = new QueueStorageError();
  error.connectionLost = true;
  return error;
}
// 明示的な中断（error=null）や容量不足は開き直しても直らないため、やり直さない。
const lostNames = new Set(["UnknownError", "InvalidStateError", "AbortError", "TimeoutError"]);

// リクエスト成功だけで保存完了とせず、トランザクション完了を待つ。
// 完了も中断も届かないときは制限時間で失敗にし、接続を開き直す対象にする。
function transaction(db, mode, action, { setTimer, clearTimer, timeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (settle) => { if (settled) return; settled = true; clearTimer(timer); settle(); };
    let tx;
    try { tx = db.transaction(["uploads", "state"], mode); }
    catch { reject(connectionLost()); return; }
    let result;
    tx.oncomplete = () => finish(() => resolve(result));
    tx.onabort = () => finish(() => reject(lostNames.has(tx.error?.name) ? connectionLost() : new QueueStorageError()));
    tx.onerror = () => {}; // abortで固定文言を返し、外部のエラー内容を保存しない。
    timer = setTimer(() => finish(() => {
      try { tx.abort(); } catch { /* 既に終わっている場合も失敗として扱う。 */ }
      reject(connectionLost());
    }), timeout);
    try { action(tx.objectStore("uploads"), tx.objectStore("state"), (value) => { result = value; }); }
    catch { try { tx.abort(); } catch { /* 中断できなくても制限時間で失敗にする。 */ } }
  });
}

function connect(indexedDB, databaseName, { setTimer, clearTimer, timeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const fail = () => { if (settled) return; settled = true; clearTimer(timer); reject(new QueueStorageError()); };
    try {
      const request = indexedDB.open(databaseName, 1);
      request.onerror = fail;
      request.onblocked = fail;
      request.onupgradeneeded = () => {
        const uploads = request.result.createObjectStore("uploads", { keyPath: "id", autoIncrement: true });
        uploads.createIndex("captureOrder", ["capturedAt", "id"]);
        request.result.createObjectStore("state");
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        clearTimer(timer);
        resolve(request.result);
      };
      timer = setTimer(fail, timeout);
    } catch { fail(); }
  });
}

// 画像の読み出しが返らないときも、送信待ちの処理を止めない。
function within(promise, { setTimer, clearTimer, timeout }) {
  let timer = null;
  return Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimer(() => reject(new Error("timeout")), timeout);
  })]).finally(() => clearTimer(timer));
}

function imageRecord(input) {
  const { blob, className, sessionFolderName, capturedAt } = input || {};
  let instant = NaN;
  if (capturedAt instanceof Date) instant = capturedAt.getTime();
  else if (typeof capturedAt === "number") instant = capturedAt;
  else if (typeof capturedAt === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(capturedAt)) instant = Date.parse(capturedAt);
  if (!(blob instanceof Blob) || !blob.size || !blob.type.startsWith("image/")
    || typeof className !== "string" || !className.trim()
    || typeof sessionFolderName !== "string" || !sessionFolderName.trim()
    || !Number.isFinite(instant) || !Number.isFinite(new Date(instant).getTime())) {
    throw new TypeError("画像Blob・授業名・回フォルダ名・タイムゾーン付き撮影日時を指定してください。");
  }
  // 保存するフィールドを限定し、呼び出し元の認証情報などをコピーしない。
  return { blob, className, sessionFolderName, capturedAt: instant, attempts: 0, lastFailure: null, nextRetryAt: 0 };
}

// iPhoneのSafariでは、IndexedDBに入れたBlobが開き直した後に読めなくなることがある。
// そのため画像はバイト列（ArrayBuffer）で保存し、送信時にBlobへ戻す。
async function imageBytes(blob, limits) {
  let bytes;
  try { bytes = await within(blob.arrayBuffer(), limits); } catch { throw new ImageUnreadableError(); }
  if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength !== blob.size) throw new ImageUnreadableError();
  return bytes;
}
// 読めない画像のIDはstateに別に持ち、件数の確認のたびに全画像を読み込まない。
const unreadableKey = "unreadableIds";
const idList = (value) => Array.isArray(value) ? value.filter(Number.isSafeInteger) : [];

export async function openUploadStore({ indexedDB = globalThis.indexedDB, databaseName = "bansho-camera-uploads",
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout, timeout = 30000 } = {}) {
  const limits = { setTimer, clearTimer, timeout };
  let db = null;
  let reopening = null;
  let closed = false;
  function watch(connection) {
    connection.onversionchange = () => { connection.close(); if (db === connection) db = null; };
    // 接続が切れたことをブラウザが知らせた場合も、次の操作で開き直す。
    connection.onclose = () => { if (db === connection) db = null; };
    db = connection;
    return connection;
  }
  function current() {
    if (db) return Promise.resolve(db);
    reopening ??= connect(indexedDB, databaseName, limits).then((connection) => {
      reopening = null;
      if (closed) { connection.close(); throw new QueueStorageError(); }
      return watch(connection);
    }, (error) => { reopening = null; throw error; });
    return reopening;
  }
  async function run(mode, action) {
    for (let attempt = 0; ; attempt += 1) {
      if (closed) throw new QueueStorageError();
      const connection = await current();
      try { return await transaction(connection, mode, action, limits); }
      catch (error) {
        if (!error.connectionLost || attempt > 0) throw new QueueStorageError();
        if (db === connection) db = null;
        try { connection.close(); } catch { /* 切れた接続は閉じられなくても開き直す。 */ }
      }
    }
  }
  await current();
  return {
    databaseName,
    async add(input) {
      const { blob, ...fields } = imageRecord(input);
      // 読み出しはトランザクションの外で済ませる。待機中にトランザクションが閉じるのを防ぐ。
      const record = { ...fields, bytes: await imageBytes(blob, limits), type: blob.type };
      return run("readwrite", (uploads, state, done) => {
        uploads.add(record).onsuccess = (event) => done(event.target.result);
      });
    },
    // 送信・写真への保存に使うBlobを返す。読めないときはImageUnreadableErrorで、記録は消さない。
    async readImage(id) {
      const record = await run("readonly", (uploads, state, done) => {
        uploads.get(id).onsuccess = (event) => done(event.target.result || null);
      });
      if (!record) return null;
      if (record.bytes instanceof ArrayBuffer && record.bytes.byteLength) {
        return new Blob([record.bytes], { type: record.type || "image/jpeg" });
      }
      if (!(record.blob instanceof Blob)) throw new ImageUnreadableError();
      const bytes = await imageBytes(record.blob, limits);
      // 以前の版で保存した画像は、読めたときに同じ内容のバイト列へ置き換える。
      // Blobを残すと、以後の書き込みのたびにBlobを保存し直すことになり、iPhoneでは失敗し得る。
      try {
        await run("readwrite", (uploads) => {
          uploads.get(id).onsuccess = (event) => {
            const current = event.target.result;
            if (!current || current.bytes instanceof ArrayBuffer) return;
            delete current.blob;
            uploads.put({ ...current, bytes, type: record.blob.type || "image/jpeg" });
          };
        });
      } catch { /* 置き換えられなくても今回の送信には読めたデータを使う。 */ }
      return new Blob([bytes], { type: record.blob.type });
    },
    // 写真への保存用。画像本体は含めず、読み出しはreadImageで1件ずつ行う。
    images: () => run("readonly", (uploads, state, done) => {
      const images = [];
      done(images);
      uploads.index("captureOrder").openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        images.push({ id: cursor.value.id, capturedAt: cursor.value.capturedAt, className: cursor.value.className });
        cursor.continue();
      };
    }),
    // 読めなかった画像も、利用者の再開操作でもう一度読み出しを試す。画像のレコードは書き換えない。
    retryUnreadable: () => run("readwrite", (uploads, state) => { state.delete(unreadableKey); }),
    count: () => run("readonly", (uploads, state, done) => {
      uploads.count().onsuccess = (event) => done(event.target.result);
    }),
    // head：表示用の先頭（読めない画像を除く）。next：今送れる最初の画像。
    // waitAllの理由で失敗した画像があれば、その再送時刻まで後の画像も送らない。
    // それ以外の理由の失敗は、その画像だけを再送時刻まで後回しにする。
    snapshot: ({ now = Date.now(), waitAll = [] } = {}) => run("readonly", (uploads, state, done) => {
      const snapshot = { pendingCount: 0, unreadableCount: 0, head: null, next: null, wakeAt: null, authenticationRequired: false };
      done(snapshot);
      uploads.count().onsuccess = (event) => { snapshot.pendingCount = event.target.result; };
      // 読めない画像は送信の先頭にせず、後の画像の送信を止めない。
      state.get(unreadableKey).onsuccess = (event) => {
        const skipped = new Set(idList(event.target.result));
        snapshot.unreadableCount = skipped.size;
        uploads.index("captureOrder").openCursor().onsuccess = (found) => {
          const cursor = found.target.result;
          if (!cursor) return;
          const record = cursor.value;
          if (skipped.has(record.id)) { cursor.continue(); return; }
          snapshot.head ??= record;
          if (!(record.nextRetryAt > now)) { snapshot.next = record; return; }
          snapshot.wakeAt = snapshot.wakeAt === null ? record.nextRetryAt : Math.min(snapshot.wakeAt, record.nextRetryAt);
          if (!waitAll.includes(record.lastFailure)) cursor.continue();
        };
      };
      state.get("authenticationRequired").onsuccess = (event) => { snapshot.authenticationRequired = event.target.result === true; };
    }),
    beginAttempt: (id) => run("readwrite", (uploads, state, done) => {
      uploads.get(id).onsuccess = (event) => {
        const record = event.target.result;
        if (!record) { done(null); return; }
        record.attempts += 1;
        uploads.put(record);
        done(record);
      };
    }),
    setDriveFileId: (id, fileId) => {
      if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]+$/.test(fileId)) throw new TypeError("画像IDが不正です。");
      return run("readwrite", (uploads, state, done) => {
        uploads.get(id).onsuccess = (event) => {
          const record = event.target.result;
          if (!record || (record.driveFileId && record.driveFileId !== fileId)) {
            event.target.transaction.abort();
            return;
          }
          record.driveFileId = fileId;
          uploads.put(record);
          done(fileId);
        };
      });
    },
    readCaptureSettings: () => run("readonly", (uploads, state, done) => {
      state.get("captureSettings").onsuccess = (event) => {
        try { done(captureSettings(event.target.result)); } catch { done(captureSettings()); }
      };
    }),
    writeCaptureSettings: (input) => {
      const value = captureSettings(input);
      return run("readwrite", (uploads, state) => { state.put(value, "captureSettings"); });
    },
    readManualLesson: () => run("readonly", (uploads, state, done) => {
      state.get("manualLesson").onsuccess = (event) => {
        try { done(manualLessonRecord(event.target.result)); }
        catch { event.target.transaction.abort(); }
      };
    }),
    writeManualLesson: (input) => {
      const value = manualLessonRecord(input);
      return run("readwrite", (uploads, state) => { state.put(value, "manualLesson"); });
    },
    readTimetable: () => run("readonly", (uploads, state, done) => {
      state.get("timetable").onsuccess = (event) => {
        try { done(event.target.result ? timetableRecord(event.target.result) : null); }
        catch { event.target.transaction.abort(); }
      };
    }),
    writeTimetable: (input) => {
      const value = timetableRecord(input);
      return run("readwrite", (uploads, state) => { state.put(value, "timetable"); });
    },
    pendingDestinations: () => run("readonly", (uploads, state, done) => {
      const destinations = [];
      done(destinations);
      uploads.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        destinations.push({ className: cursor.value.className, sessionFolderName: cursor.value.sessionFolderName });
        cursor.continue();
      };
    }),
    succeed: (id) => run("readwrite", (uploads, state) => {
      uploads.delete(id);
      state.get(unreadableKey).onsuccess = (event) => {
        const ids = idList(event.target.result);
        if (ids.includes(id)) state.put(ids.filter((item) => item !== id), unreadableKey);
      };
    }),
    // detailは失敗した段階・HTTP番号・既知の理由コードだけ（呼び出し元で検証済み）。
    fail: (id, reason, nextRetryAt, detail = null) => run("readwrite", (uploads, state) => {
      // 読めない画像は画像のレコードを書き換えず、IDだけを記録する。
      // 以前の版のBlobを含むレコードは、書き戻すとiPhoneで失敗し、送信待ち全体を止め得る。
      if (reason === "unreadable") {
        state.get(unreadableKey).onsuccess = (found) => {
          const ids = idList(found.target.result);
          if (!ids.includes(id)) state.put([...ids, id], unreadableKey);
        };
        return;
      }
      uploads.get(id).onsuccess = (event) => {
        const record = event.target.result;
        if (!record) return;
        record.lastFailure = reason;
        record.lastFailureDetail = detail;
        record.nextRetryAt = nextRetryAt;
        uploads.put(record);
        if (reason === "authentication") state.put(true, "authenticationRequired");
      };
    }),
    resumeAuthentication: () => run("readwrite", (uploads, state) => {
      state.delete("authenticationRequired");
    }),
    close: () => {
      closed = true;
      db?.close();
      db = null;
    },
  };
}
