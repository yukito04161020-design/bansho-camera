import { captureFrame } from "./camera-logic.js";

// 縮小RGBA画像を輝度へ変換し、4近傍ラプラシアンの分散を求める。
export function sharpness({ width, height, data }) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }
  let sum = 0, squares = 0, count = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const value = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
    sum += value; squares += value * value; count++;
  }
  return count ? Math.max(0, squares / count - (sum / count) ** 2) : 0;
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("撮影を中止しました。", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// outputと作業用の2枚だけが元解像度。予備画像もoutputを使い、追加で保持しない。
export async function captureSharpestFrame({ video, output, settings, signal,
  active = () => true, createCanvas = () => document.createElement("canvas"),
  now = () => performance.now(), delay = wait, capture = captureFrame }) {
  const check = () => {
    if (signal?.aborted || !active()) throw new DOMException("撮影を中止しました。", "AbortError");
  };
  let work, small, completed = false;
  const result = { count: 0, selected: 0, min: null, max: null, fallback: false };
  try {
    check();
    capture(video, output); // 押した瞬間の予備。コマが取れない場合だけ使う。
    work = createCanvas(); small = createCanvas();
    if (settings.delayMs > 0) await delay(settings.delayMs, signal);
    check();
    const start = now();
    for (let attempt = 0; attempt < settings.maxFrames; attempt++) {
      if (attempt) {
        const target = start + attempt * settings.durationMs / settings.maxFrames;
        await delay(Math.max(0, target - now()), signal);
      }
      check();
      if (now() - start >= settings.durationMs) break;
      let score;
      try {
        capture(video, work);
        const scale = Math.min(1, settings.scoreLongEdge / Math.max(work.width, work.height));
        small.width = Math.max(1, Math.round(work.width * scale));
        small.height = Math.max(1, Math.round(work.height * scale));
        const context = small.getContext("2d", { willReadFrequently: true });
        context.drawImage(work, 0, 0, small.width, small.height);
        score = sharpness(context.getImageData(0, 0, small.width, small.height));
      } catch (error) {
        check(); // カメラ停止はフォールバックではなく撮影中止。
        if (error.name === "AbortError") throw error;
        // 一時的な切り出し・計算失敗なら次のコマを試す。
        continue;
      }
      result.count++;
      result.min = result.min === null ? score : Math.min(result.min, score);
      if (result.max === null || score > result.max) {
        output.width = work.width; output.height = work.height;
        output.getContext("2d").drawImage(work, 0, 0);
        result.selected = result.count;
        result.max = score;
      }
    }
    check();
    result.fallback = result.count === 0;
    completed = true;
    return result;
  } finally {
    for (const item of [work, small, ...(!completed ? [output] : [])]) {
      if (item) { item.width = 0; item.height = 0; }
    }
  }
}
