import test from "node:test";
import assert from "node:assert/strict";
import { createToast, toastMessage, bindSheetDrag, createStableReason, createZoomFailureNotice } from "../public/ui-feedback.js";

test("不可理由は400ms未満の入れ替わりを表示せず、同じ理由の再通知で待機を延長しない", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown = [];
  const update = createStableReason({ show: text => shown.push(text) });
  update("カメラを準備しています。");
  t.mock.timers.tick(399);
  assert.deepEqual(shown, [""]);
  update("映像を待っています。");
  t.mock.timers.tick(200);
  update("映像を待っています。");
  t.mock.timers.tick(199);
  assert.deepEqual(shown, ["", ""]);
  t.mock.timers.tick(1);
  assert.equal(shown.at(-1), "映像を待っています。");
  update(""); assert.equal(shown.at(-1), "");
  update("短い理由"); t.mock.timers.tick(100); update("");
  t.mock.timers.tick(500);
  assert.equal(shown.includes("短い理由"), false);
});

test("不可理由が1秒以内に何度も切り替わる間は表示しない", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown = [];
  const update = createStableReason({ show: text => shown.push(text) });
  for (let i = 0; i < 10; i++) {
    update(i % 2 ? "裏に回りました" : "カメラを準備しています");
    t.mock.timers.tick(100);
  }
  assert.ok(shown.every(text => text === ""));
  update(""); t.mock.timers.tick(400);
  assert.ok(shown.every(text => text === ""));
});

test("倍率の失敗は5000ms未満では再通知せず、抑止された失敗で期間を延長しない", () => {
  let time = 0;
  const messages = [];
  const fail = createZoomFailureNotice({ notify: text => messages.push(text), now: () => time });
  fail();
  for (time of [1, 1000, 4999]) fail();
  assert.equal(messages.length, 1);
  time = 5000; fail(); assert.equal(messages.length, 2);
  time = 9999; fail(); assert.equal(messages.length, 2);
  time = 10000; fail(); assert.equal(messages.length, 3);
});

test("通知は短い文にし、同時に1つだけ表示して3秒で消す", () => {
  const camera = { hidden: true }, review = { hidden: true };
  let selected = camera, task, cancelled, delay;
  const show = createToast({ nodes: [camera, review], select: () => selected,
    schedule(fn, ms) { task = fn; delay = ms; return 7; }, cancel(id) { cancelled = id; } });
  show("背面を指定しましたが向きの情報は取得できません。映像が背面カメラか確認してください。");
  assert.equal(camera.textContent, "背面カメラか確認してください");
  assert.equal(camera.hidden, false); assert.equal(review.hidden, true); assert.equal(delay, 3000);
  selected = review; show("四隅を確認して保存してください。");
  assert.equal(cancelled, 7); assert.equal(camera.hidden, true); assert.equal(review.hidden, false);
  task(); assert.equal(review.hidden, true);
  assert.equal(toastMessage("補正画像：800 × 600 px。確認して保存してください。"), "プレビューを確認してください");
  assert.ok(toastMessage("とても長い説明文".repeat(15)).length <= 28);
});

test("掴み手を下へ60px引くと閉じ、小さな移動・上方向・中断では閉じない", () => {
  const events = {}, sheetEvents = {}; let closes = 0;
  const sheet = { style: {}, close() { closes++; }, addEventListener(type, fn) { sheetEvents[type] = fn; } };
  const grip = { addEventListener(type, fn) { events[type] = fn; }, setPointerCapture() {} };
  bindSheetDrag({ grip, sheet });
  const down = { button: 0, isPrimary: true, pointerId: 1, clientY: 30 };
  for (const distance of [-20, 40, 80]) {
    events.pointerdown(down); events.pointermove({ pointerId: 1, clientY: 30 + distance });
    assert.equal(sheet.style.transform, `translateY(${Math.max(0, distance)}px)`);
    events.pointerup({ pointerId: 1 }); assert.equal(sheet.style.transform, "");
  }
  assert.equal(closes, 1);
  events.pointerdown(down); events.pointermove({ pointerId: 1, clientY: 200 }); events.pointercancel();
  events.pointerup({ pointerId: 1 }); assert.equal(closes, 1); assert.equal(sheet.style.transform, "");
  sheetEvents.close(); assert.equal(sheet.style.transform, "");
});
