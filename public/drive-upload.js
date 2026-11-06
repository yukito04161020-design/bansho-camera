import { sessionFolderName, FolderNameError } from "./folder-logic.js";
import { DriveFolderError, driveErrorCode } from "./drive-folders.js";
import { UploadFailure } from "./upload-queue.js";

const api = "https://www.googleapis.com/drive/v3/files";
const uploadApi = "https://www.googleapis.com/upload/drive/v3/files";
const fields = "id,name,mimeType,size,parents,trashed";
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const rateLimits = new Set(["userRateLimitExceeded", "rateLimitExceeded", "dailyLimitExceeded", "sharingRateLimitExceeded"]);

// Driveの403は理由コードで区別する。容量不足と利用制限は、権限の問題として伝えない。
export function failureReason(status, code) {
  if (status === 403 && code === "storageQuotaExceeded") return "quota";
  if (status === 403 && rateLimits.has(code)) return "server";
  if (status === 403) return "permission";
  return status === 429 || status >= 500 ? "server" : "upload";
}

function folderReason(error) {
  if (error.reason === "authentication") return "authentication";
  if (error.reason === "network" || error.reason === "cancelled") return "network";
  if (error.reason === "server") return "server";
  // 403だけを権限の問題とし、同名フォルダの重複やフォルダ情報の不備は別の理由で伝える。
  if (error.reason === "permission") return failureReason(403, error.code);
  return error.reason === "ambiguous" ? "duplicate-folder" : "folder";
}

