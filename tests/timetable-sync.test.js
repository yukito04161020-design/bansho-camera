import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { openUploadStore } from "../public/upload-store.js";
import { createTimetableSync } from "../public/timetable-sync.js";
const entries = [{ id: "math", day: 1, period: "1限", className: "数学", start: "09:00", end: "10:00" }];
const record = (updatedAt, items = entries) => ({ updatedAt, entries: items });
async function setup(local, remote, online = true) {
  const store = await openUploadStore({ indexedDB: new IDBFactory() });
  if (local) await store.writeTimetable(local);
  const calls = [];
  const state = { remote, online, fail: false };
  const drive = {
    read: async () => { calls.push("read"); if (state.fail) throw new Error("通信失敗"); return state.remote; },
    write: async (value) => { calls.push("write"); if (state.fail) throw new Error("通信失敗"); state.remote = value; },
  };
  return { store, calls, state, sync: createTimetableSync({ store, drive, canSync: () => state.online, now: () => 100 }) };
}
test("Driveの新しい内容をIndexedDBへ戻し、再インストール時も復元する", async () => {
  for (const local of [null, record(1)]) {
    const { store, sync, calls } = await setup(local, record(2, []));
    assert.deepEqual(await sync.load(), record(2, []));
    assert.deepEqual(await store.readTimetable(), record(2, []));
    assert.deepEqual(calls, ["read"]);
    store.close();
  }
});
test("端末が新しければDriveへ送り、同時刻では再送しない", async () => {
  const { sync, state, calls, store } = await setup(record(3), record(2));
  assert.deepEqual(await sync.load(), record(3));
  assert.deepEqual(state.remote, record(3));
  await sync.load();
  assert.deepEqual(calls, ["read", "write", "read"]);
  store.close();
});
test("未ログイン・オフラインで保存し、次のログインでDriveへ送る。削除も同期する", async () => {
  const { sync, state, calls, store } = await setup(null, null, false);
  assert.equal(await sync.load(), null);
  assert.deepEqual(await sync.save(entries), record(100));
  assert.deepEqual(calls, []);
  state.online = true;
  await sync.load();
  assert.deepEqual(state.remote, record(100));
  await sync.save([]);
  assert.deepEqual(state.remote, record(101, []));
  store.close();
});
test("通信失敗でも端末の保存完了を保持し、開き直してから再送する", async () => {
  const { sync, state, store } = await setup(record(1), record(1));
  state.fail = true;
  await assert.rejects(sync.save(entries));
  assert.deepEqual(await store.readTimetable(), record(100));
  state.fail = false;
  await sync.load();
  assert.deepEqual(state.remote, record(100));
  store.close();
});
test("保存でもDriveが新しい場合はそちらを使い、並行した保存は直列に処理する", async () => {
  const { sync, state, store } = await setup(record(1), record(1000));
  assert.deepEqual(await sync.save([]), record(1000));
  await Promise.all([sync.save([]), sync.save(entries)]);
  assert.deepEqual(state.remote, record(1002));
  store.close();
});
