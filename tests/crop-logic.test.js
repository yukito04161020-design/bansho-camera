import test from "node:test";
import assert from "node:assert/strict";
import { CropError, CropState, fullFrame, validateCorners, cropPlan, sourcePoint, rectifyRows } from "../public/crop-logic.js";
import { saveCapturedImage } from "../public/capture-save.js";

test("四隅は左上から時計回りで画像内に収まり、交差・重複・凹形・小面積を拒否する", () => {
  const corners = fullFrame(100, 80);
  assert.deepEqual(validateCorners(corners, 100, 80), corners);
  for (const invalid of [null, [], [null, ...corners.slice(1)],
    [{ x: -1, y: 0 }, ...corners.slice(1)], [{ x: Infinity, y: 0 }, ...corners.slice(1)],
    [corners[0], corners[2], corners[1], corners[3]], [corners[0], corners[0], corners[2], corners[3]],
    [corners[0], corners[1], { x: 10, y: 10 }, corners[3]],
    [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }]]) {
    assert.throws(() => validateCorners(invalid, 2000, 1000), CropError);
  }
  assert.throws(() => fullFrame(0, 80), CropError);
});

test("画像全体の補正は同じ大きさ、同じ対応点であり不必要に拡大しない", () => {
  const plan = cropPlan(fullFrame(100, 80), 100, 80);
  assert.equal(plan.width, 100);
  assert.equal(plan.height, 80);
  assert.deepEqual(sourcePoint(plan.matrix, 0.5, 0.5), { x: 49.5, y: 39.5 });
  const large = cropPlan(fullFrame(8000, 6000), 8000, 6000);
  assert.ok(Math.max(large.width, large.height) <= 4096);
  assert.ok(large.width * large.height <= 12_000_000);
});

test("傾いた台形の四隅が出力の四隅に一致する", () => {
  const points = [{ x: 20, y: 10 }, { x: 170, y: 25 }, { x: 185, y: 145 }, { x: 5, y: 160 }];
  const plan = cropPlan(points, 200, 180);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], index) => {
    const actual = sourcePoint(plan.matrix, u, v);
    assert.ok(Math.abs(actual.x - points[index].x) < 1e-8);
    assert.ok(Math.abs(actual.y - points[index].y) < 1e-8);
  });
  assert.equal(plan.width, 182);
});

function gradient(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    data.set([x * 10, y * 10, (x + y) * 5, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

test("合成画素の恒等変換は全画素一致し、分割した行でも同じ補正になる", () => {
  const pixels = gradient(20, 16);
  const plan = cropPlan(fullFrame(20, 16), 20, 16);
  const whole = rectifyRows(pixels, plan, 0, 16);
  assert.deepEqual(whole, pixels.data);
  const split = new Uint8ClampedArray(whole.length);
  split.set(rectifyRows(pixels, plan, 0, 7));
  split.set(rectifyRows(pixels, plan, 7, 9), 20 * 7 * 4);
  assert.deepEqual(split, whole);
  assert.throws(() => rectifyRows(pixels, plan, 15, 2), CropError);
});

test("小数座標は近傍4画素で補間され、切り取り外の元画素を出力しない", () => {
  const pixels = gradient(20, 16);
  const corners = [{ x: 2.5, y: 3.5 }, { x: 12.5, y: 3.5 }, { x: 12.5, y: 10.5 }, { x: 2.5, y: 10.5 }];
  const plan = cropPlan(corners, 20, 16);
  const output = rectifyRows(pixels, plan, 0, plan.height);
  assert.deepEqual([...output.slice(0, 4)], [25, 35, 30, 255]);
  assert.deepEqual([...output.slice(-4)], [125, 105, 115, 255]);
  assert.deepEqual(pixels, gradient(20, 16));
});

test("補正前・処理中・再調整後は保存不可で、最新の結果だけを保存対象にする", async () => {
  const state = new CropState();
  const source = { width: 100, height: 80 };
  const corrected = { width: 100, height: 80, corrected: true };
  state.begin(source);
  assert.equal(state.savable, false);
  let finish;
  const rendering = state.preview(() => new Promise((resolve) => { finish = resolve; }));
  assert.equal(state.busy, true);
  assert.equal(state.savable, false);
  assert.throws(() => state.reset(), CropError);
  await assert.rejects(state.preview(() => corrected), CropError);
  finish(corrected);
  await rendering;
  assert.equal(state.savable, true);
  assert.equal(state.result, corrected);
  assert.notEqual(state.result, source);
  state.change([{ x: 5, y: 5 }, { x: 95, y: 5 }, { x: 95, y: 75 }, { x: 5, y: 75 }]);
  assert.equal(state.savable, false);
  assert.equal(state.result, null);
  await assert.rejects(state.preview(() => { throw new Error("synthetic failure"); }));
  assert.equal(state.source, source);
  assert.equal(state.busy, false);
  state.reset();
  assert.deepEqual(state.corners, fullFrame(100, 80));
});

test("撮り直し後に古い補正が終わっても保存可能に戻らず、元画像・補正結果を解放する", async () => {
  const state = new CropState();
  state.begin({ width: 100, height: 80 });
  let finish;
  const rendering = state.preview(() => new Promise((resolve) => { finish = resolve; }));
  state.clear();
  finish({ corrected: true });
  await rendering;
  assert.equal(state.savable, false);
  assert.equal(state.source, null);
  assert.equal(state.result, null);
  assert.equal(state.busy, false);
});

test("保存対象には補正済みcanvasのJPEGだけを渡し、元画像を永続化しない", async () => {
  const state = new CropState();
  const source = { width: 100, height: 80, toBlob() { throw new Error("元画像を保存してはいけない"); } };
  const jpeg = new Blob(["corrected synthetic pixels"], { type: "image/jpeg" });
  const corrected = { width: 90, height: 70, toBlob(callback) { callback(jpeg); } };
  state.begin(source);
  await state.preview(() => corrected);
  let record;
  const destination = { className: "数学", sessionFolderName: "第01回_2026-10-03", capturedAt: 1790982000000 };
  await saveCapturedImage({ canvas: state.result, destination, enqueue: async (item) => { record = item; } });
  assert.equal(record.blob, jpeg);
  assert.deepEqual(Object.keys(record).sort(), ["blob", "capturedAt", "className", "sessionFolderName"]);
  assert.equal(state.source, source);
});
