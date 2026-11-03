import test from "node:test";
import assert from "node:assert/strict";
import { createPendingBackup, backupFileName } from "../public/photo-backup.js";

const images = [{ id: 1, capturedAt: Date.parse("2026-10-06T09:00:00+09:00") }, { id: 2, capturedAt: Date.parse("2026-10-06T09:05:00+09:00") }];
const jpeg = (text) => new Blob([text], { type: "image/jpeg" });

test("読める画像だけを写真用に準備し、読めない画像は数えて残す", async () => {
  const shared = [];
  const backup = createPendingBackup({
    list: async () => images,
    read: async (id) => { if (id === 2) throw new Error("読めない"); return jpeg("first"); },
    navigator: { canShare: () => true, share: async (data) => { shared.push(data.files); } },
  });
  assert.equal(backup.ready(), false);
  assert.deepEqual(await backup.prepare(), { count: 1, unreadable: 1 });
  assert.equal(backup.ready(), true);
  assert.equal(await backup.share(), "shared");
  assert.equal(shared[0].length, 1);
  assert.equal(shared[0][0].name, backupFileName(images[0]));
  assert.equal(shared[0][0].name, "板書_2026-10-06T00-00-00-000Z_1.jpg");
  assert.equal(await shared[0][0].text(), "first");
  assert.equal(backup.ready(), false);
});

test("共有を取りやめても準備した画像を保持し、非対応・空のときは共有しない", async () => {
  const cancelled = createPendingBackup({ list: async () => images, read: async () => jpeg("x"),
    navigator: { canShare: () => true, share: async () => { throw Object.assign(new Error(), { name: "AbortError" }); } } });
  await cancelled.prepare();
  assert.equal(await cancelled.share(), "cancelled");
  assert.equal(cancelled.ready(), true);
  const unsupported = createPendingBackup({ list: async () => images, read: async () => jpeg("x"), navigator: {} });
  await unsupported.prepare();
  assert.equal(await unsupported.share(), "unsupported");
  const empty = createPendingBackup({ list: async () => [], read: async () => null, navigator: { canShare: () => true, share: async () => {} } });
  assert.deepEqual(await empty.prepare(), { count: 0, unreadable: 0 });
  assert.equal(await empty.share(), "empty");
});
