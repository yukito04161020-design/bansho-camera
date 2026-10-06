import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { openUploadStore } from "../public/upload-store.js";

const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await pause(); }
  assert.fail("画面の処理が完了しませんでした。");
}
function environment(devices = [{ deviceId: "dual", label: "背面デュアル広角カメラ", zoom: true }]) {
  const elements = new Map(), requests = [], applied = [];
  let cuts = 0, running = 0;
  class Element extends EventTarget {
    constructor(id) {
      super(); this.id = id; this.hidden = false; this.open = false; this.disabled = false;
      this.value = ""; this.textContent = ""; this.width = 80; this.height = 60; this.children = [];
      this.style = { setProperty() {} };
      const classes = new Set();
      this.classList = { add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value), toggle(value, force) {
          const enabled = force ?? !classes.has(value);
          if (enabled) classes.add(value); else classes.delete(value); return enabled;
        } };
    }
    setAttribute(key, value) { this[key] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return []; }
    focus() {}
    scrollTo(x, y) { this.scrollLeft = x; this.scrollTop = y; }
    setPointerCapture() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event("close")); }
    load() {}
    async play() { this.paused = false; this.readyState = 2; }
    getContext() {
      return { drawImage: source => { if (source.id === "camera") cuts++; },
        getImageData() { return { width: 80, height: 60, data: new Uint8ClampedArray(80 * 60 * 4).fill(125) }; },
        putImageData() {} };
    }
    click() { const e = new Event("click", { cancelable: true }); this.dispatchEvent(e); if (!e.defaultPrevented) this.onclick?.(e); }
  }
  function element(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); }
  const doc = new EventTarget();
  Object.assign(doc, { hidden: false, visibilityState: "visible", getElementById: element,
    querySelector(selector) {
      if (selector === "#camera-select") return null;
      if (selector.startsWith("meta")) return { content: "development" };
      return selector.startsWith("#") ? element(selector.slice(1)) : null;
    }, querySelectorAll(selector) {
      return selector === "[data-corner]" ? [0, 1, 2, 3].map(i => element(`corner${i}`)) : [];
    }, createElement: type => new Element(type), head: new Element("head") });
  const win = new EventTarget();
  Object.assign(win, { isSecureContext: true, localStorage: { getItem: () => null, setItem() {} },
    setTimeout, setInterval() {} });
  const nav = { onLine: false, mediaDevices: {
    enumerateDevices: async () => devices.map(d => ({ ...d, kind: "videoinput" })),
    getUserMedia: async ({ video }) => {
      assert.equal(running, 0, "複数のストリームを同時に開かない");
      requests.push(video); running++;
      const device = devices.find(d => d.deviceId === video.deviceId?.exact) || devices[0];
      let zoom = 1, stopped = false;
      const track = new EventTarget();
      Object.assign(track, { label: device.label, readyState: "live", muted: false,
        getSettings: () => ({ deviceId: device.deviceId, facingMode: "environment", zoom }),
        getCapabilities: () => ({ width: { max: 80 }, height: { max: 60 }, ...(device.zoom ? { zoom: { min: 1, max: 10, step: 0.1 } } : {}) }),
        getConstraints: () => ({}), applyConstraints: async c => { if (c.advanced) { zoom = c.advanced.at(-1).zoom; applied.push(zoom); } },
        stop() { if (!stopped) { stopped = true; running--; track.readyState = "ended"; } } });
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    },
  } };
  const originals = new Map(["document", "window", "navigator", "indexedDB", "ImageData", "requestAnimationFrame", "cancelAnimationFrame"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const globals = { document: doc, window: win, navigator: nav, indexedDB: new IDBFactory(),
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  element("image-screen").hidden = true;
  Object.assign(element("camera"), { videoWidth: 80, videoHeight: 60, readyState: 2, paused: true });
  element("capture").disabled = true;
  element("apply-class").disabled = true;
  return { doc, win, element, requests, applied, cuts: () => cuts, running: () => running,
    visibility(hidden) { doc.hidden = hidden; doc.visibilityState = hidden ? "hidden" : "visible"; doc.dispatchEvent(new Event("visibilitychange")); },
    restore() { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } } };
}

function pointer(target, type, id, x) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { pointerType: "touch", pointerId: id, clientX: x, clientY: 0 });
  target.dispatchEvent(e); return e;
}

