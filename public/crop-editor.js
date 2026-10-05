import { detectCorners, detectionSize } from "./corner-detect.js";
import { CropState, CropError, rectifyRows } from "./crop-logic.js";

export function createCropEditor({ onChange }) {
  const $ = (id) => document.getElementById(id);
  const state = new CropState();
  const buttons = [...document.querySelectorAll("[data-corner]")];
  let selected = 0;
  let drag = null;
  let controller = null;
  let showingResult = false;
  let locked = false;
  let detecting = false;
  let generation = 0;
  let interrupted = null;
  function suspend() {
    if (detecting || state.busy) interrupted = detecting ? "detect" : "preview";
    controller?.abort();
    drag = null;
  }
  function resume() {
    if (document.hidden || detecting || state.busy || !interrupted || !state.source) return;
    const phase = interrupted;
    interrupted = null;
    if (phase === "detect") void editor.begin(state.source, { restore: true });
    else void preview();
  }
  function lockControls() {
    buttons.forEach((button) => { button.disabled = locked || state.busy || detecting; });
    $("crop-preview").disabled = locked || !state.source || state.busy || detecting;
    $("crop-reset").disabled = locked || !state.source || state.busy || detecting;
    $("crop-edit").disabled = locked || !state.source || state.busy || detecting || !showingResult;
    $("crop-nudge").disabled = locked || state.busy || detecting || !state.source || showingResult;
    $("corner-selection").disabled = locked || state.busy || detecting || showingResult;
  }

  function render(message) {
    buttons.forEach((button, index) => {
      const point = state.corners?.[index];
      if (point && state.source) {
        button.style.left = `${point.x / (state.source.width - 1) * 100}%`;
        button.style.top = `${point.y / (state.source.height - 1) * 100}%`;
      }
      button.disabled = state.busy;
      button.setAttribute("aria-pressed", String(selected === index));
    });
    $("crop-outline").setAttribute("points", (state.corners || []).map((point) => `${point.x},${point.y}`).join(" "));
    lockControls();
    $("crop-cancel").hidden = !(state.busy || detecting);
    $("crop-cancel").textContent = detecting ? "検出を中断" : "補正を中断";
    $("corner-selection").value = String(selected);
    $("image-stage").hidden = showingResult;
    $("cropped-image").hidden = !showingResult;
    $("crop-hint").textContent = showingResult ? "保存される補正画像です。等倍で文字を確認できます。"
      : "四隅の丸を板面に合わせて動かし、「補正して確認」を押してください。自動検出の枠が合わない場合は手動で調整できます。";
    if (message) $("crop-status").textContent = message;
    onChange();
  }
  function invalidate(points) {
    state.change(points);
    showingResult = false;
    $("cropped-image").width = 0;
    $("cropped-image").height = 0;
    render("四隅を変更しました。もう一度補正して確認してください。");
  }
  function move(index, x, y) {
    if (locked || !state.source || state.busy || detecting || showingResult) return;
    const points = state.corners.map((point) => ({ ...point }));
    points[index] = { x: Math.max(0, Math.min(state.source.width - 1, x)),
      y: Math.max(0, Math.min(state.source.height - 1, y)) };
    invalidate(points);
  }
  buttons.forEach((button, index) => {
    button.addEventListener("pointerdown", (event) => {
      if (locked || state.busy || detecting || !state.source || showingResult || event.button !== 0 || !event.isPrimary) return;
      selected = index;
      drag = { id: event.pointerId, index };
      button.setPointerCapture(event.pointerId);
      render();
      event.preventDefault();
    });
    button.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const bounds = $("image").getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      move(index, (event.clientX - bounds.left) / bounds.width * (state.source.width - 1),
        (event.clientY - bounds.top) / bounds.height * (state.source.height - 1));
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
      button.addEventListener(event, () => { drag = null; });
    }
    button.addEventListener("click", () => { selected = index; render(); });
    button.addEventListener("keydown", (event) => {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction || !state.source || state.busy || showingResult) return;
      event.preventDefault();
      selected = index;
      const step = event.shiftKey ? 10 : 1;
      const point = state.corners[index];
      move(index, point.x + direction[0] * step, point.y + direction[1] * step);
    });
  });
  $("corner-selection").addEventListener("change", () => { selected = Number($("corner-selection").value); render(); });
  $("crop-nudge").addEventListener("click", () => {
    const point = state.corners[selected];
    move(selected, point.x + (state.source.width / 2 - point.x) * 0.1,
      point.y + (state.source.height / 2 - point.y) * 0.1);
  });
  $("crop-reset").addEventListener("click", () => { state.reset(); invalidate(state.corners); render("画像全体の枠に戻しました。補正して確認してください。"); });
  $("crop-edit").addEventListener("click", () => { showingResult = false; render("元画像で四隅を調整できます。変更後は再度補正してください。"); });
  $("crop-cancel").addEventListener("click", () => { controller?.abort(); });
  async function preview() {
    if (locked || state.busy || detecting || !state.source) return;
    controller = new AbortController();
    const signal = controller.signal;
    const current = generation;
    try {
      await state.preview(async (source, plan) => {
        render("補正しています。中断して四隅の調整に戻れます。");
        const output = $("cropped-image");
        try {
          const pixels = source.getContext("2d").getImageData(0, 0, source.width, source.height);
          output.width = plan.width;
          output.height = plan.height;
          const context = output.getContext("2d");
          if (!context) throw new CropError("補正画像を準備できません。");
          for (let row = 0; row < plan.height; row += 16) {
            await new Promise((resolve) => window.setTimeout(resolve, 0));
            if (signal.aborted || document.hidden) throw new CropError("補正を中断しました。画像を残しています。");
            const count = Math.min(16, plan.height - row);
            context.putImageData(new ImageData(rectifyRows(pixels, plan, row, count), plan.width, count), 0, row);
          }
          return output;
        } catch (error) { if (current === generation) { output.width = 0; output.height = 0; } throw error; }
      });
      if (current !== generation) return;
      showingResult = state.savable;
      if (!showingResult) { render("補正を中断しました。"); return; }
      render(`補正画像：${state.result.width} × ${state.result.height} px。確認して保存してください。`);
    } catch (error) {
      if (current !== generation) return;
      showingResult = false;
      render(error instanceof CropError ? error.message : "補正できませんでした。画像は残っています。空き容量と四隅を確認し、再試行してください。");
    } finally { if (controller?.signal === signal) controller = null; if (current === generation) { render(); resume(); } }
  }
  $("crop-preview").addEventListener("click", preview);
  document.addEventListener("visibilitychange", () => { if (document.hidden) suspend(); else resume(); });
  window.addEventListener("pagehide", suspend);
  window.addEventListener("pageshow", resume);
  const editor = {
    get busy() { return state.busy || detecting; },
    get savable() { return state.savable && showingResult; },
    get canvas() { return state.result; },
    setLocked(value) { locked = Boolean(value); lockControls(); },
    async begin(source, { restore = false } = {}) {
      interrupted = null;
      controller?.abort();
      const current = ++generation;
      if (!restore) { state.begin(source); selected = 0; }
      showingResult = false;
      $("crop-overlay").setAttribute("viewBox", `0 0 ${source.width - 1} ${source.height - 1}`);
      $("image-stage").style.setProperty("--source-width", `${source.width}px`);
      detecting = true;
      controller = new AbortController();
      const signal = controller.signal;
      render("板面の四隅を検出しています。中断して手動で調整できます。");
      const small = document.createElement("canvas");
      try {
        const size = detectionSize(source.width, source.height);
        small.width = size.width; small.height = size.height;
        const context = small.getContext("2d");
        context.drawImage(source, 0, 0, small.width, small.height);
        let lastYield = performance.now();
        const points = await detectCorners(context.getImageData(0, 0, small.width, small.height), {
          signal, originalWidth: source.width, originalHeight: source.height,
          yieldTask: async () => {
            if (performance.now() - lastYield >= 8) {
              await new Promise((resolve) => window.setTimeout(resolve, 0));
              lastYield = performance.now();
            }
            if (document.hidden) throw new CropError("検出を中断しました。");
          },
        });
        if (current !== generation) return;
        state.change(points);
        detecting = false;
        controller = null;
        await preview();
      } catch {
        if (current === generation) render("検出を中断しました。画像全体の枠から手動で調整できます。");
      } finally {
        small.width = 0; small.height = 0;
        if (current === generation) {
          detecting = false;
          if (controller?.signal === signal) controller = null;
          render(); resume();
        }
      }
    },
    clear() {
      interrupted = null;
      generation++;
      detecting = false;
      controller?.abort();
      state.clear();
      drag = null;
      showingResult = false;
      $("cropped-image").width = 0;
      $("cropped-image").height = 0;
      render();
    },
  };
  return editor;
}
