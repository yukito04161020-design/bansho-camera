export class CropError extends Error {}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new CropError("画像の大きさを確認できません。");
  }
}

export function fullFrame(width, height) {
  dimensions(width, height);
  return [{ x: 0, y: 0 }, { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
}

export function validateCorners(points, width, height) {
  dimensions(width, height);
  if (!Array.isArray(points) || points.length !== 4) throw new CropError("四隅を指定してください。");
  const corners = points.map((point) => {
    const x = point?.x, y = point?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width - 1 || y > height - 1) {
      throw new CropError("四隅を画像の内側へ動かしてください。");
    }
    return { x, y };
  });
  let area = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross <= 1e-6 || Math.hypot(b.x - a.x, b.y - a.y) < 2) {
      throw new CropError("枠が交差しないよう、左上・右上・右下・左下の順に広げてください。");
    }
    area += a.x * b.y - a.y * b.x;
  }
  if (area / 2 < Math.max(4, width * height * 0.0001)) throw new CropError("切り取り範囲が小さすぎます。");
  return corners;
}

export function cropPlan(points, width, height) {
  const p = validateCorners(points, width, height);
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let outputWidth = Math.round(Math.max(distance(p[0], p[1]), distance(p[3], p[2]))) + 1;
  let outputHeight = Math.round(Math.max(distance(p[0], p[3]), distance(p[1], p[2]))) + 1;
  const scale = Math.min(1, 4096 / Math.max(outputWidth, outputHeight),
    Math.sqrt(12_000_000 / (outputWidth * outputHeight)));
  outputWidth = Math.max(2, Math.floor(outputWidth * scale));
  outputHeight = Math.max(2, Math.floor(outputHeight * scale));
  const dx1 = p[1].x - p[2].x, dx2 = p[3].x - p[2].x;
  const dy1 = p[1].y - p[2].y, dy2 = p[3].y - p[2].y;
  const dx3 = p[0].x - p[1].x + p[2].x - p[3].x;
  const dy3 = p[0].y - p[1].y + p[2].y - p[3].y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 1e-8) throw new CropError("この枠は補正できません。四隅を広げてください。");
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const matrix = [p[1].x - p[0].x + g * p[1].x, p[3].x - p[0].x + h * p[3].x, p[0].x,
    p[1].y - p[0].y + g * p[1].y, p[3].y - p[0].y + h * p[3].y, p[0].y, g, h];
  if (matrix.some((value) => !Number.isFinite(value)) || [1, 1 + g, 1 + h, 1 + g + h].some((value) => value <= 1e-8)) {
    throw new CropError("この枠は補正できません。四隅を広げてください。");
  }
  return { width: outputWidth, height: outputHeight, matrix };
}

export function sourcePoint(matrix, u, v) {
  const divisor = matrix[6] * u + matrix[7] * v + 1;
  return { x: (matrix[0] * u + matrix[1] * v + matrix[2]) / divisor,
    y: (matrix[3] * u + matrix[4] * v + matrix[5]) / divisor };
}

// 画素は呼び出し元のメモリ内のみ。画像ファイルや外部送信には依存しない。
export function rectifyRows(source, plan, firstRow, rowCount) {
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 2 || source.height < 2
    || !(source.data instanceof Uint8ClampedArray) || source.data.length !== source.width * source.height * 4
    || !Number.isInteger(firstRow) || !Number.isInteger(rowCount) || firstRow < 0 || rowCount < 1
    || firstRow + rowCount > plan.height) throw new CropError("補正する画像を確認できません。");
  const result = new Uint8ClampedArray(plan.width * rowCount * 4);
  for (let y = firstRow; y < firstRow + rowCount; y += 1) {
    for (let x = 0; x < plan.width; x += 1) {
      const point = sourcePoint(plan.matrix, x / (plan.width - 1), y / (plan.height - 1));
      const sx = Math.min(source.width - 1, Math.max(0, point.x));
      const sy = Math.min(source.height - 1, Math.max(0, point.y));
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const target = ((y - firstRow) * plan.width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const pixel = (px, py) => source.data[(py * source.width + px) * 4 + channel];
        result[target + channel] = (pixel(x0, y0) * (1 - fx) + pixel(x1, y0) * fx) * (1 - fy)
          + (pixel(x0, y1) * (1 - fx) + pixel(x1, y1) * fx) * fy;
      }
    }
  }
  return result;
}

export class CropState {
  constructor() { this.clear(); }
  clear() { this.generation = (this.generation || 0) + 1; this.source = null; this.result = null; this.busy = false; }
  begin(source) { this.clear(); this.source = source; this.corners = fullFrame(source.width, source.height); }
  change(points) {
    if (!this.source || this.busy) throw new CropError("補正が終わってから四隅を動かしてください。");
    this.corners = points.map((point) => ({ ...point }));
    this.result = null;
    this.generation += 1;
  }
  reset() { this.change(fullFrame(this.source.width, this.source.height)); }
  get savable() { return Boolean(this.result) && !this.busy; }
  async preview(render) {
    if (!this.source || this.busy) throw new CropError("補正する画像を確認できません。");
    const plan = cropPlan(this.corners, this.source.width, this.source.height);
    const generation = this.generation;
    this.result = null;
    this.busy = true;
    try {
      const result = await render(this.source, plan);
      if (generation === this.generation) this.result = result;
    } finally { if (generation === this.generation) this.busy = false; }
  }
}