export function createDriveUpload({ session, folders, fetcher = globalThis.fetch,
  isActive = () => !globalThis.document?.hidden && globalThis.navigator?.onLine !== false } = {}) {
  if (typeof session?.accessToken !== "function" || typeof folders?.ensureSessionFolder !== "function"
    || typeof fetcher !== "function") throw new TypeError("認証・保存先・通信を指定してください。");
  const active = (signal, stage) => { if (signal?.aborted || !isActive()) throw new UploadFailure("network", { stage }); };
  // stageは失敗した段階の表示用。HTTP番号とDriveの既知の理由コードだけを添える。
  async function request(address, options, signal, stage, allowed = []) {
    active(signal, stage);
    let token;
    try { token = session.accessToken(); } catch { throw new UploadFailure("authentication", { stage }); }
    let response;
    try {
      response = await fetcher(address, {
        ...options, signal, credentials: "omit", redirect: "error",
        headers: { ...options?.headers, Authorization: `Bearer ${token}` },
      });
    } catch { throw new UploadFailure("network", { stage }); }
    active(signal, stage);
    // 古い要求の401で、取り直した新しいセッションを無効にしない。
    try { if (session.accessToken() !== token) throw new UploadFailure("authentication"); }
    catch { throw new UploadFailure("authentication", { stage }); }
    if (response.status === 401) { session.invalidate(); throw new UploadFailure("authentication", { stage, status: 401 }); }
    if (!response.ok && !allowed.includes(response.status)) {
      const code = await driveErrorCode(response);
      throw new UploadFailure(failureReason(response.status, code), { stage, status: response.status, code });
    }
    return response;
  }
  async function data(response, signal, stage) {
    let value;
    try { value = await response.json(); } catch { throw new UploadFailure("upload", { stage }); }
    active(signal, stage);
    return value;
  }
  function verified(file, item, id, name, { folderId, name: folderName }) {
    if (file?.id !== id || file.name !== name || file.mimeType !== item.blob.type
      || file.size !== String(item.blob.size) || file.trashed === true
      || !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== folderId) {
      throw new UploadFailure("upload", { stage: "verify" });
    }
    // 送信できた保存先の名前を返し、端末内の回一覧に加えられるようにする。
    return { ok: true, folderName };
  }
  return async (item, { persistDriveFileId, signal, progress } = {}) => {
    let stage = "read";
    // 送信待ち側の制限時間で止まったときに、応答がなかった段階を伝える。
    const step = (value) => {
      stage = value;
      try { progress?.(value); } catch { /* 表示用の通知で送信を止めない。 */ }
    };
    try {
      const match = item.sessionFolderName?.match(/^第(\d+)回_\d{4}-\d{2}-\d{2}$/);
      const manualSession = match ? Number(match[1]) : NaN;
      if (!(item.blob instanceof Blob) || item.blob.type !== "image/jpeg" || !item.blob.size
        || !Number.isSafeInteger(item.id) || item.id < 1
        || sessionFolderName(manualSession, item.capturedAt) !== item.sessionFolderName) {
        throw new UploadFailure("upload", { stage });
      }
      active(signal, stage);
      let id = item.driveFileId;
      if (id !== null && id !== undefined && !validId(id)) throw new UploadFailure("upload", { stage });
      if (!id) {
        step("id");
        if (typeof persistDriveFileId !== "function") throw new UploadFailure("upload", { stage });
        const generated = await data(await request(`${api}/generateIds?count=1&space=drive&type=files&fields=ids`, {}, signal, stage), signal, stage);
        if (!Array.isArray(generated?.ids) || generated.ids.length !== 1 || !validId(generated.ids[0])) {
          throw new UploadFailure("upload", { stage });
        }
        id = generated.ids[0];
        await persistDriveFileId(id);
        active(signal, stage);
      }
      step("folder");
      let destination;
      let renumbered = false;
      try {
        destination = await folders.ensureSessionFolder({
          className: item.className, capturedAt: item.capturedAt, manualSession,
        }, { signal });
      } catch (error) {
        if (!(error instanceof FolderNameError && error.reason === "collision")) throw error;
        // 撮影時の回の番号が、古い回一覧のためにDriveで別の日付に使われていた場合。
        // 日付と授業は撮影時のまま、同じ日付のフォルダがあればそこへ、なければ次の番号で保存する。
        renumbered = true;
        destination = await folders.ensureSessionFolder({ className: item.className, capturedAt: item.capturedAt }, { signal });
      }
      const dateSuffix = item.sessionFolderName.slice(item.sessionFolderName.indexOf("_"));
      if (!validId(destination?.folderId) || (renumbered
        ? !/^第[0-9]+回_/.test(destination.name) || !destination.name.endsWith(dateSuffix)
        : destination.name !== item.sessionFolderName)) throw new UploadFailure("upload", { stage });
      const name = `板書_${new Date(item.capturedAt).toISOString().replace(/[:.]/g, "-")}_${item.id}.jpg`;
      const metadataUrl = `${api}/${id}?${new URLSearchParams({ fields })}`;
      step("check");
      const existing = await request(metadataUrl, {}, signal, stage, [404]);
      if (existing.status !== 404) {
        step("verify");
        return verified(await data(existing, signal, stage), item, id, name, destination);
      }
      step("start");
      const start = await request(`${uploadApi}?${new URLSearchParams({ uploadType: "resumable", fields })}`, {
        method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": item.blob.type, "X-Upload-Content-Length": String(item.blob.size) },
        body: JSON.stringify({ id, name, mimeType: item.blob.type, parents: [destination.folderId] }),
      }, signal, stage, [409]);
      if (start.status === 409) {
        step("verify");
        return verified(await data(await request(metadataUrl, {}, signal, stage), signal, stage),
          item, id, name, destination);
      }
      // セッションURLはこの送信のメモリ内だけ。任意のホストへトークンや画像を送らない。
      let sessionUrl;
      try { sessionUrl = new URL(start.headers.get("Location")); }
      catch { throw new UploadFailure("upload", { stage }); }
      if (sessionUrl.origin !== "https://www.googleapis.com" || sessionUrl.username || sessionUrl.password
        || sessionUrl.pathname !== "/upload/drive/v3/files" || sessionUrl.hash
        || sessionUrl.searchParams.get("uploadType") !== "resumable" || !sessionUrl.searchParams.get("upload_id")) {
        throw new UploadFailure("upload", { stage });
      }
      step("send");
      const sent = await request(sessionUrl.href, {
        method: "PUT", headers: { "Content-Type": item.blob.type }, body: item.blob,
      }, signal, stage);
      step("verify");
      return verified(await data(sent, signal, stage), item, id, name, destination);
    } catch (error) {
      if (error instanceof UploadFailure) throw error;
      // 授業名や回の番号の規則に合わないときは、送信の失敗ではなく保存先の問題として伝える。
      if (error instanceof FolderNameError) throw new UploadFailure("folder", { stage: "folder" });
      if (error instanceof DriveFolderError) {
        throw new UploadFailure(folderReason(error), { stage: "folder", status: error.status, code: error.code });
      }
      throw new UploadFailure("upload", { stage });
    }
  };
}
