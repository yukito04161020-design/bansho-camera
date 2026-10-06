export const CROP_MARGIN = { top: 24, right: 24, bottom: 32, left: 24 };
export const CORNER_RADIUS = 22;

// 画像の角に置く44pxのつまみ全体を、safe-areaと追加余白の内側へ収める。
export function cropLayout({ width, height, imageWidth, imageHeight, safeArea = {} }) {
  const bounds = Object.fromEntries(Object.entries(CROP_MARGIN).map(([edge, margin]) =>
    [edge, margin + (safeArea[edge] || 0)]));
  const availableWidth = Math.max(0, width - bounds.left - bounds.right - CORNER_RADIUS * 2);
  const availableHeight = Math.max(0, height - bounds.top - bounds.bottom - CORNER_RADIUS * 2);
  const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
  const w = imageWidth * scale, h = imageHeight * scale;
  return { left: bounds.left + CORNER_RADIUS + (availableWidth - w) / 2,
    top: bounds.top + CORNER_RADIUS + (availableHeight - h) / 2, width: w, height: h, scale };
}

export function magnifierLayout({ x, y, width, height, size = 104 }) {
  const actualSize = Math.min(size, width, height);
  const gap = 36;
  // 上に置けない角では横へ逃がし、指の位置から離す。
  const left = y >= actualSize + gap ? x - actualSize / 2
    : (x < width / 2 ? x + gap : x - gap - actualSize);
  const top = y >= actualSize + gap ? y - gap - actualSize : y - actualSize / 2;
  return { left: Math.max(0, Math.min(width - actualSize, left)),
    top: Math.max(0, Math.min(height - actualSize, top)), size: actualSize };
}
