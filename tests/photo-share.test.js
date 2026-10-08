import test from "node:test";
import assert from "node:assert/strict";
import { createPhotoShare } from "../public/photo-share.js";
import { saveCapturedImage } from "../public/capture-save.js";
import { createToast } from "../public/ui-feedback.js";

function fixture(canShare = true, setting = null) {
  const calls = [], prompts = [], notices = [], opened = [], revoked = [];
  const navigator = { canShare: data => { assert.equal(data.files[0].type, "image/jpeg"); return canShare; }, share: data => { calls.push(data); return Promise.resolve(); } };
  const storage = { getItem: () => setting, setItem: (_, value) => { setting = value; } };
  const photos = createPhotoShare({ navigator, File, storage,
    URL: { createObjectURL: () => `blob:${revoked.length}`, revokeObjectURL: url => revoked.push(url) },
    open: (...args) => opened.push(args), notify: text => notices.push(text), prompt: (...args) => prompts.push(args) });
  return { photos, calls, prompts, notices, opened, revoked };
}
test("保存完了後の共有はDriveへ渡した同じ補正後JPEGで、次の撮影では解放する", async () => {
  const f = fixture(), blob = new Blob(["corrected"], { type: "image/jpeg" });
  let finish;
  const saving = saveCapturedImage({ canvas: { width: 10, height: 20, toBlob: fn => fn(blob) },
    destination: { className: "授業", sessionFolderName: "第01回", capturedAt: 1 },
    enqueue: item => new Promise(resolve => { finish = () => { f.photos.saved(item.blob); resolve(); }; }) });
  await Promise.resolve(); assert.equal(f.prompts.length, 0); finish(); await saving;
  assert.equal(f.calls.length, 0);
  const sharing = f.photos.share(); assert.equal(f.calls.length, 1); await sharing;
  const file = f.calls[0].files[0]; assert.ok(file instanceof File); assert.equal(file.type, "image/jpeg");
  assert.equal(await file.text(), await blob.text());
  f.photos.saved(new Blob(["second"], { type: "image/jpeg" })); await f.photos.share();
  assert.equal(await f.calls[1].files[0].text(), "second"); assert.equal(f.revoked.length, 1);
  f.photos.clear(); await f.photos.share(); assert.equal(f.calls.length, 2); assert.equal(f.revoked.length, 2);
});
test("案内の既定はオン、オフは通知せず共有自体は利用できる", async () => {
  const f = fixture(); f.photos.saved(new Blob(["a"], { type: "image/jpeg" }));
  assert.equal(f.prompts[0][0], "保存しました"); await f.prompts[0][1](); assert.equal(f.calls.length, 1);
  f.photos.setEnabled(false); f.photos.saved(new Blob(["b"], { type: "image/jpeg" })); assert.equal(f.prompts.length, 1);
  await f.photos.share(); assert.equal(f.calls.length, 2);
  const restored = fixture(true, "off"); assert.equal(restored.photos.enabled(), false);
});
test("canShareがfalseならローカル画像を新しいタブで開き長押しを案内する", async () => {
  const f = fixture(false); f.photos.saved(new Blob(["a"], { type: "image/jpeg" })); await f.photos.share();
  assert.equal(f.calls.length, 0); assert.deepEqual(f.opened[0], ["blob:0", "_blank", "noopener"]);
  assert.equal(f.notices[0], "長押しして写真に追加してください");
});
test("保存通知には実際に押せる写真にも保存ボタンを付ける", () => {
  let action, pressed = 0;
  const node = { ownerDocument: { createElement: () => ({ setAttribute() {}, addEventListener: (_, fn) => { action = fn; } }) }, append(button) { this.button = button; } };
  const show = createToast({ nodes: [node], select: () => node, schedule: () => 1, cancel() {} });
  show("保存しました", () => pressed++);
  assert.equal(node.button.textContent, "写真にも保存");
  show("カメラを準備しています"); assert.equal(node.textContent, "保存しました");
  action(); assert.equal(pressed, 1);
  show("長押しして写真に追加してください"); assert.equal(node.textContent, "長押しして写真に追加してください");
});

test("サムネイルと案内設定は共有コントローラに接続され、次の撮影開始で解放する", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../public/capture-app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/camera.html", import.meta.url), "utf8");
  assert.match(app, /\$\("last-image"\)\.addEventListener\("click", \(\) => \{ void photos\.share\(\); \}\)/);
  assert.match(app, /"bansho-capture-start", \(\) => \{ photos\.clear\(\)/);
  assert.match(html, /id="photos-enabled"[^>]*checked/);
  assert.match(html, /id="thumbnail-photo" hidden>写真に保存/);
});
