import { classFolderName, chooseSessionFolder } from "./folder-logic.js";

const endpoint = "https://www.googleapis.com/drive/v3/files";
const folderType = "application/vnd.google-apps.folder";
const messages = {
  authentication: "Googleの認証を取り直してください。",
  permission: "ドライブのフォルダを操作する権限を確認してください。",
  network: "ドライブとの通信が完了しませんでした。",
  server: "ドライブが混み合っています。時間をおいて再試行してください。",
  response: "ドライブのフォルダ情報を確認できませんでした。",
  incomplete: "フォルダ一覧を最後まで確認できませんでした。再試行してください。",
  ambiguous: "同じ場所に同名フォルダが複数あります。ドライブで整理してください。",
  cancelled: "フォルダ操作を中断しました。",
};

// 外部のエラー本文や認証情報は保存も返却もしない。
export class DriveFolderError extends Error {
  constructor(reason) {
    super(messages[reason] || messages.response);
    this.name = "DriveFolderError";
    this.reason = Object.hasOwn(messages, reason) ? reason : "response";
  }
}

const literal = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
const checkCancelled = (signal) => { if (signal?.aborted) throw new DriveFolderError("cancelled"); };
function folder(file) {
  if (!file || !validId(file.id) || typeof file.name !== "string" || !file.name
    || file.mimeType !== folderType) throw new DriveFolderError("response");
  return { id: file.id, name: file.name };
}
function uniqueNamed(files, name) {
  const matches = files.filter((file) => file.name === name);
  if (matches.length > 1) throw new DriveFolderError("ambiguous");
  return matches[0] || null;
}

// 認証は既存のTokenSessionに任せる。画面への接続と送信は別のIssueで扱う。
export function createDriveFolders({ session, fetcher = globalThis.fetch } = {}) {
  if (typeof session?.accessToken !== "function" || typeof session?.invalidate !== "function"
    || typeof fetcher !== "function") throw new TypeError("認証セッションと通信関数を指定してください。");
  let writing = Promise.resolve();
  const serialize = (operation) => {
    const result = writing.then(operation);
    writing = result.catch(() => {});
    return result;
  };
  async function request(params, { method = "GET", body, signal } = {}) {
    checkCancelled(signal);
    let token;
    try { token = session.accessToken(); }
    catch { throw new DriveFolderError("authentication"); }
    let response;
    try {
      response = await fetcher(`${endpoint}?${new URLSearchParams(params)}`, {
        method, signal, credentials: "omit", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      checkCancelled(signal);
      throw new DriveFolderError("network");
    }
    checkCancelled(signal);
    if (response.status === 401) {
      session.invalidate();
      throw new DriveFolderError("authentication");
    }
    if (!response.ok) throw new DriveFolderError(response.status === 403 ? "permission"
      : response.status === 429 || response.status >= 500 ? "server" : "response");
    let data;
    try { data = await response.json(); }
    catch { checkCancelled(signal); throw new DriveFolderError("response"); }
    checkCancelled(signal);
    return data;
  }
  async function list(parent, name, signal) {
    const q = `mimeType = ${literal(folderType)} and trashed = false and ${literal(parent)} in parents`
      + (name === undefined ? "" : ` and name = ${literal(name)}`);
    const params = { q, spaces: "drive", corpora: "user", pageSize: "1000",
      fields: "nextPageToken,incompleteSearch,files(id,name,mimeType)" };
    const files = new Map();
    const seenPages = new Set();
    for (;;) {
      const data = await request(params, { signal });
      if (data?.incompleteSearch === true) throw new DriveFolderError("incomplete");
      if (!Array.isArray(data?.files) || (data.nextPageToken !== undefined && typeof data.nextPageToken !== "string")
        || (data.incompleteSearch !== undefined && typeof data.incompleteSearch !== "boolean")) {
        throw new DriveFolderError("response");
      }
      for (const file of data.files) {
        const item = folder(file);
        const previous = files.get(item.id);
        if (previous && previous.name !== item.name) throw new DriveFolderError("response");
        files.set(item.id, item);
      }
      if (!data.nextPageToken) return [...files.values()];
      if (seenPages.has(data.nextPageToken)) throw new DriveFolderError("incomplete");
      seenPages.add(data.nextPageToken);
      params.pageToken = data.nextPageToken;
    }
  }
  async function find(parent, name, signal) { return uniqueNamed(await list(parent, name, signal), name); }
  async function ensure(parent, name, signal) {
    const existing = await find(parent, name, signal);
    if (existing) return existing;
    // POSTはここで再送しない。結果不明なら次の呼び出しで必ず再検索する。
    const created = folder(await request({ fields: "id,name,mimeType" }, {
      method: "POST", body: { name, mimeType: folderType, parents: [parent] }, signal,
    }));
    if (created.name !== name) throw new DriveFolderError("response");
    return created;
  }
  function validate({ className, capturedAt, manualSession }) {
    classFolderName(className);
    chooseSessionFolder([], capturedAt, manualSession);
  }
  function proposal(files, capturedAt, manualSession) {
    const name = chooseSessionFolder(files.map((file) => file.name), capturedAt, manualSession);
    return { name, folderId: uniqueNamed(files, name)?.id || null };
  }
  return {
    async settingsFolder({ create = false, signal } = {}) {
      const root = create ? await ensure("root", "板書", signal) : await find("root", "板書", signal);
      if (!root) return null;
      return create ? ensure(root.id, "設定", signal) : find(root.id, "設定", signal);
    },
    async listSessionFolders(className, { signal } = {}) {
      classFolderName(className);
      const root = await find("root", "板書", signal);
      const lesson = root && await find(root.id, className, signal);
      return lesson ? list(lesson.id, undefined, signal) : [];
    },
    async listClasses({ signal } = {}) {
      const root = await find("root", "板書", signal);
      if (!root) return [];
      const classes = (await list(root.id, undefined, signal)).filter((file) => {
        try { classFolderName(file.name); return file.name !== "設定"; } catch { return false; }
      });
      const names = new Set();
      for (const file of classes) {
        if (names.has(file.name)) throw new DriveFolderError("ambiguous");
        names.add(file.name);
      }
      return classes.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    },
    async suggestSession(input, { signal } = {}) {
      validate(input);
      const root = await find("root", "板書", signal);
      const lesson = root && await find(root.id, input.className, signal);
      const files = lesson ? await list(lesson.id, undefined, signal) : [];
      return proposal(files, input.capturedAt, input.manualSession);
    },
    ensureSessionFolder(input, { signal } = {}) {
      // 非同期の待機中に呼び出し元が引数を書き換えても対象を変更しない。
      const capturedAt = input.capturedAt instanceof Date ? new Date(input.capturedAt) : input.capturedAt;
      const selection = { className: input.className, capturedAt, manualSession: input.manualSession };
      validate(selection);
      return serialize(async () => {
        checkCancelled(signal);
        const root = await ensure("root", "板書", signal);
        const lesson = await ensure(root.id, selection.className, signal);
        const files = await list(lesson.id, undefined, signal);
        const selected = proposal(files, selection.capturedAt, selection.manualSession);
        if (selected.folderId) return selected;
        const created = await ensure(lesson.id, selected.name, signal);
        return { name: created.name, folderId: created.id };
      });
    },
  };
}
