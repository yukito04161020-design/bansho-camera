import test from "node:test";
import assert from "node:assert/strict";
import { createToast, toastMessage, bindSheetDrag } from "../public/ui-feedback.js";

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
