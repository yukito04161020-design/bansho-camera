import { sessionFolderName } from "./folder-logic.js";
import { DriveFolderError } from "./drive-folders.js";
import { UploadFailure } from "./upload-queue.js";

const api = "https://www.googleapis.com/drive/v3/files";
const uploadApi = "https://www.googleapis.com/upload/drive/v3/files";
const fields = "id,name,mimeType,size,parents,trashed";
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);

export function createDriveUpload({ session, folders, fetcher = globalThis.fetch,
  isActive = () => !globalThis.document?.hidden && globalThis.navigator?.onLine !== false } = {}) {
  if (typeof session?.accessToken !== "function" || typeof folders?.ensureSessionFolder !== "function"
    || typeof fetcher !== "function") throw new TypeError("認証・保存先・通信を指定してください。");
  const active = (signal) => { if (signal?.aborted || !isActive()) throw new UploadFailure("network"); };
  async function request(address, options, signal, allowed = []) {
    active(signal);
    let token;
    try { token = session.accessToken(); } catch { throw new UploadFailure("authentication"); }
    let response;
    try {
      response = await fetcher(address, {
        ...options, signal, credentials: "omit", redirect: "error",
        headers: { ...options?.headers, Authorization: `Bearer ${token}` },
      });
    } catch { throw new UploadFailure("network"); }
    active(signal);
    // 古い要求の401で、取り直した新しいセッションを無効にしない。
    try { if (session.accessToken() !== token) throw new UploadFailure("authentication"); }
    catch { throw new UploadFailure("authentication"); }
    if (response.status === 401) { session.invalidate(); throw new UploadFailure("authentication"); }
    if (!response.ok && !allowed.includes(response.status)) throw new UploadFailure(
      response.status === 403 ? "permission" : response.status === 429 || response.status >= 500 ? "server" : "upload");
    return response;
  }
  async function data(response, signal) {
    let value;
    try { value = await response.json(); } catch { throw new UploadFailure("upload"); }
    active(signal);
    return value;
  }
  function verified(file, item, id, name, folderId) {
    if (file?.id !== id || file.name !== name || file.mimeType !== item.blob.type
      || file.size !== String(item.blob.size) || file.trashed === true
      || !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== folderId) {
      throw new UploadFailure("upload");
    }
    return { ok: true };
  }
  return async (item, { persistDriveFileId, signal } = {}) => {
    try {
      const match = item.sessionFolderName?.match(/^第(\d+)回_\d{4}-\d{2}-\d{2}$/);
      const manualSession = match ? Number(match[1]) : NaN;
      if (!(item.blob instanceof Blob) || item.blob.type !== "image/jpeg" || !item.blob.size
        || !Number.isSafeInteger(item.id) || item.id < 1
        || sessionFolderName(manualSession, item.capturedAt) !== item.sessionFolderName) {
        throw new UploadFailure("upload");
      }
      active(signal);
      let id = item.driveFileId;
      if (id !== null && id !== undefined && !validId(id)) throw new UploadFailure("upload");
      if (!id) {
        if (typeof persistDriveFileId !== "function") throw new UploadFailure("upload");
        const generated = await data(await request(`${api}/generateIds?count=1&space=drive&type=files&fields=ids`, {}, signal), signal);
        if (!Array.isArray(generated?.ids) || generated.ids.length !== 1 || !validId(generated.ids[0])) {
          throw new UploadFailure("upload");
        }
        id = generated.ids[0];
        await persistDriveFileId(id);
        active(signal);
      }
      const destination = await folders.ensureSessionFolder({
        className: item.className, capturedAt: item.capturedAt, manualSession,
      }, { signal });
      if (!validId(destination?.folderId) || destination.name !== item.sessionFolderName) throw new UploadFailure("upload");
      const name = `板書_${new Date(item.capturedAt).toISOString().replace(/[:.]/g, "-")}_${item.id}.jpg`;
      const metadataUrl = `${api}/${id}?${new URLSearchParams({ fields })}`;
      const existing = await request(metadataUrl, {}, signal, [404]);
      if (existing.status !== 404) return verified(await data(existing, signal), item, id, name, destination.folderId);
      const start = await request(`${uploadApi}?${new URLSearchParams({ uploadType: "resumable", fields })}`, {
        method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": item.blob.type, "X-Upload-Content-Length": String(item.blob.size) },
        body: JSON.stringify({ id, name, mimeType: item.blob.type, parents: [destination.folderId] }),
      }, signal, [409]);
      if (start.status === 409) return verified(await data(await request(metadataUrl, {}, signal), signal),
        item, id, name, destination.folderId);
      // セッションURLはこの送信のメモリ内だけ。任意のホストへトークンや画像を送らない。
      let sessionUrl;
      try { sessionUrl = new URL(start.headers.get("Location")); }
      catch { throw new UploadFailure("upload"); }
      if (sessionUrl.origin !== "https://www.googleapis.com" || sessionUrl.username || sessionUrl.password
        || sessionUrl.pathname !== "/upload/drive/v3/files" || sessionUrl.hash
        || sessionUrl.searchParams.get("uploadType") !== "resumable" || !sessionUrl.searchParams.get("upload_id")) {
        throw new UploadFailure("upload");
      }
      const sent = await request(sessionUrl.href, {
        method: "PUT", headers: { "Content-Type": item.blob.type }, body: item.blob,
      }, signal);
      return verified(await data(sent, signal), item, id, name, destination.folderId);
    } catch (error) {
      if (error instanceof UploadFailure) throw error;
      if (error instanceof DriveFolderError) throw new UploadFailure(
        error.reason === "authentication" ? "authentication" : error.reason === "network" || error.reason === "cancelled" ? "network"
          : error.reason === "server" ? "server" : "permission");
      throw new UploadFailure("upload");
    }
  };
}
