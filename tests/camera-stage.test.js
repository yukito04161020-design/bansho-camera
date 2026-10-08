import test from "node:test";
import assert from "node:assert/strict";
import { normalizeZoom } from "../public/camera-options.js";
import { bindCameraStage, bindCameraPageGuard } from "../public/camera-stage.js";

function fixture(touchEvents = false) {
  const listeners = new Map(), captured = [], requests = [];
  let active = true;
  const stage = { addEventListener(type, listener, options) { listeners.set(type, { listener, options }); },
    setPointerCapture(id) { captured.push(id); } };
  const documentListeners = new Map();
  const classes = [new Set(), new Set()];
  const node = set => ({ classList: { toggle(name, value) { value ? set.add(name) : set.delete(name); } } });
  const doc = { documentElement: node(classes[0]), body: node(classes[1]),
    addEventListener(type, listener, options) { documentListeners.set(type, { listener, options }); },
    removeEventListener(type) { documentListeners.delete(type); } };
  const guard = bindCameraPageGuard(doc, () => active);
  bindCameraStage(stage, { touchEvents, active: () => active, enabled: () => true, readZoom: () => 2, onZoom: value => requests.push(normalizeZoom(value, { min: .5, max: 5, step: .1 })) });
  function send(type, values = {}) {
    const event = { pointerType: "touch", pointerId: 1, clientX: 0, clientY: 0,
      target: { id: "overlay-button" }, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    event.type = type;
    documentListeners.get(type)?.listener(event);
    listeners.get(type)?.listener(event);
    return event;
  }
  return { listeners: documentListeners, captured, requests, send, classes, activate() { active = true; guard.sync(); }, deactivate() { active = false; guard.sync(); } };
}

test("重ねた表示上の2本指とgestureを抑止し、カメラ倍率を要求する", () => {
  const f = fixture();
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    assert.equal(f.send(type).prevented, true);
    assert.equal(f.listeners.get(type).options.passive, false);
  }
  assert.equal(f.send("touchmove", { touches: [{}, {}] }).prevented, true);
  assert.equal(f.listeners.get("touchmove").options.passive, false);
  f.send("pointerdown");
  f.send("pointerdown", { pointerId: 2, clientX: 100 });
  f.send("pointermove", { pointerId: 2, clientX: 200 });
  assert.deepEqual(f.requests, [4]);
  assert.deepEqual(f.captured, [1, 2]);
  assert.equal(f.send("dblclick").prevented, true);
  assert.equal(f.send("click").prevented, true); // ピンチ終了で撮影を起こさない
});

test("1本指のボタン操作は捕捉せず、タップを抑止しない", () => {
  const f = fixture();
  assert.equal(f.send("pointerdown").prevented, false);
  assert.deepEqual(f.captured, []);
  assert.equal(f.send("touchmove", { touches: [{}] }).prevented, false);
  f.send("pointerup");
  assert.equal(f.send("click").prevented, false);
  assert.deepEqual(f.requests, []);
});

test("確認画面や設定シートでは撮影ステージのイベントを無効にする", () => {
  const f = fixture(); f.deactivate();
  for (const type of ["gesturestart", "gesturechange", "gestureend", "touchmove", "dblclick", "click"]) {
    assert.equal(f.send(type, { touches: [{}, {}] }).prevented, false);
  }
  f.send("pointerdown"); f.send("pointerdown", { pointerId: 2, clientX: 100 });
  f.send("pointermove", { pointerId: 2, clientX: 200 });
  assert.deepEqual(f.requests, []); assert.deepEqual(f.captured, []);
});


test("Touch Eventsで拡大・縮小し、カメラの0.5〜5倍で止まる", () => {
  const f = fixture(true);
  const touches = distance => [{ identifier: 1, clientX: 0, clientY: 0 }, { identifier: 2, clientX: distance, clientY: 0 }];
  f.send("touchstart", { touches: touches(100) });
  // 実際のliveZoomと同じ範囲制限を通して最終倍率を検証する。
  for (const [distance, expected] of [[200, 4], [50, 1], [10, .5], [0, .5], [1000, 5]]) {
    f.send("touchmove", { touches: touches(distance) });
    assert.equal(f.requests.at(-1), expected);
  }
  f.send("pointerdown"); f.send("pointerdown", { pointerId: 2, clientX: 100 });
  assert.deepEqual(f.captured, []);
  f.send("touchend", { touches: [] });
  assert.equal(f.send("click").prevented, true);
  f.send("touchstart", { touches: touches(100).slice(0, 1) });
  f.send("touchend", { touches: [] });
  assert.equal(f.send("click").prevented, false);
});

test("documentのcapture・非passive抑止とhtml/body固定は撮影表示中だけ", () => {
  const f = fixture(true);
  for (const type of ["touchstart", "touchmove", "gesturestart", "gesturechange", "gestureend"]) {
    assert.deepEqual(f.listeners.get(type).options, { capture: true, passive: false });
    assert.equal(f.send(type, { touches: [{}, {}] }).prevented, true);
  }
  assert.equal(f.send("touchstart", { touches: [{}] }).prevented, false);
  assert.ok(f.classes.every(set => set.has("camera-page-fixed")));
  for (const screen of ["確認画面", "設定シート"]) {
    f.deactivate();
    assert.equal(f.listeners.size, 0, screen);
    assert.ok(f.classes.every(set => !set.has("camera-page-fixed")), screen);
    for (const type of ["touchstart", "touchmove", "gesturestart", "gesturechange", "gestureend"]) {
      assert.equal(f.send(type, { touches: [{}, {}] }).prevented, false);
    }
    f.activate();
    assert.ok(f.classes.every(set => set.has("camera-page-fixed")));
  }
});


test("Touch Eventsではpointercancelに影響されず、両指の位置をまとめて計算する", () => {
  const f = fixture(true);
  const touches = (a, b) => [{ identifier: 1, clientX: a, clientY: 0 }, { identifier: 2, clientX: b, clientY: 0 }];
  f.send("touchstart", { touches: touches(0, 100) });
  f.send("pointercancel", { pointerId: 1 });
  f.send("touchmove", { touches: touches(20, 80) });
  assert.deepEqual(f.requests, [1.2]);
  f.send("touchcancel", { touches: [] });
  f.send("touchmove", { touches: [] });
  assert.deepEqual(f.requests, [1.2]);
  assert.equal(f.send("click").prevented, true);
});
