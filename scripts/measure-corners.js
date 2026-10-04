import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

// ブラウザの画像デコーダを使う。実画像や依存パッケージを公開リポジトリへ入れない。
export async function startMeasurement(directory) {
  if (!directory) { console.log("SKIP: CORNER_SAMPLES_DIR未指定（実画像なし）"); return null; }
  let root;
  try { root = await realpath(directory); } catch (e) {
    if (e.code === "ENOENT") { console.log("SKIP: サンプル画像の場所がありません"); return null; }
    throw e;
  }
  let samples;
  try { samples = JSON.parse(await readFile(resolve(root, "corners.json"), "utf8")); } catch (e) {
    if (e.code === "ENOENT") { console.log("SKIP: corners.jsonがありません"); return null; }
    throw e;
  }
  if (!Array.isArray(samples)) throw new Error("corners.jsonは配列にしてください。");
  if (!samples.length) { console.log("SKIP: サンプル0件"); return null; }
  const paths = await Promise.all(samples.map(async (sample) => {
    if (typeof sample.file !== "string" || !Array.isArray(sample.corners) || sample.corners.length !== 4
      || sample.corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("サンプルの形式が不正です。");
    const path = await realpath(resolve(root, sample.file));
    if (!path.startsWith(root + sep)) throw new Error("サンプルは指定ディレクトリ内に置いてください。");
    return path;
  }));
  const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
  const page = `<!doctype html><meta charset="utf-8"><title>四隅検出精度測定</title><pre id="result">測定中</pre><script type="module">
import { detectCorners, detectionSize } from '/corner-detect.js';
try {
 const samples = await (await fetch('/samples')).json(); let correct = 0; const rows = [];
 for (let i = 0; i < samples.length; i++) {
  const img = new Image(); img.src = '/image/' + i; await img.decode();
  const canvas = document.createElement('canvas'); const size = detectionSize(img.naturalWidth, img.naturalHeight);
  canvas.width = size.width; canvas.height = size.height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, size.width, size.height);
  const points = await detectCorners(ctx.getImageData(0, 0, size.width, size.height), { originalWidth: img.naturalWidth, originalHeight: img.naturalHeight });
  const errors = points.map((p,j) => Math.hypot(p.x - samples[i].corners[j].x, p.y - samples[i].corners[j].y) / Math.hypot(img.naturalWidth, img.naturalHeight));
  const ok = errors.every(e => e <= 0.03); if(ok) correct++; rows.push({sample:i, correct:ok, errors}); canvas.width = canvas.height = 0;
 }
 const report = { correct, total:samples.length, accuracy:correct/samples.length, passed:correct/samples.length >= 0.9, rows };
 document.getElementById('result').textContent = JSON.stringify(report,null,2);
 await fetch('/result', { method:'POST', body:JSON.stringify(report) });
} catch(e) { document.getElementById('result').textContent = '測定失敗: ' + e.message; await fetch('/result', {method:'POST',body:JSON.stringify({error:e.message})}); }
</script>`;
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (req.url === "/" && req.method === "GET") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(page); }
      else if (req.url === "/samples") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(samples.map(s => ({ corners: s.corners })))); }
      else if (/^\/image\/\d+$/.test(req.url)) {
        const path = paths[Number(req.url.split("/").at(-1))];
        if (!path) { res.writeHead(404); res.end(); return; }
        res.setHeader("Content-Type", ({".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".webp":"image/webp"})[extname(path).toLowerCase()] || "application/octet-stream");
        res.end(await readFile(path));
      } else if (["/corner-detect.js", "/crop-logic.js"].includes(req.url)) {
        res.setHeader("Content-Type", "text/javascript"); res.end(await readFile(resolve(publicRoot, req.url.slice(1))));
      } else if (req.url === "/result" && req.method === "POST") {
        let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) throw new Error("結果が大きすぎます。"); }
        const result = JSON.parse(body); console.log(JSON.stringify(result, null, 2));
        if (!result.passed) process.exitCode = 1;
        res.end("OK"); server.close();
      } else { res.writeHead(404); res.end(); }
    } catch { res.writeHead(500); res.end("測定に失敗しました。"); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  console.log(`ブラウザで http://127.0.0.1:${server.address().port}/ を開いてください（終了はCtrl+C）。`);
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMeasurement(process.env.CORNER_SAMPLES_DIR);
}