test("撮影画面は倍率を戻して自動再開し、確認中は画像・四隅・授業と回を保持して撮影イベントを拒否する", async () => {
  const env = environment();
  const $ = env.element;
  const store = await openUploadStore();
  try {
    await store.writeCaptureSettings({ classes: ["数学"], lessons: [{ className: "数学", names: [] }] });
    await import("../public/capture-app.js");
    await until(() => $("timetable-status").textContent?.includes("端末内の時間割") && !$("apply-class").disabled);
    $("class-name").value = "数学"; $("apply-class").click();
    await until(() => !$("apply-class").disabled && $("destination-status").textContent.includes("数学"));
    $("session-number").value = "7"; $("session-number").dispatchEvent(new Event("input"));
    $("start").click(); await until(() => !$("capture").disabled);
    assert.equal($("camera-comparison").open, false);
    assert.equal($("zoom").disabled, false);
    assert.match($("camera-diagnostics").textContent, /デュアル広角.*1〜10.*仮想カメラ/);
    $("zoom").value = "3"; $("zoom").dispatchEvent(new Event("input"));
    await until(() => env.applied.at(-1) === 3 && !$("capture").disabled);
    env.visibility(true); assert.equal(env.running(), 0);
    // visibilitychangeに続くpagehideでも再開予定を失わない。
    env.win.dispatchEvent(new Event("pagehide"));
    env.visibility(false); await until(() => !$("capture").disabled);
    assert.equal(env.applied.at(-1), 3); assert.equal($("start").hidden, true);
    $("capture").click();
    await until(() => !$("actual-size").disabled && !$("save-image").disabled);
    assert.equal($("image-screen").hidden, false);
    $("crop-edit").click(); $("crop-nudge").click();
    const outline = $("crop-outline").points;
    const destination = $("image-destination").textContent;
    assert.match(destination, /数学.*第07回/);
    const image = [$("image").width, $("image").height];
    const cuts = env.cuts(), opens = env.requests.length;
    $("actual-size").click();
    $("image-area").scrollTo(15, 20); $("image-area").dispatchEvent(new Event("scroll"));
    pointer($("camera-screen"), "pointerdown", 1, 0);
    pointer($("camera-screen"), "pointerdown", 2, 100);
    pointer($("camera-screen"), "pointermove", 2, 200);
    // 停止前のクリックが遅れて届いた場合も画面状態で拒否する。
    $("capture").disabled = false; $("capture").click(); $("start").click();
    env.visibility(true); env.visibility(false);
    await pause();
    assert.deepEqual([$("image").width, $("image").height], image);
    assert.equal($("crop-outline").points, outline);
    assert.equal($("image-destination").textContent, destination);
    assert.equal($("session-number").value, "7");
    assert.equal($("image-screen").hidden, false); assert.equal($("camera-screen").hidden, true);
    assert.equal($("image-area").scrollLeft, 15); assert.equal($("image-area").scrollTop, 20);
    assert.equal(env.cuts(), cuts); assert.equal(env.requests.length, opens);
    assert.equal($("camera-comparison").open, false);
  } finally { env.visibility(true); await pause(); store.close(); env.restore(); }
});

test("単体の判断ができないときは案内を表示し、撮り比べるを押すまで切り出さない", async () => {
  const env = environment([{ deviceId: "wide", label: "背面広角カメラ" }, { deviceId: "tele", label: "背面望遠カメラ" }]);
  try {
    await import("../public/camera-preview.js?comparison-test");
    env.element("start").click();
    await until(() => env.element("camera-comparison").open);
    assert.equal(env.cuts(), 0);
    assert.equal(env.element("begin-comparison").hidden, false);
    env.element("capture").click(); assert.equal(env.cuts(), 0);
    env.element("begin-comparison").click();
    await until(() => env.element("comparison-images").children.length === 2);
    assert.equal(env.cuts(), 2);
    env.element("comparison-images").children[0].children[1].click();
    await until(() => !env.element("capture").disabled);
    assert.equal(env.element("camera-comparison").open, false);
  } finally { env.visibility(true); await pause(); env.restore(); }
});

test("開始待ちの間に裏へ移ってすぐ戻っても自動再開し、再開失敗時だけボタンを表示する", async () => {
  const env = environment();
  try {
    await import("../public/camera-preview.js?resume-race-test");
    env.element("start").click();
    env.visibility(true); env.visibility(false);
    await until(() => !env.element("capture").disabled);
    assert.equal(env.element("start").hidden, true);
    env.visibility(true);
    navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error("再開失敗"), { name: "NotReadableError" }); };
    env.visibility(false);
    await until(() => env.element("status").textContent?.includes("他のカメラアプリ"));
    assert.equal(env.element("start").hidden, false);
    assert.equal(env.element("start").disabled, false);
    assert.equal(env.element("start").textContent, "カメラを再開する");
  } finally { env.visibility(true); await pause(); env.restore(); }
});


test("複数コマ撮影中は理由を表示して操作を止め、hiddenでは確認画面へ進まず撮り直せる", async () => {
  const env = environment(); const $ = env.element;
  try {
    await import("../public/camera-preview.js?sharpest-hidden-test");
    $("start").click(); await until(() => !$("capture").disabled);
    $("capture").click();
    assert.equal($("capture").disabled, true);
    assert.equal($("capture-reason").textContent, "撮影中…");
    assert.equal($("zoom").disabled, true);
    // 待機が終わって最初のコマが取得されてから中断する。
    await until(() => env.cuts() >= 2);
    env.visibility(true);
    await until(() => $("image").width === 0);
    assert.equal($("image-screen").hidden, true);
    assert.equal($("camera-screen").hidden, false);
    env.visibility(false); await until(() => !$("capture").disabled);
    $("capture").click();
    await until(() => !$("image-screen").hidden);
    assert.match($("capture-diagnostics").textContent, /8コマ.*1コマ目.*最小.*最大/);
  } finally { env.visibility(true); await pause(); env.restore(); }
});
