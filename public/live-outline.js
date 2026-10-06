import { detectCorners } from "./corner-detect.js";

export function createLiveOutline({ active, detect, draw, clear, schedule = setTimeout, cancel = clearTimeout, now = () => performance.now() }) {
  let timer = null, controller = null, enabled = true, stopped = false;
  function stop() { if (timer !== null) cancel(timer); timer = null; controller?.abort(); clear(); }
  async function tick() {
    timer = null;
    if (!enabled || stopped || !active()) { clear(); return; }
    controller = new AbortController();
    const signal = controller.signal, started = now();
    try { const points = await detect(signal); if (!signal.aborted && enabled && active()) draw(points); }
    catch { clear(); }
    finally { if (controller?.signal === signal) controller = null; }
    if (now() - started > 250) { clear(); return; }
    if (!signal.aborted && enabled && !stopped && active()) timer = schedule(tick, 500);
  }
  return {
    refresh() { stop(); if (enabled && !stopped && active()) timer = schedule(tick, 500); },
    setEnabled(value) { enabled = Boolean(value); this.refresh(); },
    stop() { stopped = true; stop(); },
  };
}

export function bindLiveOutline({ video, screen, overlay, toggle, document = globalThis.document, window = globalThis.window }) {
  const small = document.createElement("canvas"), polygon = overlay.querySelector("polygon");
  const live = createLiveOutline({
    active: () => !document.hidden && !screen.hidden && !video.paused && video.readyState >= 2 && video.videoWidth > 0,
    clear: () => polygon.setAttribute("points", ""),
    detect: async (signal) => {
      const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
      small.width = Math.max(2, Math.round(video.videoWidth * scale)); small.height = Math.max(2, Math.round(video.videoHeight * scale));
      const ctx = small.getContext("2d"); ctx.drawImage(video, 0, 0, small.width, small.height);
      const points = await detectCorners(ctx.getImageData(0, 0, small.width, small.height), { signal });
      // 検出不能時の全体枠は映像に表示しない。
      const full = points.every(p => (p.x === 0 || p.x === small.width - 1) && (p.y === 0 || p.y === small.height - 1));
      return full ? [] : points;
    },
    draw: (points) => {
      const scale = Math.max(screen.clientWidth / small.width, screen.clientHeight / small.height);
      const dx = (screen.clientWidth - small.width * scale) / 2, dy = (screen.clientHeight - small.height * scale) / 2;
      overlay.setAttribute("viewBox", `0 0 ${screen.clientWidth} ${screen.clientHeight}`);
      polygon.setAttribute("points", points.map(p => `${p.x * scale + dx},${p.y * scale + dy}`).join(" "));
    },
  });
  try { toggle.checked = window.localStorage.getItem("bansho-camera.outline") !== "off"; } catch { /* 端末保存不可でも切り替えられる。 */ }
  live.setEnabled(toggle.checked);
  toggle.addEventListener("change", () => { live.setEnabled(toggle.checked); try { window.localStorage.setItem("bansho-camera.outline", toggle.checked ? "on" : "off"); } catch {} });
  for (const event of ["playing", "pause", "emptied"]) video.addEventListener(event, () => live.refresh());
  document.addEventListener("visibilitychange", () => live.refresh());
  window.addEventListener("pagehide", () => { live.setEnabled(false); });
  window.addEventListener("pageshow", () => { live.setEnabled(toggle.checked); });
  return live;
}
