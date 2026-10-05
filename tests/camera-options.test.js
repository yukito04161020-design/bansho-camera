import assert from "node:assert/strict";
import test from "node:test";
import { applyTrackZoom, cameraOptions, normalizeZoom, openSelectedCamera, readCameraPreference, writeCameraPreference, zoomRange } from "../public/camera-options.js";

test("許可後の一覧から映像入力を重複なく選び、名前がない場合も案内する", () => {
  assert.deepEqual(cameraOptions([
    { kind: "audioinput", deviceId: "mic", label: "マイク" },
    { kind: "videoinput", deviceId: "tele", label: "背面望遠カメラ" },
    { kind: "videoinput", deviceId: "tele", label: "重複" },
    { kind: "videoinput", deviceId: "wide", label: "" },
    { kind: "videoinput", deviceId: "", label: "未許可" },
  ]), [{ deviceId: "tele", label: "背面望遠カメラ" }, { deviceId: "wide", label: "カメラ 2（名前未取得）" }]);
});

test("選んだカメラと倍率を記憶し、再読み込みで復元する", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const preference = { deviceId: "tele", zoom: 3.5 };
  assert.equal(writeCameraPreference(storage, preference), true);
  assert.deepEqual(readCameraPreference(storage), preference);
});

test("壊れた設定・保存拒否・不正な倍率でも検証を続ける", () => {
  const empty = { deviceId: "", zoom: null };
  for (const value of ["{", "null", '{}', '{"deviceId":42,"zoom":-1}']) {
    assert.deepEqual(readCameraPreference({ getItem: () => value }), empty);
  }
  assert.deepEqual(readCameraPreference(undefined), empty);
  assert.equal(writeCameraPreference(undefined, empty), false);
  assert.deepEqual(readCameraPreference({ getItem: () => { throw new Error("denied"); } }), empty);
});

test("ズーム非対応・不正な範囲は操作不可、step未提供には刻みを補う", () => {
  for (const zoom of [undefined, {}, { min: 0, max: 4 }, { min: 2, max: 1 }, { min: 1, max: Infinity }]) {
    assert.equal(zoomRange({ zoom }), null);
  }
  assert.deepEqual(zoomRange({ zoom: { min: 1, max: 4 } }), { min: 1, max: 4, step: 0.03 });
  assert.deepEqual(zoomRange({ zoom: { min: 1, max: 1 } }), { min: 1, max: 1, step: 1 });
});

test("記憶した倍率を新しいカメラの範囲と刻みに収める", () => {
  const range = { min: 1, max: 4, step: 0.5 };
  assert.equal(normalizeZoom(100, range), 4);
  assert.equal(normalizeZoom(-1, range), 1);
  assert.equal(normalizeZoom(null, range), 1);
  assert.equal(normalizeZoom(2.3, range), 2.5);
  assert.equal(normalizeZoom(4, { min: 1, max: 4, step: 0.7 }), 3.8);
});

test("ズーム変更は選択カメラ・解像度・他の制約を保持し、古い倍率を除く", async () => {
  let received;
  const track = {
    getConstraints: () => ({ deviceId: { exact: "tele" }, facingMode: { exact: "environment" },
      width: { ideal: 4032 }, height: { ideal: 3024 }, zoom: 1,
      advanced: [{ zoom: 2 }, { zoom: 2, torch: false }] }),
    applyConstraints: async (value) => { received = value; },
    getSettings: () => ({ zoom: 3 }),
  };
  assert.deepEqual(await applyTrackZoom(track, 3, { min: 1, max: 8, step: 0.5 }), { requested: 3, actual: 3 });
  assert.deepEqual(received, { deviceId: { exact: "tele" }, facingMode: { exact: "environment" },
    width: { ideal: 4032 }, height: { ideal: 3024 }, advanced: [{ torch: false }, { zoom: 3 }] });
});

test("倍率指定が無視された場合・読めない場合は実際の倍率と区別する", async () => {
  const range = { min: 1, max: 4, step: 1 };
  for (const [zoom, actual] of [[1, 1], [undefined, null]]) {
    const track = { applyConstraints: async () => {}, getSettings: () => ({ zoom }) };
    assert.deepEqual(await applyTrackZoom(track, 3, range), { requested: 3, actual });
  }
  await assert.rejects(applyTrackZoom({ applyConstraints: async () => { throw new Error("failed"); } }, 2, range), /failed/);
});

function selectedFixture() {
  const calls = [];
  const track = { getSettings: () => ({ facingMode: "environment" }),
    getCapabilities: () => ({ width: { max: 4032 }, height: { max: 3024 }, zoom: { min: 1, max: 8 } }),
    applyConstraints: async (constraints) => { calls.push(constraints); } };
  const stream = { getVideoTracks: () => [track] };
  const mediaDevices = { getUserMedia: async (constraints) => { calls.push(constraints); return stream; } };
  return { calls, mediaDevices };
}

test("選択した端末を初回と高解像度の再要求で維持し、背面だけを要求する", async () => {
  const fixture = selectedFixture();
  const result = await openSelectedCamera(fixture.mediaDevices, "tele", false);
  assert.equal(result.fallback, false);
  assert.equal(fixture.calls[0].audio, false);
  for (const constraints of [fixture.calls[0].video, fixture.calls[1]]) {
    assert.deepEqual(constraints.deviceId, { exact: "tele" });
    assert.deepEqual(constraints.facingMode, { exact: "environment" });
  }
  assert.deepEqual(fixture.calls[1].width, { ideal: 4032 });
});

test("記憶したカメラが消えた場合だけ背面の自動選択へ戻す", async () => {
  for (const name of ["NotFoundError", "OverconstrainedError"]) {
    const fixture = selectedFixture();
    const getUserMedia = fixture.mediaDevices.getUserMedia;
    fixture.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints.video.deviceId) throw Object.assign(new Error("missing"), { name });
      return getUserMedia(constraints);
    };
    const result = await openSelectedCamera(fixture.mediaDevices, "missing", true);
    assert.equal(result.fallback, true);
    assert.equal(fixture.calls[0].video.deviceId, undefined);
  }
});

test("明示選択の失敗や許可拒否では別のカメラへ勝手に切り替えない", async () => {
  for (const [deviceId, allowFallback, name] of [["tele", false, "OverconstrainedError"],
    ["tele", true, "NotAllowedError"], ["", true, "NotFoundError"]]) {
    let calls = 0;
    const error = Object.assign(new Error("failed"), { name });
    await assert.rejects(openSelectedCamera({ getUserMedia: async () => { calls++; throw error; } }, deviceId, allowFallback), error);
    assert.equal(calls, 1);
  }
});
