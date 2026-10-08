import { createPinchZoom } from "./camera-zoom.js";

// ステージの子要素から届く操作も受ける。確認画面・設定シートでは無効。
export function bindCameraStage(stage, { active, enabled, readZoom, onZoom,
  touchEvents = "ontouchstart" in (stage.ownerDocument?.defaultView ?? {}) }) {
  const pinch = createPinchZoom({ readZoom, onZoom });
  const pointers = new Set();
  let pinched = false;
  if (touchEvents) {
    function updateTouches(event) {
      if (!active() || !enabled()) { pinch.reset(); pointers.clear(); return; }
      const touches = [...event.touches];
      const ids = new Set(touches.map(touch => touch.identifier));
      for (const id of pointers) {
        if (!ids.has(id)) { pointers.delete(id); pinch.end(id); }
      }
      if (event.type === "touchstart" && !pointers.size) pinched = false;
      if (event.type === "touchstart") {
        pinch.movePoints(touches.map(touch => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY })));
      }
      for (const touch of touches) {
        if (!pointers.has(touch.identifier) && pinch.start(touch.identifier, touch.clientX, touch.clientY)) {
          pointers.add(touch.identifier);
        }
      }
      if (pointers.size === 2) pinched = true;
      if (event.type === "touchmove") {
        pinch.movePoints(touches.map(touch => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY })));
      }
    }
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      stage.addEventListener(type, updateTouches, { passive: false });
    }
  }
  stage.addEventListener("dblclick", (event) => { if (active()) event.preventDefault(); });
  stage.addEventListener("pointerdown", (event) => {
    if (touchEvents || !active() || !enabled() || event.pointerType !== "touch") return;
    if (!pointers.size) pinched = false;
    if (!pinch.start(event.pointerId, event.clientX, event.clientY)) return;
    pointers.add(event.pointerId);
    // 1本指のボタンタップは捕捉せず、クリックの対象を変えない。
    if (pointers.size === 2) {
      pinched = true;
      for (const id of pointers) stage.setPointerCapture(id);
    }
  });
  stage.addEventListener("pointermove", (event) => {
    if (touchEvents || !active() || !enabled() || event.pointerType !== "touch") return;
    pinch.move(event.pointerId, event.clientX, event.clientY);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    stage.addEventListener(type, (event) => { if (touchEvents) return; pointers.delete(event.pointerId); pinch.end(event.pointerId); });
  }
  stage.addEventListener("click", (event) => {
    if (active() && pinched) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  return { reset() { pinch.reset(); pointers.clear(); pinched = false; } };
}

// 撮影画面の間だけページ全体の拡大・縮小とスクロールを止める。
export function bindCameraPageGuard(doc, active) {
  const types = ["touchstart", "touchmove", "gesturestart", "gesturechange", "gestureend"];
  const options = { capture: true, passive: false };
  let attached = false;
  function prevent(event) {
    if (active() && (event.type.startsWith("gesture") || event.touches.length >= 2)) event.preventDefault();
  }
  function sync() {
    const value = active();
    for (const node of [doc.documentElement, doc.body]) node?.classList.toggle("camera-page-fixed", value);
    if (value === attached) return;
    for (const type of types) doc[value ? "addEventListener" : "removeEventListener"](type, prevent, options);
    attached = value;
  }
  sync();
  return { sync };
}
