import assert from "node:assert/strict";
import test from "node:test";
import { createLiveZoom, createPinchZoom } from "../public/camera-zoom.js";

const range = { min: 1, max: 8, step: 0.5 };
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const frames = new Map();
  const applied = [], requested = [], busy = [], errors = [];
  let next = 0;
  const zoom = createLiveZoom({
    range, initialZoom: 1,
    applyZoom: async (value) => ({ requested: value, actual: value }),
    scheduleFrame: (callback) => { frames.set(++next, callback); return next; },
    cancelFrame: (id) => frames.delete(id),
    onApplied: (result, details) => applied.push({ ...result, ...details }),
    onRequested: (value) => requested.push(value),
    onBusy: (value) => busy.push(value),
    onError: (value) => errors.push(value),
    ...overrides,
  });
  return { zoom, applied, requested, busy, errors, frames,
    async frame() {
      const entry = frames.entries().next().value;
      if (entry) { frames.delete(entry[0]); entry[1](); }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("確定操作を待たず入力した倍率を次の描画で反映し、範囲と刻みに収める", async () => {
  const calls = [];
  const sample = fixture({ applyZoom: async (value) => { calls.push(value); return { requested: value, actual: value }; } });
  sample.zoom.request(2.2);
  assert.deepEqual(sample.requested, [2]);
  assert.equal(sample.zoom.isBusy(), true);
  await sample.frame();
  assert.deepEqual(calls, [2]);
  assert.equal(sample.zoom.isBusy(), false);
  sample.zoom.request(100);
  await sample.frame();
  sample.zoom.request(0);
  await sample.frame();
  assert.deepEqual(calls, [2, 8, 1]);
  assert.deepEqual(sample.busy, [true, false, true, false, true, false]);
});

test("同じ描画までの連続入力は最新の倍率だけを送る", async () => {
  const calls = [];
  const sample = fixture({ applyZoom: async (value) => { calls.push(value); return { requested: value, actual: value }; } });
  for (const value of [2, 3, 4, 5]) sample.zoom.request(value);
  assert.equal(sample.frames.size, 1);
  await sample.frame();
  assert.deepEqual(calls, [5]);
  assert.equal(sample.zoom.value(), 5);
});

test("変更中も入力を受け取り、同時に適用せず古い応答で最新の指定を戻さない", async () => {
  const waits = [], calls = [];
  let active = 0;
  const sample = fixture({ applyZoom: async (value) => {
    assert.equal(++active, 1);
    calls.push(value);
    const wait = deferred(); waits.push(wait);
    await wait.promise;
    active -= 1;
    return { requested: value, actual: value };
  } });
  sample.zoom.request(2);
  await sample.frame();
  for (const value of [3, 4, 5]) sample.zoom.request(value);
  assert.deepEqual(calls, [2]);
  waits[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sample.applied, [{ requested: 2, actual: 2, settled: false }]);
  assert.equal(sample.zoom.value(), 5);
  assert.equal(sample.zoom.isBusy(), true);
  await sample.frame();
  assert.deepEqual(calls, [2, 5]);
  waits[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sample.applied.at(-1).settled, true);
  assert.equal(sample.zoom.isBusy(), false);
});

test("元の倍率へ戻す入力も、適用中の変更の後で必ず反映する", async () => {
  const first = deferred(), calls = [];
  const sample = fixture({ applyZoom: async (value) => {
    calls.push(value);
    if (calls.length === 1) await first.promise;
    return { requested: value, actual: value };
  } });
  sample.zoom.request(4); await sample.frame();
  sample.zoom.request(1); first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await sample.frame();
  assert.deepEqual(calls, [4, 1]);
  assert.equal(sample.zoom.value(), 1);
});

test("同じ刻みの再入力と不正値は無駄に適用せず、実際の倍率を読み戻す", async () => {
  let calls = 0;
  const sample = fixture({ applyZoom: async (value) => { calls++; return { requested: value, actual: 2 }; } });
  for (const value of [1, NaN, Infinity]) sample.zoom.request(value);
  assert.equal(sample.frames.size, 0);
  sample.zoom.request(4); await sample.frame();
  assert.equal(sample.zoom.value(), 2);
  assert.deepEqual(sample.applied, [{ requested: 4, actual: 2, settled: true }]);
  sample.zoom.request(2.1);
  assert.equal(sample.frames.size, 0);
  assert.equal(calls, 1);
});

test("失敗しても最新の指定を試し、最後の失敗後も次の操作を受け付ける", async () => {
  const first = deferred();
  let fail = false;
  const calls = [];
  const sample = fixture({ applyZoom: async (value) => {
    calls.push(value);
    if (calls.length === 1) await first.promise;
    if (fail) throw new Error("apply failed");
    return { requested: value, actual: value };
  } });
  sample.zoom.request(2); await sample.frame(); sample.zoom.request(3);
  first.reject(new Error("apply failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sample.errors[0].settled, false);
  await sample.frame(); assert.equal(sample.zoom.value(), 3);
  fail = true; sample.zoom.request(4); await sample.frame();
  assert.equal(sample.zoom.value(), 3);
  assert.equal(sample.errors.at(-1).settled, true);
  assert.equal(sample.zoom.isBusy(), false);
  fail = false; sample.zoom.request(5); await sample.frame();
  assert.deepEqual(calls, [2, 3, 4, 5]);
});

test("停止・カメラ切り替えで予約を取り消し、古い成功・失敗は画面へ通知しない", async () => {
  const idle = fixture(); idle.zoom.request(2); idle.zoom.dispose();
  assert.equal(idle.frames.size, 0);
  for (const fail of [false, true]) {
    const wait = deferred();
    const sample = fixture({ applyZoom: async () => { await wait.promise; return { requested: 2, actual: 2 }; } });
    sample.zoom.request(2); await sample.frame(); sample.zoom.request(3); sample.zoom.dispose();
    if (fail) wait.reject(new Error("old camera")); else wait.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sample.applied, []); assert.deepEqual(sample.errors, []);
    assert.equal(sample.frames.size, 0);
    sample.zoom.request(5); assert.equal(sample.frames.size, 0);
  }
});

test("指を広げると拡大、狭めると縮小し、開始時の倍率を基準にする", () => {
  const values = [];
  const pinch = createPinchZoom({ readZoom: () => 2, onZoom: (value) => values.push(value) });
  pinch.start(1, 0, 0); pinch.move(1, 10, 10);
  assert.deepEqual(values, []);
  pinch.start(2, 110, 10);
  pinch.move(2, 210, 10); pinch.move(2, 60, 10); pinch.move(2, 110, 10);
  assert.deepEqual(values, [4, 1, 2]);
});

test("指を離す・中断・置き直しで基準を更新し、3本目や不正な座標を無視する", () => {
  let zoom = 1;
  const values = [];
  const pinch = createPinchZoom({ readZoom: () => zoom, onZoom: (value) => { zoom = value; values.push(value); } });
  assert.equal(pinch.start(1, 0, 0), true); assert.equal(pinch.start(2, 100, 0), true);
  assert.equal(pinch.start(3, 50, 0), false); pinch.end(3);
  pinch.move(2, 200, 0); pinch.end(2); pinch.move(1, 20, 0);
  assert.deepEqual(values, [2]);
  pinch.start(4, 120, 0); pinch.move(4, 170, 0);
  assert.deepEqual(values, [2, 3]);
  pinch.reset(); pinch.move(4, 220, 0);
  assert.deepEqual(values, [2, 3]);
  assert.equal(pinch.start(5, NaN, 0), false);
});

test("距離0の開始と不正な移動で異常倍率を作らず、ピンチも範囲内に収める", async () => {
  const sample = fixture();
  const pinch = createPinchZoom({ readZoom: sample.zoom.value, onZoom: sample.zoom.request });
  pinch.start(1, 0, 0); pinch.start(2, 0, 0);
  pinch.move(2, 100, 0); // 距離0だった開始点を置き直す。
  assert.equal(sample.frames.size, 0);
  pinch.move(2, Infinity, 0); assert.equal(sample.frames.size, 0);
  pinch.move(2, 10000, 0); await sample.frame(); assert.equal(sample.zoom.value(), 8);
  pinch.move(2, 1, 0); await sample.frame(); assert.equal(sample.zoom.value(), 1);
});
