import { timetableRecord, manualLessonRecord } from "./timetable-logic.js";
import { captureSettings } from "./capture-save.js";

export class QueueStorageError extends Error {
  constructor() { super("送信待ちを端末内に保存・読み込みできませんでした。"); this.name = "QueueStorageError"; }
}
export class ImageUnreadableError extends Error {
  constructor() { super("端末内の画像を読み込めませんでした。"); this.name = "ImageUnreadableError"; }
}

// リクエスト成功だけで保存完了とせず、トランザクション完了を待つ。
function transaction(db, mode, action) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(["uploads", "state"], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(new QueueStorageError());
      tx.onerror = () => {}; // abortで固定文言を返し、外部のエラー内容を保存しない。
      try { action(tx.objectStore("uploads"), tx.objectStore("state"), (value) => { result = value; }); }
      catch { tx.abort(); }
    } catch { reject(new QueueStorageError()); }
  });
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
async function imageBytes(blob) {
  let bytes;
  try { bytes = await blob.arrayBuffer(); } catch { throw new ImageUnreadableError(); }
  if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength !== blob.size) throw new ImageUnreadableError();
  return bytes;
}
// 読めない画像のIDはstateに別に持ち、件数の確認のたびに全画像を読み込まない。
const unreadableKey = "unreadableIds";
const idList = (value) => Array.isArray(value) ? value.filter(Number.isSafeInteger) : [];

