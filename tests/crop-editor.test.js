import test from "node:test";
import assert from "node:assert/strict";
import { createCropEditor } from "../public/crop-editor.js";

function environment() {
  const elements = new Map(), listeners = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      clientWidth: 800, clientHeight: 400, classList: { actual: false, contains() { return this.actual; } },
      scrollTo(x, y) { this.scrollLeft = x; this.scrollTop = y; },
      getBoundingClientRect() { return { left: 100, top: 100, width: 400, height: 300 }; },
      setPointerCapture() {},
      width: 80, height: 60, style: { setProperty() {} }, events: new Map(),
      setAttribute(key, value) { this[key] = value; },
      addEventListener(key, callback) { this.events.set(key, callback); },
      getContext() { return { drawImage() {}, getImageData() { return pixels(); }, putImageData() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }; },
    });
    return elements.get(id);
  }
  function pixels() {
    const data = new Uint8ClampedArray(80 * 60 * 4);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4, value = x >= 10 && x <= 69 && y >= 10 && y <= 49 ? 30 : 125;
      data.fill(value, i, i + 3); data[i + 3] = 255;
    }
    return { width: 80, height: 60, data };
  }
  const originals = new Map(["document", "window", "ImageData", "ResizeObserver"].map(k => [k, globalThis[k]]));
  const doc = { hidden: false, getElementById: element, querySelectorAll: () => [0, 1, 2, 3].map(i => element(`corner${i}`)),
    createElement: () => element("small"), addEventListener: (key, callback) => listeners.set(key, callback) };
  globalThis.document = doc;
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.window = { innerWidth: 800, innerHeight: 400, getComputedStyle() { return { paddingTop: "24px", paddingRight: "24px", paddingBottom: "32px", paddingLeft: "24px" }; }, setTimeout: (callback) => setTimeout(callback, 0), addEventListener: (key, callback) => listeners.set(key, callback) };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  return { element, doc, listeners, restore() { for (const [k, v] of originals) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } } };
}

test("確認画面開始で検出と補正プレビューが自動完了し、再調整・再補正できる", async () => {
  const env = environment();
  try {
    const editor = createCropEditor({ onChange() {} });
    const pending = editor.begin(env.element("image"));
    assert.equal(editor.busy, true); assert.equal(editor.savable, false);
    await pending;
    assert.equal(editor.busy, false); assert.equal(editor.savable, true);
    assert.ok(editor.canvas.width < 80); assert.ok(editor.canvas.height < 60);
    assert.equal(env.element("image-stage").hidden, true);
    env.element("crop-edit").events.get("click")();
    env.element("crop-reset").events.get("click")();
    assert.equal(editor.savable, false);
    await env.element("crop-preview").events.get("click")();
    assert.equal(editor.savable, true); assert.equal(editor.canvas.width, 80);
    editor.clear(); assert.equal(editor.savable, false); assert.equal(editor.canvas, null);
  } finally { env.restore(); }
});

test("検出中断・裏への移動・撮り直しでは結果を保存可能にせず手動調整を残す", async () => {
  const env = environment();
  try {
    for (const action of ["cancel", "hidden", "clear"]) {
      env.doc.hidden = false;
      const editor = createCropEditor({ onChange() {} });
      const pending = editor.begin(env.element("image"));
      if (action === "cancel") env.element("crop-cancel").events.get("click")();
      if (action === "hidden") { env.doc.hidden = true; env.listeners.get("visibilitychange")(); }
      if (action === "clear") editor.clear();
      await pending;
      assert.equal(editor.busy, false); assert.equal(editor.savable, false);
      if (action !== "clear") assert.equal(env.element("crop-preview").disabled, false);
      editor.clear();
    }
  } finally { env.restore(); }
});

