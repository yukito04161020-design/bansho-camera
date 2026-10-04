import { timetableRecord } from "./timetable-logic.js";

const endpoint = "https://www.googleapis.com/drive/v3/files";
const fileName = "時間割.json";
export function createDriveTimetable({ session, folders, fetcher = globalThis.fetch, signal = () => undefined }) {
  async function request(url, options = {}) {
    let token;
    try { token = session.accessToken(); } catch { throw new Error("時間割の同期にはGoogleログインが必要です。"); }
    let response;
    try {
      response = await fetcher(url, { ...options, signal: signal(), credentials: "omit", redirect: "error",
        headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    } catch { throw new Error("時間割の通信を完了できませんでした。端末内の内容は残っています。"); }
    if (response.status === 401) session.invalidate();
    if (!response.ok) throw new Error("時間割を同期できません。Googleログインと通信を確認してください。");
    try { return await response.json(); } catch { throw new Error("ドライブの時間割を確認できません。"); }
  }
  async function find(create) {
    const folder = await folders.settingsFolder({ create, signal: signal() });
    if (!folder) return null;
    const files = new Map();
    const pages = new Set();
    const params = { q: `'${folder.id}' in parents and name = '${fileName}' and trashed = false`,
      spaces: "drive", fields: "nextPageToken,incompleteSearch,files(id,name,mimeType)", pageSize: "1000" };
    for (;;) {
      const data = await request(`${endpoint}?${new URLSearchParams(params)}`);
      if (data.incompleteSearch || !Array.isArray(data.files)) throw new Error("時間割の一覧を最後まで確認できません。");
      for (const file of data.files) {
        if (!/^[A-Za-z0-9_-]+$/.test(file.id) || file.name !== fileName || file.mimeType !== "application/json") {
          throw new Error("時間割ファイルの種類を確認できません。");
        }
        files.set(file.id, file);
      }
      if (!data.nextPageToken) break;
      if (typeof data.nextPageToken !== "string" || pages.has(data.nextPageToken)) throw new Error("時間割の一覧を最後まで確認できません。");
      pages.add(data.nextPageToken);
      params.pageToken = data.nextPageToken;
    }
    if (files.size > 1) throw new Error("時間割.jsonが複数あります。ドライブで整理してください。");
    return { folder, file: [...files.values()][0] || null };
  }
  return {
    async read() {
      const found = await find(false);
      if (!found?.file) return null;
      return timetableRecord(await request(`${endpoint}/${found.file.id}?alt=media`));
    },
    async write(input) {
      const value = timetableRecord(input);
      const found = await find(true);
      if (found.file) {
        await request(`https://www.googleapis.com/upload/drive/v3/files/${found.file.id}?uploadType=media`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
        });
      } else {
        const boundary = "bansho_timetable_boundary";
        const metadata = { name: fileName, mimeType: "application/json", parents: [found.folder.id] };
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
          + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n--${boundary}--`;
        await request("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
          method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
        });
      }
    },
  };
}
