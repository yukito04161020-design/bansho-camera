import test from "node:test";
import assert from "node:assert/strict";
import { detectCorners, plausibleCorners, detectionSize } from "../public/corner-detect.js";
import { fullFrame } from "../public/crop-logic.js";

export function syntheticBoard(index) {
  const width = 240, height = 180;
  const angle = ((index % 8) - 3.5) * 0.045;
  const points = [[-85, -53], [85, -48 - index % 5], [78 + index % 6, 53], [-80, 48]].map(([x, y]) => ({
    x: 120 + x * Math.cos(angle) - y * Math.sin(angle), y: 90 + x * Math.sin(angle) + y * Math.cos(angle),
  }));
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = index + 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = points.every((a, i) => { const b = points[(i + 1) % 4]; return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) >= 0; });
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = ((seed >>> 16) / 65535 - 0.5) * (8 + index % 4 * 4);
    let value = inside ? [30, 225, 245][Math.floor(index / 8)] : 125;
    if (inside && y % 17 < 2 && x > 65 && x < 165) value = value < 100 ? 215 : 45;
    value += noise + (x / width - 0.5) * 20 + (y / height - 0.5) * 14;
    const p = (y * width + x) * 4;
    data[p] = value; data[p + 1] = value; data[p + 2] = value; data[p + 3] = 255;
  }
  return { image: { width, height, data }, points };
}
const immediate = async () => {};
test("黒板・ホワイトボード・スクリーン24種：全四隅3%以内の正解率90%以上", async (t) => {
  let correct = 0;
  for (let i = 0; i < 24; i++) {
    const { image, points } = syntheticBoard(i);
    const actual = await detectCorners(image, { yieldTask: immediate });
    if (actual.every((p, j) => Math.hypot(p.x - points[j].x, p.y - points[j].y) <= Math.hypot(image.width, image.height) * 0.03)) correct++;
  }
  t.diagnostic(`正解 ${correct}/24 (${correct / 24 * 100}%)`);
  assert.ok(correct / 24 >= 0.9, `${correct}/24`);
});
test("無地・ノイズだけの画像は画像全体へ戻す", async () => {
  for (const noise of [false, true]) {
    const width = 80, height = 60, data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) { data.fill(120 + (noise ? (i * 17 % 19) : 0), i, i + 3); data[i + 3] = 255; }
    assert.deepEqual(await detectCorners({ width, height, data }, { yieldTask: immediate }), fullFrame(width, height));
  }
});
test("不自然な四角形を拒否し縮小座標を元画像へ戻す", async () => {
  assert.equal(plausibleCorners([{ x: 5, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 10 }, { x: 5, y: 10 }], 100, 100), false);
  assert.equal(plausibleCorners([{ x: 0, y: 0 }, { x: 99, y: 99 }, { x: 99, y: 0 }, { x: 0, y: 99 }], 100, 100), false);
  assert.equal(plausibleCorners([{ x: 0, y: 0 }, { x: 99, y: 0 }, { x: 99, y: 1 }, { x: 0, y: 99 }], 100, 100), false);
  assert.deepEqual(detectionSize(4000, 3000), { width: 1000, height: 750 });
  const { image } = syntheticBoard(0);
  const base = await detectCorners(image, { yieldTask: immediate });
  const scaled = await detectCorners(image, { yieldTask: immediate, originalWidth: 2400, originalHeight: 1800 });
  assert.deepEqual(scaled, base.map(p => ({ x: p.x * 2399 / 239, y: p.y * 1799 / 179 })));
});
test("行処理の途中で中断する", async () => {
  const controller = new AbortController(); let yields = 0;
  await assert.rejects(detectCorners(syntheticBoard(0).image, { signal: controller.signal, yieldTask: async () => { if (++yields === 3) controller.abort(); } }), { name: "AbortError" });
  assert.equal(yields, 3);
});
