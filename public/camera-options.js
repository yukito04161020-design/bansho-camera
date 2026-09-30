import { openRearCamera } from "./camera-logic.js";

const preferenceKey = "bansho-camera.capture-preferences";

export function readCameraPreference(storage) {
  try {
    const value = JSON.parse(storage.getItem(preferenceKey));
    return {
      deviceId: typeof value?.deviceId === "string" ? value.deviceId : "",
      zoom: Number.isFinite(value?.zoom) && value.zoom > 0 ? value.zoom : null,
    };
  } catch {
    return { deviceId: "", zoom: null };
  }
}

export function writeCameraPreference(storage, preference) {
  try {
    storage.setItem(preferenceKey, JSON.stringify(preference));
    return true;
  } catch {
    return false;
  }
}

export function cameraOptions(devices) {
  const seen = new Set();
  return devices.filter((device) => {
    if (device.kind !== "videoinput" || !device.deviceId || seen.has(device.deviceId)) return false;
    seen.add(device.deviceId);
    return true;
  }).map((device, index) => ({ deviceId: device.deviceId, label: device.label || `カメラ ${index + 1}（名前未取得）` }));
}

export async function openSelectedCamera(mediaDevices, deviceId, allowFallback) {
  try {
    return { ...await openRearCamera(mediaDevices, { deviceId }), fallback: false };
  } catch (error) {
    if (!allowFallback || !deviceId || !["NotFoundError", "OverconstrainedError"].includes(error.name)) throw error;
    return { ...await openRearCamera(mediaDevices), fallback: true };
  }
}

export function zoomRange(capabilities = {}) {
  const range = capabilities.zoom;
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min <= 0 || range.max < range.min) return null;
  const step = Number.isFinite(range.step) && range.step > 0 ? range.step : (range.max - range.min) / 100 || 1;
  return { min: range.min, max: range.max, step };
}

export function normalizeZoom(value, range) {
  const chosen = Number.isFinite(value) ? value : range.min;
  const lastStep = Math.floor((range.max - range.min) / range.step + 1e-8);
  const steps = Math.min(lastStep, Math.max(0, Math.round((chosen - range.min) / range.step)));
  return Number((range.min + steps * range.step).toPrecision(12));
}

export async function applyTrackZoom(track, value, range) {
  const requested = normalizeZoom(value, range);
  const { zoom: oldZoom, advanced = [], ...base } = track.getConstraints?.() || {};
  const retained = advanced.map(({ zoom, ...other }) => other).filter((item) => Object.keys(item).length > 0);
  await track.applyConstraints({ ...base, advanced: [...retained, { zoom: requested }] });
  const actual = track.getSettings?.().zoom;
  return { requested, actual: Number.isFinite(actual) && actual > 0 ? actual : null };
}
