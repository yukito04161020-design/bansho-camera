import test from "node:test";
import assert from "node:assert/strict";
import { sharpness, captureSharpestFrame } from "../public/sharpest-frame.js";
import { config } from "../public/config.js";

function image(blur = false) {
  const width = 40, height = 30, data = new Uint8ClampedArray(width * height * 4);
  const pixel = (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) * 255;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = pixel(x, y);
    if (blur) {
      value = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) value += pixel(Math.max(0, x + dx), Math.max(0, y + dy)) / 25;
    }
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  return { width, height, data };
}
function fixture(scores = [image(true), image(), image(true)]) {
  const canvases = [], captures = [], waits = [];
  let clock = 0, next = 0, peak = 0;
  const controller = new AbortController();
  function canvas() {
    let width = 0, height = 0;
    const value = {
      get width() { return width; }, set width(n) { width = n; measure(); },
      get height() { return height; }, set height(n) { height = n; measure(); },
      getContext() { return {
        drawImage(source) { value.frame = source.frame; },
        getImageData() { return scores[value.frame - 1]; },
      }; },
    };
    canvases.push(value); return value;
  }
  function measure() { peak = Math.max(peak, canvases.filter(c => c.width === 4000 && c.height === 3000).length); }
  const output = canvas();
  const options = { video: {}, output, signal: controller.signal,
    settings: { ...config.sharpestFrame, maxFrames: scores.length, scoreLongEdge: 40 },
    createCanvas: canvas, now: () => clock,
    delay: async ms => { waits.push(ms); clock += ms; },
    capture(video, target) { target.width = 4000; target.height = 3000; target.frame = next++; captures.push(target); },
  };
  return { options, controller, canvases, captures, waits, peak: () => peak };
}
test("生成した鮮明・ぼかし画像のコマ列で鮮明な2コマ目を元解像度で採用し、元解像度は常に2枚以下", async () => {
  assert.ok(sharpness(image()) > sharpness(image(true)));
  const f = fixture();
  const result = await captureSharpestFrame(f.options);
  assert.deepEqual(result, { count: 3, selected: 2, min: sharpness(image(true)), max: sharpness(image()), fallback: false });
  assert.equal(f.options.output.frame, 2);
  assert.equal(f.options.output.width, 4000);
  assert.equal(f.peak(), 2);
  assert.equal(new Set(f.captures).size, 2);
  assert.equal(f.canvases[1].width, 0); assert.equal(f.canvases[2].width, 0);
  assert.equal(f.waits[0], 200 / 3);
});
test("最大4コマ・200ミリ秒の時間枠を守り、同点なら最初を採用", async () => {
  const f = fixture(Array(4).fill(image()));
  const result = await captureSharpestFrame(f.options);
  assert.equal(result.count, 4); assert.equal(result.selected, 1);
  assert.equal(f.peak(), 2);
  assert.equal(new Set(f.captures).size, 2);
  assert.ok(f.waits.reduce((a, b) => a + b, 0) < 200);
  const slow = fixture();
  slow.options.delay = async () => {};
  let clock = 0;
  slow.options.now = () => { clock += 600; return clock; };
  assert.equal((await captureSharpestFrame(slow.options)).fallback, true);
});
test("待機後に1コマも取得できなければ押した瞬間の予備を使う", async () => {
  const f = fixture(); const original = f.options.capture;
  f.options.capture = (video, target) => {
    if (target !== f.options.output) throw new Error("一時的な切り出し失敗");
    original(video, target);
  };
  const result = await captureSharpestFrame(f.options);
  assert.deepEqual(result, { count: 0, selected: 0, min: null, max: null, fallback: true });
  assert.equal(f.options.output.frame, 0); assert.equal(f.options.output.width, 4000);
});
for (const interrupt of ["hidden", "停止", "abort"]) test(`${interrupt}で途中の画像も予備も捨て、フォールバックしない`, async () => {
  const f = fixture(); let active = true, waits = 0;
  f.options.active = () => active;
  f.options.delay = async () => {
    if (++waits === 2) {
      if (interrupt === "abort") f.controller.abort(); else active = false;
    }
  };
  await assert.rejects(captureSharpestFrame(f.options), { name: "AbortError" });
  assert.ok(f.canvases.every(c => c.width === 0 && c.height === 0));
});


test("実際の待機タイマーもabortですぐ終了し、画像を解放する", async () => {
  const f = fixture(); delete f.options.delay;
  f.options.settings = { ...f.options.settings, delayMs: 60000 };
  const pending = captureSharpestFrame(f.options);
  f.controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(f.canvases.every(c => c.width === 0 && c.height === 0));
});
test("採用画像のコピーに失敗した場合は空画像を確認へ渡さず撮影失敗にする", async () => {
  const f = fixture();
  f.options.output.getContext = () => ({ drawImage() { throw new Error("コピー失敗"); } });
  await assert.rejects(captureSharpestFrame(f.options), /コピー失敗/);
  assert.ok(f.canvases.every(c => c.width === 0 && c.height === 0));
});

test("待ち0ミリ秒・200ミリ秒・最大4コマで、最初の候補はタップ直後に取得する", async () => {
  assert.deepEqual(config.sharpestFrame, { delayMs: 0, durationMs: 200, maxFrames: 4, scoreLongEdge: 800 });
  const f = fixture(Array(4).fill(image()));
  const pending = captureSharpestFrame(f.options);
  // 最初のawait（次コマの待機）より前に予備と最初の候補を取得済み。
  assert.equal(f.captures.length, 2);
  assert.equal((await pending).count, 4);
  assert.deepEqual(f.waits, [50, 50, 50]);
});
