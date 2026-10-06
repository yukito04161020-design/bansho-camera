import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLiveOutline } from "../public/live-outline.js";
import { prepareReviewSave } from "../public/review-save.js";
import { zoomStops } from "../public/camera-ui.js";
import { createCapturedDraft } from "../public/capture-save.js";

test("主な操作ボタンは読み上げ名を持ち、44px以上の操作領域をCSSで指定する", async () => {
  const html = await readFile(new URL("../public/camera.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/capture.css", import.meta.url), "utf8");
  const buttons = [...html.matchAll(/<button\b([^>]*)>/g)];
  assert.ok(buttons.length > 30);
  for (const [, attributes] of buttons) assert.match(attributes, /aria-label="[^"]+"/);
  assert.match(css, /button\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  assert.match(css, /#capture\s*\{[^}]*width: 72px;[^}]*height: 72px;/);
  assert.match(css, /\.crop-corner\s*\{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.ok([...css.matchAll(/min-(?:width|height): (\d+)px/g)].every(match => Number(match[1]) >= 44));
  assert.match(css, /#camera\s*\{ object-fit: cover;/);
  assert.equal((html.match(/data-app-version/g) || []).length, 1);
  assert.ok(html.indexOf('data-app-version') > html.indexOf('id="app-options"'));
});

test("保存先を先に求め、補正前の保存は補正が終わってから保存へ画像を渡す", async () => {
  const events = [], image = { width: 50, height: 30 };
  let destination = null, finish;
  const crop = { prepareSave: () => { events.push("補正"); return new Promise(resolve => { finish = () => resolve(image); }); } };
  const draft = { resolve: () => destination };
  assert.equal(await prepareReviewSave({ draft, crop, selectDestination: () => events.push("選択") }), null);
  assert.deepEqual(events, ["選択"]);
  destination = { className: "架空の授業", sessionFolderName: "第01回" };
  const saving = prepareReviewSave({ draft, crop, selectDestination: () => assert.fail() }).then(canvas => { events.push("保存"); assert.equal(canvas, image); });
  assert.deepEqual(events, ["選択", "補正"]); finish(); await saving;
  assert.deepEqual(events, ["選択", "補正", "保存"]);
});

test("確認画面で明示的に保存先を変更でき、撮影日時は保持する", () => {
  let name = "授業A";
  const draft = createCapturedDraft(1000, capturedAt => ({ className: name, capturedAt }));
  name = "授業B"; assert.equal(draft.resolve().className, "授業A");
  assert.equal(draft.reselect().className, "授業B"); assert.equal(draft.destination.capturedAt, 1000);
});

test("枠表示は設定OFFと裏への移動でタイマー・検出を中止し、古い結果を描かない", async () => {
  let active = true, task, signal, resolve, draws = 0, clears = 0;
  const live = createLiveOutline({ active: () => active, schedule: fn => { task = () => { task = null; return fn(); }; return 1; }, cancel: () => { task = null; },
    detect: s => { signal = s; return new Promise(r => { resolve = r; }); }, draw: () => draws++, clear: () => clears++, now: () => 0 });
  live.refresh(); const running = task();
  live.setEnabled(false); assert.equal(signal.aborted, true); assert.equal(task, null);
  resolve([]); await running; assert.equal(draws, 0);
  live.setEnabled(true); const second = task(); active = false; live.refresh();
  assert.equal(signal.aborted, true); resolve([]); await second;
  assert.equal(task, null); assert.equal(draws, 0); assert.ok(clears >= 3);
  active = true; live.refresh(); assert.equal(typeof task, "function"); live.stop(); assert.equal(task, null);
});

test("重い検出後は繰り返さず枠表示を止める", async () => {
  let time = 0, task, drawn = 0;
  const live = createLiveOutline({ active: () => true, schedule: fn => { task = () => { task = null; return fn(); }; return 1; }, cancel: () => { task = null; },
    detect: async () => { time = 300; return []; }, draw: () => drawn++, clear() {}, now: () => time });
  live.refresh(); const tick = task; task = null; await tick(); assert.equal(task, null); assert.equal(drawn, 1);
});

test("倍率候補は能力範囲内の2〜5個に収める", () => {
  assert.deepEqual(zoomStops(.5, 10), [.5, 1, 2, 3, 5]);
  assert.deepEqual(zoomStops(1, 2), [1, 2]);
  assert.deepEqual(zoomStops(1.2, 1.8), [1.2, 1.8]);
  assert.deepEqual(zoomStops(1, 1), [1]);
});

test("画面確認後の配置は透明28px輪・縮まないアイコン・上端の完了ボタンを使う", async () => {
  const html = await readFile(new URL("../public/camera.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/capture.css", import.meta.url), "utf8");
  assert.match(css, /\.crop-corner::before\s*\{[^}]*width: 28px;[^}]*height: 28px;[^}]*border: 3px solid #fff;[^}]*background: transparent;/);
  assert.match(css, /\.crop-corner\[aria-pressed="true"\]::before\s*\{ border-color: #FFD60A;/);
  assert.match(css, /button svg\s*\{ flex-shrink: 0;/);
  for (const id of ["crop-auto", "crop-reset", "crop-preview"]) assert.match(html, new RegExp(`id="${id}"[^>]*><svg`));
  assert.match(html, /class="review-top"[\s\S]*?id="image-info"[\s\S]*?<\/div>/);
  assert.match(html, /class="sheet-header"[\s\S]*?id="close-options"[^>]*>完了<\/button><\/header>/);
  assert.match(html, /id="sheet-grip"/);
  assert.match(css, /#camera-screen \.top\s*\{ left: auto; right: 0;/);
});
