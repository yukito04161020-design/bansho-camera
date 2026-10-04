import { timetableRecord, manualLessonRecord } from "./timetable-logic.js";
import { captureSettings } from "./capture-save.js";

export class QueueStorageError extends Error {
  constructor() { super("送信待ちを端末内に保存・読み込みできませんでした。"); this.name = "QueueStorageError"; }
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
      const record = imageRecord(input);
      return transaction(db, "readwrite", (uploads, state, done) => {
        uploads.add(record).onsuccess = (event) => done(event.target.result);
      });
    },
    count: () => transaction(db, "readonly", (uploads, state, done) => {
      uploads.count().onsuccess = (event) => done(event.target.result);
    }),
    snapshot: () => transaction(db, "readonly", (uploads, state, done) => {
      const snapshot = { pendingCount: 0, head: null, authenticationRequired: false };
      done(snapshot);
      uploads.count().onsuccess = (event) => { snapshot.pendingCount = event.target.result; };
      uploads.index("captureOrder").openCursor().onsuccess = (event) => { snapshot.head = event.target.result?.value || null; };
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
    succeed: (id) => transaction(db, "readwrite", (uploads) => { uploads.delete(id); }),
    fail: (id, reason, nextRetryAt) => transaction(db, "readwrite", (uploads, state) => {
      uploads.get(id).onsuccess = (event) => {
        const record = event.target.result;
        if (!record) return;
        record.lastFailure = reason;
        record.nextRetryAt = nextRetryAt;
        uploads.put(record);
        if (reason === "authentication") state.put(true, "authenticationRequired");
      };
    }),
    resumeAuthentication: () => transaction(db, "readwrite", (uploads, state) => {
      state.delete("authenticationRequired");
    }),
    close: () => db.close(),
  };
}
