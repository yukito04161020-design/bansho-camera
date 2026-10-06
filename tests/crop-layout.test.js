import test from "node:test";
import assert from "node:assert/strict";
import { cropLayout, magnifierLayout, CROP_MARGIN, CORNER_RADIUS } from "../public/crop-layout.js";
import { fullFrame } from "../public/crop-logic.js";

const screens = [
  { width: 393, height: 852, safeArea: { top: 59, bottom: 34 } },
  { width: 440, height: 956, safeArea: { top: 62, bottom: 34 } },
  { width: 852, height: 393, safeArea: { left: 59, bottom: 21 } },
  { width: 852, height: 393, safeArea: { right: 59, bottom: 21 } },
  { width: 956, height: 440, safeArea: { left: 62, bottom: 21 } },
  { width: 956, height: 440, safeArea: { right: 62, bottom: 21 } },
  { width: 320, height: 568, safeArea: {} },
  // 実際の画像領域（操作パネルが縦40%、横38%を占める場合）
  { width: 393, height: 511, safeArea: { top: 59, bottom: 34 } },
  { width: 528, height: 393, safeArea: { right: 59, bottom: 21 } },
];
for (const screen of screens) {
  test(`画面${screen.width}×${screen.height}・safe-area${JSON.stringify(screen.safeArea)}でつまみ全体が余白内に収まる`, () => {
    for (const [imageWidth, imageHeight] of [[1920, 1080], [1080, 1920], [4096, 4096], [80, 60]]) {
      const rect = cropLayout({ ...screen, imageWidth, imageHeight });
      assert.ok(Math.abs(rect.width / rect.height - imageWidth / imageHeight) < 1e-10);
      assert.ok(rect.width > 0 && rect.height > 0);
      for (const points of [fullFrame(imageWidth, imageHeight),
        [{ x: 15, y: 10 }, { x: imageWidth - 20, y: 12 }, { x: imageWidth - 5, y: imageHeight - 8 }, { x: 10, y: imageHeight - 15 }]]) {
        for (const point of points) {
          const x = rect.left + point.x / (imageWidth - 1) * rect.width;
          const y = rect.top + point.y / (imageHeight - 1) * rect.height;
          assert.ok(x - CORNER_RADIUS >= (screen.safeArea.left || 0) + CROP_MARGIN.left - 1e-8);
          assert.ok(x + CORNER_RADIUS <= screen.width - (screen.safeArea.right || 0) - CROP_MARGIN.right + 1e-8);
          assert.ok(y - CORNER_RADIUS >= (screen.safeArea.top || 0) + CROP_MARGIN.top - 1e-8);
          assert.ok(y + CORNER_RADIUS <= screen.height - (screen.safeArea.bottom || 0) - CROP_MARGIN.bottom + 1e-8);
        }
      }
    }
  });
}

test("拡大鏡は上または横へ置き、四隅や画面外へ動いた指でも画面内に収まる", () => {
  for (const { width, height } of screens) {
    for (const x of [-100, 0, 50, width / 2, width - 50, width, width + 100]) {
      for (const y of [-100, 0, 50, height / 2, height, height + 100]) {
        const lens = magnifierLayout({ x, y, width, height });
        assert.ok(lens.left >= 0 && lens.top >= 0);
        assert.ok(lens.left + lens.size <= width && lens.top + lens.size <= height);
      }
    }
  }
  const above = magnifierLayout({ x: 200, y: 300, width: 400, height: 800 });
  assert.ok(above.top + above.size < 300);
  const side = magnifierLayout({ x: 50, y: 50, width: 400, height: 800 });
  assert.ok(side.left > 50);
});
