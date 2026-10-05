import { createPinchZoom } from "./camera-zoom.js";

// ステージの子要素から届く操作も受ける。確認画面・設定シートでは無効。
export function bindCameraStage(stage, { active, enabled, readZoom, onZoom }) {
  const pinch = createPinchZoom({ readZoom, onZoom });
  const pointers = new Set();
  let pinched = false;
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    stage.addEventListener(type, (event) => { if (active()) event.preventDefault(); }, { passive: false });
  }
  stage.addEventListener("touchmove", (event) => {
    if (active() && event.touches.length > 1) event.preventDefault();
  }, { passive: false });
  stage.addEventListener("dblclick", (event) => { if (active()) event.preventDefault(); });
  stage.addEventListener("pointerdown", (event) => {
    if (!active() || !enabled() || event.pointerType !== "touch") return;
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
    if (!active() || !enabled() || event.pointerType !== "touch") return;
    pinch.move(event.pointerId, event.clientX, event.clientY);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    stage.addEventListener(type, (event) => { pointers.delete(event.pointerId); pinch.end(event.pointerId); });
  }
  stage.addEventListener("click", (event) => {
    if (active() && pinched) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  return { reset() { pinch.reset(); pointers.clear(); pinched = false; } };
}
