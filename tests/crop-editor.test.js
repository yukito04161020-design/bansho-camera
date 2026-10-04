import test from "node:test";
import assert from "node:assert/strict";
import { createCropEditor } from "../public/crop-editor.js";

function environment() {
  const elements = new Map(), listeners = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      width: 80, height: 60, style: { setProperty() {} }, events: new Map(),
      setAttribute(key, value) { this[key] = value; },
      addEventListener(key, callback) { this.events.set(key, callback); },
      getContext() { return { drawImage() {}, getImageData() { return pixels(); }, putImageData() {} }; },
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
  const originals = new Map(["document", "window", "ImageData"].map(k => [k, globalThis[k]]));
  const doc = { hidden: false, getElementById: element, querySelectorAll: () => [0, 1, 2, 3].map(i => element(`corner${i}`)),
    createElement: () => element("small"), addEventListener: (key, callback) => listeners.set(key, callback) };
  globalThis.document = doc;
  globalThis.window = { setTimeout: (callback) => setTimeout(callback, 0), addEventListener: (key, callback) => listeners.set(key, callback) };
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
