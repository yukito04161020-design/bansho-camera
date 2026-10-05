import test from "node:test";
import assert from "node:assert/strict";
import { bindCameraStage } from "../public/camera-stage.js";

function fixture() {
  const listeners = new Map(), captured = [], requests = [];
  let active = true;
  const stage = { addEventListener(type, listener, options) { listeners.set(type, { listener, options }); },
    setPointerCapture(id) { captured.push(id); } };
  bindCameraStage(stage, { active: () => active, enabled: () => true, readZoom: () => 2, onZoom: value => requests.push(value) });
  function send(type, values = {}) {
    const event = { pointerType: "touch", pointerId: 1, clientX: 0, clientY: 0,
      target: { id: "overlay-button" }, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    listeners.get(type)?.listener(event);
    return event;
  }
  return { listeners, captured, requests, send, deactivate() { active = false; } };
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
