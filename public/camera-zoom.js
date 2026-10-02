import { normalizeZoom } from "./camera-options.js";

// applyConstraintsは重ねず、処理中の入力は最新の倍率だけ残す。
export function createLiveZoom({ range, initialZoom, applyZoom, onRequested, onApplied, onError, onBusy,
  scheduleFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame }) {
  let desired = normalizeZoom(initialZoom, range);
  let applied = desired;
  let pending = null;
  let frame = null;
  let applying = false;
  let busy = false;
  let disposed = false;
  const setBusy = (value) => { if (busy !== value) { busy = value; onBusy?.(value); } };
  function schedule() {
    if (disposed || applying || frame !== null) return;
    frame = scheduleFrame(() => { frame = null; void pump(); });
  }
  async function pump() {
    if (disposed || pending === null) return;
    const requested = pending;
    pending = null;
    applying = true;
    try {
      const result = await applyZoom(requested);
      if (disposed) return;
      applied = normalizeZoom(result.actual ?? result.requested, range);
      const settled = pending === null;
      if (settled) desired = applied;
      onApplied?.(result, { settled });
    } catch {
      if (!disposed) {
        const settled = pending === null;
        if (settled) desired = applied;
        onError?.({ requested, settled });
      }
    } finally {
      applying = false;
      if (!disposed) {
        if (pending !== null) schedule();
        else setBusy(false);
      }
    }
  }
  return {
    request(value) {
      if (disposed || !Number.isFinite(value)) return desired;
      const requested = normalizeZoom(value, range);
      if (requested === desired && busy) return desired;
      desired = requested;
      if (!busy && requested === applied) return desired;
      pending = requested;
      setBusy(true);
      onRequested?.(requested);
      schedule();
      return desired;
    },
    value: () => desired,
    isBusy: () => busy,
    dispose() {
      disposed = true;
      pending = null;
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}

// 2本の指の開始時の距離・倍率を基準にする。毎回乗算して誤差を蓄積しない。
export function createPinchZoom({ readZoom, onZoom }) {
  const points = new Map();
  let baseline = null;
  const distance = () => {
    const [a, b] = [...points.values()];
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  function rebase() {
    baseline = null;
    if (points.size !== 2) return;
    const length = distance();
    const zoom = readZoom();
    if (Number.isFinite(length) && length > 0 && Number.isFinite(zoom) && zoom > 0) baseline = { length, zoom };
  }
  return {
    start(id, x, y) {
      if (points.has(id) || points.size >= 2 || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      points.set(id, { x, y });
      rebase();
      return true;
    },
    move(id, x, y) {
      if (!points.has(id) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      points.set(id, { x, y });
      if (points.size !== 2) return;
      if (!baseline) { rebase(); return; }
      const value = baseline.zoom * distance() / baseline.length;
      if (Number.isFinite(value) && value > 0) onZoom(value);
    },
    end(id) {
      if (!points.delete(id)) return;
      rebase();
    },
    reset() { points.clear(); baseline = null; },
  };
}