async function settled(editor) {
  for (let i = 0; i < 200; i++) {
    if (!editor.busy) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("画像処理が完了しませんでした。");
}

test("検出途中で裏へ移った場合は元画像を保持し、前面復帰後に検出と補正をやり直す", async () => {
  const env = environment();
  try {
    const editor = createCropEditor({ onChange() {} });
    const source = env.element("image");
    const pending = editor.begin(source);
    env.doc.hidden = true; env.listeners.get("visibilitychange")();
    await pending;
    assert.equal(source.width, 80); assert.equal(source.height, 60);
    assert.equal(editor.savable, false);
    env.doc.hidden = false; env.listeners.get("visibilitychange")();
    await settled(editor);
    assert.equal(editor.savable, true);
    assert.equal(env.element("image-stage").hidden, true);
    editor.clear();
  } finally { env.restore(); }
});

test("四隅調整後の補正中断では四隅を保持して再補正し、完成画像は裏へ移っても保持する", async () => {
  const env = environment();
  try {
    const editor = createCropEditor({ onChange() {} });
    await editor.begin(env.element("image"));
    env.element("crop-edit").events.get("click")();
    env.element("crop-nudge").events.get("click")();
    const points = env.element("crop-outline").points;
    const pending = env.element("crop-preview").events.get("click")();
    env.doc.hidden = true; env.listeners.get("visibilitychange")();
    await pending;
    assert.equal(editor.savable, false);
    assert.equal(env.element("crop-outline").points, points);
    env.doc.hidden = false; env.listeners.get("visibilitychange")();
    await settled(editor);
    assert.equal(editor.savable, true);
    assert.equal(env.element("crop-outline").points, points);
    const canvas = editor.canvas;
    env.doc.hidden = true; env.listeners.get("visibilitychange")();
    env.doc.hidden = false; env.listeners.get("visibilitychange")();
    assert.equal(editor.canvas, canvas); assert.equal(editor.savable, true);
    editor.clear();
  } finally { env.restore(); }
});

test("処理停止の完了前に前面へ戻っても、完了後に自動でやり直す", async () => {
  const env = environment();
  try {
    const editor = createCropEditor({ onChange() {} });
    await editor.begin(env.element("image"));
    env.element("crop-edit").events.get("click")();
    const pending = env.element("crop-preview").events.get("click")();
    env.doc.hidden = true; env.listeners.get("visibilitychange")();
    env.doc.hidden = false; env.listeners.get("visibilitychange")();
    await pending; await settled(editor);
    assert.equal(editor.savable, true);
    editor.clear();
  } finally { env.restore(); }
});


test("つまみ操作中だけ拡大鏡を表示し、終了・中断・裏への移動で閉じる", async () => {
  const env = environment();
  try {
    const editor = createCropEditor({ onChange() {} });
    await editor.begin(env.element("image"));
    env.element("crop-edit").events.get("click")();
    env.element("crop-reset").events.get("click")();
    assert.equal(env.element("image-stage").style.width, "400px");
    const corner = env.element("corner0"), lens = env.element("crop-magnifier");
    const pointer = { button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} };
    for (const finish of ["pointerup", "pointercancel", "lostpointercapture", "hidden", "clear"]) {
      corner.events.get("pointerdown")(pointer);
      assert.equal(lens.hidden, false);
      assert.equal(corner["aria-pressed"], "true");
      corner.events.get("pointermove")({ ...pointer, clientX: 120, clientY: 120 });
      assert.equal(lens.hidden, false);
      if (finish === "hidden") { env.doc.hidden = true; env.listeners.get("visibilitychange")(); env.doc.hidden = false; }
      else if (finish === "clear") editor.clear();
      else corner.events.get(finish)();
      assert.equal(lens.hidden, true);
    }
  } finally { env.restore(); }
});


test("補正画像の等倍確認から調整へ戻ると表示を収め、スクロール位置を戻す", async () => {
  const env = environment();
  try {
    const editor = createCropEditor({ onChange() {} });
    await editor.begin(env.element("image"));
    const area = env.element("image-area");
    area.classList.actual = true;
    env.element("actual-size").events.get("click")();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(env.element("cropped-image").style.width, "");
    area.scrollLeft = 500; area.scrollTop = 300;
    env.element("crop-edit").events.get("click")();
    assert.equal(area.scrollLeft, 0); assert.equal(area.scrollTop, 0);
    assert.equal(env.element("image-stage").style.width, "400px");
    editor.clear();
  } finally { env.restore(); }
});
