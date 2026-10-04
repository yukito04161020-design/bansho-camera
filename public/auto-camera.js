import { openRearCamera } from "./camera-logic.js";
import { cameraOptions, zoomRange, applyTrackZoom } from "./camera-options.js";

export function describeCamera(device, capabilities = {}) {
  const label = device.label || "";
  const virtual = /triple|dual|トリプル|デュアル/i.test(label);
  const base = /ultra.?wide|超広角/i.test(label) ? 0.5
    : /telephoto|tele|望遠/i.test(label) ? null
    : /wide|広角/i.test(label) && !virtual ? 1 : null;
  return { ...device, virtual, base, range: zoomRange(capabilities) };
}

export function chooseCamera(cameras, zoom, remembered = {}) {
  const virtual = cameras.filter((camera) => camera.virtual && camera.range && camera.range.max > camera.range.min);
  let candidates = virtual;
  if (!candidates.length) {
    const singles = cameras.filter((camera) => !camera.virtual);
    const pool = singles.length ? singles : cameras;
    // 望遠の光学倍率は機種で異なる。名前から3倍・5倍と決めつけない。
    const unknown = pool.filter((camera) => camera.base === null);
    const distance = (camera) => {
      const min = camera.base * (camera.range?.min ?? 1);
      const max = camera.base * (camera.range?.max ?? 1);
      return Math.abs(zoom - Math.max(min, Math.min(max, zoom)));
    };
    const known = pool.filter((camera) => camera.base !== null);
    const best = Math.min(...known.map(distance));
    candidates = [...known.filter((camera) => Math.abs(distance(camera) - best) < 1e-6), ...unknown];
  }
  const key = `${zoom}:${candidates.map((camera) => camera.deviceId).sort().join("|")}`;
  const saved = candidates.find((camera) => camera.deviceId === remembered[key]);
  return { key, candidates, selected: saved || (candidates.length === 1 ? candidates[0] : null) };
}

const storageKey = "bansho-camera.auto-choices";
export function readChoices(storage) {
  try {
    const value = JSON.parse(storage.getItem(storageKey));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function rememberChoice(storage, key, deviceId) {
  try { storage.setItem(storageKey, JSON.stringify({ ...readChoices(storage), [key]: deviceId })); return true; }
  catch { return false; }
}

// 同時に複数の背面ストリームを開かない。停止・裏への移動は各awaitの後でも確認する。
export async function discoverCameras(mediaDevices, active = () => true) {
  const cameras = [];
  let initial;
  try {
    initial = await openRearCamera(mediaDevices);
    if (!active()) throw new Error("カメラ選択を中断しました。");
    const track = initial.stream.getVideoTracks()[0];
    const fallback = { deviceId: track.getSettings?.().deviceId || "", label: track.label || "背面カメラ" };
    let devices = [];
    try { devices = cameraOptions(await mediaDevices.enumerateDevices()); } catch { /* 現在の背面カメラで続ける。 */ }
    initial.stream.getTracks().forEach((item) => item.stop());
    initial = null;
    for (const device of devices.length ? devices : [fallback]) {
      if (/front|user|前面|フロント|FaceTime/i.test(device.label)) continue;
      if (!active()) throw new Error("カメラ選択を中断しました。");
      let opened;
      try {
        opened = await openRearCamera(mediaDevices, device);
        if (!active()) throw new Error("カメラ選択を中断しました。");
        const candidate = opened.stream.getVideoTracks()[0];
        let capabilities = {};
        try { capabilities = candidate.getCapabilities?.() || {}; } catch {}
        cameras.push(describeCamera({ ...device, label: candidate.label || device.label }, capabilities));
      } catch (error) {
        if (!active() || ["NotAllowedError", "SecurityError"].includes(error.name)) throw error;
      } finally { opened?.stream.getTracks().forEach((item) => item.stop()); }
    }
    if (!cameras.length) throw new Error("背面カメラを取得できませんでした。");
    return cameras;
  } finally { initial?.stream.getTracks().forEach((item) => item.stop()); }
}

export async function setCameraMagnification(track, camera, zoom) {
  if (!camera.range) return { requested: zoom, actual: camera.base };
  const factor = camera.virtual ? 1 : camera.base ?? 1;
  const result = await applyTrackZoom(track, zoom / factor, camera.range);
  return { requested: result.requested * factor, actual: result.actual === null ? null : result.actual * factor };
}

export async function compareCameras(candidates, { open, capture, choose, active = () => true }) {
  const samples = [];
  for (const camera of candidates) {
    if (!active()) throw new Error("撮り比べを中断しました。");
    const opened = await open(camera);
    try {
      if (!active()) throw new Error("撮り比べを中断しました。");
      const image = await capture(opened, camera);
      if (!active()) throw new Error("撮り比べを中断しました。");
      samples.push({ camera, image });
    } finally { opened.stream.getTracks().forEach((track) => track.stop()); }
  }
  const selected = await choose(samples);
  if (!active() || !candidates.includes(selected)) throw new Error("撮り比べを中断しました。");
  return selected;
}
