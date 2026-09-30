import assert from "node:assert/strict";
import test from "node:test";
import { captureFrame, openRearCamera, resolutionConstraints } from "../public/camera-logic.js";

test("背面だけを指定し、高い解像度は希望値として要求する", () => {
  const constraints = resolutionConstraints();
  assert.deepEqual(constraints.facingMode, { exact: "environment" });
  assert.deepEqual(constraints.width, { ideal: 7680 });
  assert.deepEqual(constraints.height, { ideal: 4320 });
  assert.deepEqual(constraints.resizeMode, { ideal: "none" });
});

test("能力値の上限を使い、欠けた値や不正な値だけ初期要求に戻す", () => {
  const constraints = resolutionConstraints({ width: { max: 4032 }, height: { max: 3024 } });
  assert.deepEqual(constraints.width, { ideal: 4032 });
  assert.deepEqual(constraints.height, { ideal: 3024 });
  assert.deepEqual(resolutionConstraints({ width: { max: NaN }, height: { max: 0 } }), resolutionConstraints());
});

function cameraFixture(overrides = {}) {
  let stopped = 0;
  let requested;
  const track = {
    getSettings: () => ({ facingMode: "environment" }),
    getCapabilities: () => ({ width: { max: 3840 }, height: { max: 2160 } }),
    applyConstraints: async (constraints) => { requested = constraints; },
    stop: () => { stopped += 1; },
    ...overrides,
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  return { stream, track, stopped: () => stopped, requested: () => requested };
}

test("マイクを要求せず、取得したカメラの能力値で解像度を再要求する", async () => {
  const fixture = cameraFixture();
  let initial;
  const camera = await openRearCamera({ getUserMedia: async (constraints) => {
    initial = constraints;
    return fixture.stream;
  } });
  assert.equal(initial.audio, false);
  assert.deepEqual(initial.video, resolutionConstraints());
  assert.equal(camera.stream, fixture.stream);
  assert.equal(camera.adjusted, true);
  assert.deepEqual(camera.requested, fixture.requested());
  assert.deepEqual(camera.requested.width, { ideal: 3840 });
});

test("再要求が失敗しても最初の映像を保持して検証を続けられる", async () => {
  const fixture = cameraFixture({ applyConstraints: async () => { throw new Error("unsupported"); } });
  const camera = await openRearCamera({ getUserMedia: async () => fixture.stream });
  assert.equal(camera.stream, fixture.stream);
  assert.equal(camera.adjusted, false);
  assert.deepEqual(camera.requested, resolutionConstraints());
  assert.equal(fixture.stopped(), 0);
});

test("能力値の取得APIがなくても最初の高解像度要求で動く", async () => {
  const fixture = cameraFixture({ getCapabilities: undefined });
  const camera = await openRearCamera({ getUserMedia: async () => fixture.stream });
  assert.equal(camera.adjusted, false);
  assert.equal(camera.stream, fixture.stream);
});

test("前面カメラを誤って取得したら停止し、検証に使わない", async () => {
  const fixture = cameraFixture({ getSettings: () => ({ facingMode: "user" }) });
  await assert.rejects(openRearCamera({ getUserMedia: async () => fixture.stream }), /背面カメラ/);
  assert.equal(fixture.stopped(), 1);
});

test("カメラの許可拒否を呼び出し元に返す", async () => {
  const error = new Error("permission denied");
  error.name = "NotAllowedError";
  await assert.rejects(openRearCamera({ getUserMedia: async () => { throw error; } }), error);
});

test("映像トラックがないストリームも解放する", async () => {
  let stopped = false;
  const stream = { getVideoTracks: () => [], getTracks: () => [{ stop: () => { stopped = true; } }] };
  await assert.rejects(openRearCamera({ getUserMedia: async () => stream }), /映像トラック/);
  assert.equal(stopped, true);
});

test("表示サイズではなく映像の実寸で、全フレームを縮小せず切り出す", () => {
  for (const [width, height] of [[3840, 2160], [1080, 1920]]) {
    const video = { readyState: 2, videoWidth: width, videoHeight: height, clientWidth: 320, clientHeight: 180 };
    let drawn;
    const canvas = { getContext: () => ({ drawImage: (...args) => { drawn = args; } }) };
    assert.deepEqual(captureFrame(video, canvas), { width, height });
    assert.equal(canvas.width, width);
    assert.equal(canvas.height, height);
    assert.deepEqual(drawn, [video, 0, 0, width, height]);
  }
});

test("映像未準備・ゼロサイズ・描画不可の場合は画像を作らない", () => {
  const canvas = { getContext: () => { throw new Error("呼ばない"); } };
  assert.throws(() => captureFrame({ readyState: 1, videoWidth: 1920, videoHeight: 1080 }, canvas), /準備/);
  assert.throws(() => captureFrame({ readyState: 2, videoWidth: 0, videoHeight: 0 }, canvas), /準備/);
  assert.throws(() => captureFrame({ readyState: 2, videoWidth: 1920, videoHeight: 1080 }, { getContext: () => null }), /表示/);
});
