import test from "node:test";
import assert from "node:assert/strict";
import { createDriveTimetable } from "../public/drive-timetable.js";
import { createDriveFolders } from "../public/drive-folders.js";
const record = { updatedAt: 5, entries: [{ id: "math", day: 1, period: "1限", className: "数学", start: "09:00", end: "10:00" }] };
const file = { id: "timetable", name: "時間割.json", mimeType: "application/json" };
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
function setup(responses, options = {}) {
  const calls = [];
  let invalidated = false;
  const session = { accessToken: () => "test-token", invalidate: () => { invalidated = true; } };
  const controller = new AbortController();
  const folders = { settingsFolder: async (args) => { calls.push({ folder: args }); return options.missingFolder ? null : { id: "settings" }; } };
  const drive = createDriveTimetable({ session, folders, signal: () => controller.signal,
    fetcher: async (url, init) => { calls.push({ url, init }); return responses.shift(); } });
  return { drive, calls, controller, invalidated: () => invalidated };
}
test("Driveの設定JSONを読む。ファイル・フォルダがない場合は未登録", async () => {
  const { drive, calls, controller } = setup([response({ files: [file] }), response(record)]);
  assert.deepEqual(await drive.read(), record);
  assert.equal(calls[0].folder.create, false);
  assert.match(new URL(calls[1].url).searchParams.get("q"), /'settings' in parents/);
  assert.equal(calls[2].url, "https://www.googleapis.com/drive/v3/files/timetable?alt=media");
  assert.equal(calls[2].init.signal, controller.signal);
  assert.equal(calls[2].init.headers.Authorization, "Bearer test-token");
  assert.equal(await setup([response({ files: [] })]).drive.read(), null);
  assert.equal(await setup([], { missingFolder: true }).drive.read(), null);
});
test("既存JSONをPATCHし、不足するJSONは設定フォルダへmultipartで作る", async () => {
  const existing = setup([response({ files: [file] }), response({ id: file.id })]);
  await existing.drive.write(record);
  assert.equal(existing.calls[0].folder.create, true);
  assert.equal(existing.calls[2].init.method, "PATCH");
  assert.deepEqual(JSON.parse(existing.calls[2].init.body), record);
  const missing = setup([response({ files: [] }), response({ id: file.id })]);
  await missing.drive.write(record);
  const request = missing.calls[2];
  assert.equal(request.init.method, "POST");
  assert.match(request.url, /uploadType=multipart/);
  assert.match(request.init.body, /"parents":\["settings"\]/);
  assert.match(request.init.body, /時間割.json/);
  assert.ok(request.init.body.includes(JSON.stringify(record)));
});
test("全ページ検索し、複数ファイル・不完全一覧・不正JSON・認証切れを成功扱いしない", async () => {
  const paged = setup([response({ files: [], nextPageToken: "next" }), response({ files: [file] }), response(record)]);
  assert.deepEqual(await paged.drive.read(), record);
  assert.equal(new URL(paged.calls[2].url).searchParams.get("pageToken"), "next");
  for (const data of [{ files: [file, { ...file, id: "duplicate" }] }, { files: [], incompleteSearch: true },
    { files: [{ ...file, mimeType: "text/plain" }] }]) {
    await assert.rejects(setup([response(data)]).drive.read());
  }
  await assert.rejects(setup([response({ files: [file] }), response({ updatedAt: 5, entries: [{ ...record.entries[0], className: "数学/演習" }] })]).drive.read());
  const expired = setup([response({}, 401)]);
  await assert.rejects(expired.drive.read());
  assert.equal(expired.invalidated(), true);
});
test("設定フォルダは板書直下から階層ごとに検索・再利用し、不足だけ作る", async () => {
  const requests = [];
  const folderType = "application/vnd.google-apps.folder";
  const responses = [response({ files: [{ id: "bansho", name: "板書", mimeType: folderType }] }),
    response({ files: [] }), response({ id: "settings", name: "設定", mimeType: folderType })];
  const folders = createDriveFolders({ session: { accessToken: () => "test", invalidate() {} },
    fetcher: async (url, init) => { requests.push({ url, init }); return responses.shift(); } });
  assert.deepEqual(await folders.settingsFolder({ create: true }), { id: "settings", name: "設定" });
  assert.match(new URL(requests[0].url).searchParams.get("q"), /'root' in parents/);
  assert.match(new URL(requests[1].url).searchParams.get("q"), /'bansho' in parents/);
  assert.deepEqual(JSON.parse(requests[2].init.body), { name: "設定", mimeType: folderType, parents: ["bansho"] });
});
