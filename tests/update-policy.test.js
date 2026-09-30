import assert from "node:assert/strict";
import test from "node:test";
import { canApplyUpdate, createUpdateChecker } from "../public/update-policy.js";

const idle = { cameraActive: false, imagePreview: false, pageVisible: true, pendingUploads: 0 };
test("カメラ・画像確認・送信待ちがなく、前面にある場合だけ切り替える", () => {
  assert.equal(canApplyUpdate(idle), true);
  for (const blocked of [
    { cameraActive: true }, { imagePreview: true }, { pageVisible: false },
    { pendingUploads: 1 }, { pendingUploads: 50 }, { pendingUploads: -1 },
    { pendingUploads: undefined }, { pendingUploads: null }, { pendingUploads: "0" },
    { cameraActive: undefined }, { imagePreview: undefined }, { pageVisible: undefined },
  ]) {
    assert.equal(canApplyUpdate({ ...idle, ...blocked }), false, JSON.stringify(blocked));
  }
  assert.equal(canApplyUpdate(), false);
});

function fixture(overrides = {}) {
  const applied = [];
  const check = createUpdateChecker({
    currentVersion: "old",
    readLatestVersion: async () => "new",
    readPendingUploads: async () => 0,
    getActivity: () => idle,
    applyUpdate: (version) => applied.push(version),
    ...overrides,
  });
  return { check, applied };
}

test("新版だけを一度切り替え、同じ版では再読み込みしない", async () => {
  const updated = fixture();
  assert.equal(await updated.check(), "applied");
  assert.deepEqual(updated.applied, ["new"]);
  assert.equal(await updated.check(), "busy");
  const current = fixture({ readLatestVersion: async () => "old" });
  assert.equal(await current.check(), "current");
  assert.deepEqual(current.applied, []);
});

test("撮影中・画像確認中・送信待ちのときは新版を保留する", async () => {
  for (const overrides of [
    { getActivity: () => ({ ...idle, cameraActive: true }) },
    { getActivity: () => ({ ...idle, imagePreview: true }) },
    { getActivity: () => ({ ...idle, pageVisible: false }) },
    { readPendingUploads: async () => 3 },
    { readPendingUploads: async () => undefined },
  ]) {
    const sample = fixture(overrides);
    assert.equal(await sample.check(), "deferred");
    assert.deepEqual(sample.applied, []);
  }
});

test("版情報の取得中にカメラを開始した場合も切り替えない", async () => {
  let activity = idle;
  const sample = fixture({
    readLatestVersion: async () => {
      activity = { ...idle, cameraActive: true };
      return "new";
    },
    getActivity: () => activity,
  });
  assert.equal(await sample.check(), "deferred");
  assert.deepEqual(sample.applied, []);
});

test("送信待ち件数の取得中にカメラを開始した場合も切り替えない", async () => {
  let activity = idle;
  const sample = fixture({
    readPendingUploads: async () => {
      activity = { ...idle, cameraActive: true };
      return 0;
    },
    getActivity: () => activity,
  });
  assert.equal(await sample.check(), "deferred");
  assert.deepEqual(sample.applied, []);
});

test("保留後、安全になった次回の起動確認で切り替えられる", async () => {
  let pending = 1;
  const sample = fixture({ readPendingUploads: async () => pending });
  assert.equal(await sample.check(), "deferred");
  pending = 0;
  assert.equal(await sample.check(), "applied");
});

test("ログイン・作成・有効なトークンの保持中は更新を保留し、終了後に切り替える", async () => {
  let operationActive = true;
  const sample = fixture({ getActivity: () => ({ ...idle, operationActive }) });
  assert.equal(await sample.check(), "deferred");
  assert.deepEqual(sample.applied, []);
  operationActive = false;
  assert.equal(await sample.check(), "applied");
});

test("版確認中にログイン操作が始まった場合も更新を保留する", async () => {
  let operationActive = false;
  const sample = fixture({
    readPendingUploads: async () => { operationActive = true; return 0; },
    getActivity: () => ({ ...idle, operationActive }),
  });
  assert.equal(await sample.check(), "deferred");
  assert.deepEqual(sample.applied, []);
});

test("通信失敗・送信待ち取得失敗では切り替えず、後で再試行できる", async () => {
  for (const property of ["readLatestVersion", "readPendingUploads", "applyUpdate"]) {
    let failed = true;
    const sample = fixture({ [property]: () => {
      if (failed) throw new Error("取得失敗");
      return property === "readLatestVersion" ? "new" : 0;
    } });
    assert.equal(await sample.check(), "unavailable");
    assert.deepEqual(sample.applied, []);
    failed = false;
    assert.equal(await sample.check(), "applied");
  }
});

test("同時に起動確認が重なっても二重に切り替えない", async () => {
  let finish;
  const sample = fixture({ readLatestVersion: () => new Promise((resolve) => { finish = resolve; }) });
  const first = sample.check();
  assert.equal(await sample.check(), "busy");
  finish("new");
  assert.equal(await first, "applied");
  assert.deepEqual(sample.applied, ["new"]);
});
