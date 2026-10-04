import { fullFrame, validateCorners } from "./crop-logic.js";

export function detectionSize(width, height) {
  const scale = Math.min(1, 1000 / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function hull(points) {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length > 1 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop();
      out.push(p);
    }
    return out;
  };
  return [...half(points).slice(0, -1), ...half(points.reverse()).slice(0, -1)];
}
export function plausibleCorners(points, width, height) {
  try { validateCorners(points, width, height); } catch { return false; }
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
    const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y);
    if (ab < Math.min(width, height) * 0.08 || cross(a, b, c) / (ab * bc) < 0.2) return false;
    area += a.x * b.y - a.y * b.x;
  }
  return area / 2 >= width * height * 0.15;
}

// 各工程を小分けにし、呼び出し元で中断・前面状態を確認できる。
export async function detectCorners(image, { signal, yieldTask = () => new Promise((r) => setTimeout(r, 0)), originalWidth = image.width, originalHeight = image.height } = {}) {
  const { width: w, height: h, data } = image;
  if (w < 2 || h < 2 || w > 1000 || h > 1000 || data.length !== w * h * 4) throw new Error("検出用画像の大きさが不正です。");
  const pause = async () => { await yieldTask(); signal?.throwIfAborted(); };
  signal?.throwIfAborted();
  const gray = new Uint8Array(w * h), smooth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    if (y % 16 === 0) await pause();
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let total = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h) { total += gray[(y + dy) * w + x + dx]; count++; }
      }
      smooth[y * w + x] = total / count;
    }
    if (y % 16 === 0) await pause();
  }
  let best = null, bestScore = 0;
  const queue = new Int32Array(w * h);
  for (const threshold of [50, 90, 130, 170, 210]) for (const dark of [true, false]) {
    const seen = new Uint8Array(w * h);
    const matches = (i) => dark ? smooth[i] < threshold : smooth[i] > threshold;
    for (let start = 0; start < w * h; start++) {
      if (start % (w * 16) === 0) await pause();
      if (seen[start] || !matches(start)) continue;
      let head = 0, tail = 1, border = 0;
      const left = new Int32Array(h).fill(w), right = new Int32Array(h).fill(-1);
      queue[0] = start; seen[start] = 1;
      while (head < tail) {
        const i = queue[head++], x = i % w, y = Math.floor(i / w);
        let edge = false;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
        for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
          if (n < 0 || !matches(n)) { edge = true; continue; }
          if (!seen[n]) { seen[n] = 1; queue[tail++] = n; }
        }
        // 行ごとの左右端だけで凸包を作れるため、文字の輪郭を保持しない。
        if (edge) { left[y] = Math.min(left[y], x); right[y] = Math.max(right[y], x); }
        if (head % 4096 === 0) await pause();
      }
      if (tail < w * h * 0.15 || border > (w + h) * 0.1) continue;
      await pause();
      const boundary = [];
      for (let y = 0; y < h; y++) if (right[y] >= 0) { boundary.push({ x: left[y], y }, { x: right[y], y }); }
      const polygon = hull(boundary);
      while (polygon.length > 4) {
        let index = 0, minimum = Infinity;
        for (let i = 0; i < polygon.length; i++) {
          const loss = Math.abs(cross(polygon[(i + polygon.length - 1) % polygon.length], polygon[i], polygon[(i + 1) % polygon.length]));
          if (loss < minimum) { minimum = loss; index = i; }
        }
        polygon.splice(index, 1);
      }
      if (polygon.length !== 4) continue;
      const first = polygon.reduce((best, p, i) => p.x + p.y < polygon[best].x + polygon[best].y ? i : best, 0);
      const corners = [...polygon.slice(first), ...polygon.slice(0, first)];
      if (!plausibleCorners(corners, w, h)) continue;
      const area = corners.reduce((sum, p, i) => { const q = corners[(i + 1) % 4]; return sum + p.x * q.y - p.y * q.x; }, 0) / 2;
      if (tail / area < 0.7 || tail / area > 1.1) continue;
      if (area > bestScore) { bestScore = area; best = corners; }
    }
  }
  signal?.throwIfAborted();
  return best ? best.map(({ x, y }) => ({ x: x * (originalWidth - 1) / (w - 1), y: y * (originalHeight - 1) / (h - 1) })) : fullFrame(originalWidth, originalHeight);
}