export async function openUploadStore({ indexedDB = globalThis.indexedDB, databaseName = "bansho-camera-uploads" } = {}) {
  const db = await new Promise((resolve, reject) => {
    let rejected = false;
    try {
      const request = indexedDB.open(databaseName, 1);
      const fail = () => { rejected = true; reject(new QueueStorageError()); };
      request.onerror = fail;
      request.onblocked = fail;
      request.onupgradeneeded = () => {
        const uploads = request.result.createObjectStore("uploads", { keyPath: "id", autoIncrement: true });
        uploads.createIndex("captureOrder", ["capturedAt", "id"]);
        request.result.createObjectStore("state");
      };
      request.onsuccess = () => {
        if (rejected) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    } catch { reject(new QueueStorageError()); }
  });
  return {
    databaseName,
    async add(input) {
      const { blob, ...fields } = imageRecord(input);
      // 読み出しはトランザクションの外で済ませる。待機中にトランザクションが閉じるのを防ぐ。
      const record = { ...fields, bytes: await imageBytes(blob), type: blob.type };
      return transaction(db, "readwrite", (uploads, state, done) => {
        uploads.add(record).onsuccess = (event) => done(event.target.result);
      });
    },
    // 送信・写真への保存に使うBlobを返す。読めないときはImageUnreadableErrorで、記録は消さない。
    async readImage(id) {
      const record = await transaction(db, "readonly", (uploads, state, done) => {
        uploads.get(id).onsuccess = (event) => done(event.target.result || null);
      });
      if (!record) return null;
      if (record.bytes instanceof ArrayBuffer && record.bytes.byteLength) {
        return new Blob([record.bytes], { type: record.type || "image/jpeg" });
      }
      if (!(record.blob instanceof Blob)) throw new ImageUnreadableError();
      const bytes = await imageBytes(record.blob);
      // 以前の版で保存した画像は、読めたときにバイト列も書き足す。元のBlobは送信完了まで残す。
      try {
        await transaction(db, "readwrite", (uploads) => {
          uploads.get(id).onsuccess = (event) => {
            const current = event.target.result;
            if (!current || current.bytes instanceof ArrayBuffer) return;
            current.bytes = bytes;
            current.type = record.blob.type;
            uploads.put(current);
          };
        });
      } catch { /* 書き足せなくても今回の送信には読めたデータを使う。 */ }
      return new Blob([bytes], { type: record.blob.type });
    },
    // 写真への保存用。画像本体は含めず、読み出しはreadImageで1件ずつ行う。
    images: () => transaction(db, "readonly", (uploads, state, done) => {
      const images = [];
      done(images);
      uploads.index("captureOrder").openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        images.push({ id: cursor.value.id, capturedAt: cursor.value.capturedAt, className: cursor.value.className });
        cursor.continue();
      };
    }),
    // 読めなかった画像も、利用者の再開操作でもう一度読み出しを試す。
    retryUnreadable: () => transaction(db, "readwrite", (uploads, state) => {
      state.get(unreadableKey).onsuccess = (event) => {
        for (const id of idList(event.target.result)) {
          uploads.get(id).onsuccess = (found) => {
            const record = found.target.result;
            if (record) uploads.put({ ...record, lastFailure: null, nextRetryAt: 0 });
          };
        }
        state.delete(unreadableKey);
      };
    }),
    count: () => transaction(db, "readonly", (uploads, state, done) => {
      uploads.count().onsuccess = (event) => done(event.target.result);
    }),
    snapshot: () => transaction(db, "readonly", (uploads, state, done) => {
      const snapshot = { pendingCount: 0, unreadableCount: 0, head: null, authenticationRequired: false };
      done(snapshot);
      uploads.count().onsuccess = (event) => { snapshot.pendingCount = event.target.result; };
      // 読めない画像は送信の先頭にせず、後の画像の送信を止めない。
      state.get(unreadableKey).onsuccess = (event) => {
        const skipped = new Set(idList(event.target.result));
        snapshot.unreadableCount = skipped.size;
        uploads.index("captureOrder").openCursor().onsuccess = (found) => {
          const cursor = found.target.result;
          if (!cursor) return;
          if (skipped.has(cursor.value.id)) { cursor.continue(); return; }
          snapshot.head = cursor.value;
        };
      };
      state.get("authenticationRequired").onsuccess = (event) => { snapshot.authenticationRequired = event.target.result === true; };
    }),
    beginAttempt: (id) => transaction(db, "readwrite", (uploads, state, done) => {
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
      return transaction(db, "readwrite", (uploads, state, done) => {
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
    readCaptureSettings: () => transaction(db, "readonly", (uploads, state, done) => {
      state.get("captureSettings").onsuccess = (event) => {
        try { done(captureSettings(event.target.result)); } catch { done(captureSettings()); }
      };
    }),
    writeCaptureSettings: (input) => {
      const value = captureSettings(input);
      return transaction(db, "readwrite", (uploads, state) => { state.put(value, "captureSettings"); });
    },
    readManualLesson: () => transaction(db, "readonly", (uploads, state, done) => {
      state.get("manualLesson").onsuccess = (event) => {
        try { done(manualLessonRecord(event.target.result)); }
        catch { event.target.transaction.abort(); }
      };
    }),
    writeManualLesson: (input) => {
      const value = manualLessonRecord(input);
      return transaction(db, "readwrite", (uploads, state) => { state.put(value, "manualLesson"); });
    },
    readTimetable: () => transaction(db, "readonly", (uploads, state, done) => {
      state.get("timetable").onsuccess = (event) => {
        try { done(event.target.result ? timetableRecord(event.target.result) : null); }
        catch { event.target.transaction.abort(); }
      };
    }),
    writeTimetable: (input) => {
      const value = timetableRecord(input);
      return transaction(db, "readwrite", (uploads, state) => { state.put(value, "timetable"); });
    },
    pendingDestinations: () => transaction(db, "readonly", (uploads, state, done) => {
      const destinations = [];
      done(destinations);
      uploads.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        destinations.push({ className: cursor.value.className, sessionFolderName: cursor.value.sessionFolderName });
        cursor.continue();
      };
    }),
    succeed: (id) => transaction(db, "readwrite", (uploads, state) => {
      uploads.delete(id);
      state.get(unreadableKey).onsuccess = (event) => {
        const ids = idList(event.target.result);
        if (ids.includes(id)) state.put(ids.filter((item) => item !== id), unreadableKey);
      };
    }),
    fail: (id, reason, nextRetryAt) => transaction(db, "readwrite", (uploads, state) => {
      uploads.get(id).onsuccess = (event) => {
        const record = event.target.result;
        if (!record) return;
        record.lastFailure = reason;
        record.nextRetryAt = nextRetryAt;
        uploads.put(record);
        if (reason === "authentication") state.put(true, "authenticationRequired");
        if (reason === "unreadable") {
          state.get(unreadableKey).onsuccess = (found) => {
            const ids = idList(found.target.result);
            if (!ids.includes(id)) state.put([...ids, id], unreadableKey);
          };
        }
      };
    }),
    resumeAuthentication: () => transaction(db, "readwrite", (uploads, state) => {
      state.delete("authenticationRequired");
    }),
    close: () => db.close(),
  };
}
