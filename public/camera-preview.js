import { captureFrame } from "./camera-logic.js";
import { applyTrackZoom, cameraOptions, normalizeZoom, openSelectedCamera, readCameraPreference, writeCameraPreference, zoomRange } from "./camera-options.js";
import { initializeUpdates } from "./app-update.js";
import { createLiveZoom, createPinchZoom } from "./camera-zoom.js";

const video = document.querySelector("#camera");
const canvas = document.querySelector("#image");
const cameraScreen = document.querySelector("#camera-screen");
const imageScreen = document.querySelector("#image-screen");
const imageArea = document.querySelector("#image-area");
const startButton = document.querySelector("#start");
const captureButton = document.querySelector("#capture");
const stopButton = document.querySelector("#stop");
const sizeButton = document.querySelector("#actual-size");
const status = document.querySelector("#status");
const resolution = document.querySelector("#resolution");
const request = document.querySelector("#request");
const wakeStatus = document.querySelector("#wake-status");
const cameraSelect = document.querySelector("#camera-select");
const cameraName = document.querySelector("#camera-name");
const devicesStatus = document.querySelector("#devices-status");
const zoomSlider = document.querySelector("#zoom");
const zoomStatus = document.querySelector("#zoom-status");
const preferenceStatus = document.querySelector("#preference-status");
let stream = null;
let wakeLock = null;
let generation = 0;
let starting = false;
let zoomApplying = false;
let liveZoom = null;
let range = null;
let currentDeviceId = "";
let currentName = "名前未取得";
let currentZoom = null;
let storage;
try { storage = window.localStorage; } catch { /* 保存不可でも検証を続ける。 */ }
let preference = readCameraPreference(storage);
if (preference.deviceId) {
  const option = document.createElement("option");
  option.value = preference.deviceId;
  option.textContent = "前回のカメラ（開始後に名前を取得）";
  cameraSelect.append(option);
  cameraSelect.value = preference.deviceId;
}

function rememberCamera() {
  preference = { deviceId: currentDeviceId, zoom: currentZoom };
  preferenceStatus.textContent = writeCameraPreference(storage, preference)
    ? "" : "設定を記憶できません。この画面では引き続き検証できます。";
}

function showZoom(result, settled = true) {
  currentZoom = result.actual ?? result.requested;
  if (settled) zoomSlider.value = normalizeZoom(currentZoom, range);
  zoomStatus.textContent = result.actual === null
    ? `倍率：取得できません（指定 ${result.requested}×）`
    : `倍率：${result.actual}×${Math.abs(result.actual - result.requested) > range.step / 2 ? `（指定 ${result.requested}×は反映されませんでした）` : ""}`;
  if (!settled) zoomStatus.textContent += `（変更中：${zoomSlider.value}×）`;
}

async function refreshCameraList(track, current) {
  try {
    const devices = cameraOptions(await navigator.mediaDevices.enumerateDevices());
    if (current !== generation) return;
    cameraSelect.replaceChildren();
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "自動選択（背面）";
    cameraSelect.append(automatic);
    if (currentDeviceId && !devices.some((device) => device.deviceId === currentDeviceId)) {
      devices.push({ deviceId: currentDeviceId, label: track.label || "使用中のカメラ（名前未取得）" });
    }
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label;
      cameraSelect.append(option);
    }
    cameraSelect.value = currentDeviceId;
    currentName = track.label || devices.find((device) => device.deviceId === currentDeviceId)?.label || "名前未取得";
    cameraName.textContent = `カメラ：${currentName}`;
    devicesStatus.textContent = devices.length
      ? "許可後のカメラ一覧です。背面のカメラを選んでください。"
      : "選べるカメラの一覧を取得できません。現在の映像で検証できます。";
  } catch {
    if (current === generation) devicesStatus.textContent = "カメラの一覧を取得できません。現在の映像で検証できます。";
  }
}

async function configureZoom(track, current) {
  let capabilities = {};
  try { capabilities = track.getCapabilities?.() || {}; } catch { /* 非対応として案内する。 */ }
  range = zoomRange(capabilities);
  zoomSlider.disabled = true;
  if (!range) {
    currentZoom = null;
    zoomSlider.min = "1";
    zoomSlider.max = "1";
    zoomSlider.value = "1";
    zoomStatus.textContent = "倍率：このカメラではズーム操作を利用できません。";
    return;
  }
  zoomSlider.min = range.min;
  zoomSlider.max = range.max;
  zoomSlider.step = range.step;
  const actual = track.getSettings?.().zoom;
  const saved = preference.deviceId === currentDeviceId ? preference.zoom : null;
  const requested = normalizeZoom(saved ?? actual, range);
  try {
    const result = saved !== null ? await applyTrackZoom(track, requested, range)
      : { requested, actual: Number.isFinite(actual) && actual > 0 ? actual : null };
    if (current === generation) showZoom(result);
  } catch {
    if (current === generation) {
      showZoom({ requested: normalizeZoom(actual, range), actual: Number.isFinite(actual) && actual > 0 ? actual : null });
      zoomStatus.textContent += "（前回の倍率を復元できませんでした）";
    }
  }
  if (current !== generation) return;
  liveZoom = createLiveZoom({
    range, initialZoom: currentZoom,
    applyZoom: (value) => applyTrackZoom(track, value, range),
    onRequested: (value) => {
      zoomSlider.value = value;
      zoomStatus.textContent = `倍率：${currentZoom}×（変更中：${value}×）`;
    },
    onApplied: (result, { settled }) => {
      showZoom(result, settled);
      if (settled) rememberCamera();
      resolution.textContent = `映像：${video.videoWidth} × ${video.videoHeight} px`;
    },
    onError: ({ settled }) => {
      if (!settled) return;
      const actual = track.getSettings?.().zoom;
      showZoom({ requested: normalizeZoom(currentZoom, range), actual: Number.isFinite(actual) && actual > 0 ? actual : null });
      zoomStatus.textContent += "（ズーム変更に失敗しました）";
    },
    onBusy: (value) => { zoomApplying = value; updateVideoState(); },
  });
}

function updateVideoState() {
  const track = stream?.getVideoTracks()[0];
  const ready = Boolean(!starting && !document.hidden && track && track.readyState === "live" && !track.muted &&
    !video.paused && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
  captureButton.disabled = !ready || zoomApplying;
  zoomSlider.disabled = !ready || !range || range.max <= range.min;
  video.classList.toggle("zoom-enabled", !zoomSlider.disabled);
  cameraSelect.disabled = starting || cameraSelect.options.length <= 1;
  if (ready) resolution.textContent = `映像：${video.videoWidth} × ${video.videoHeight} px`;
}

async function keepScreenOn() {
  if (!stream || document.hidden || wakeLock) return;
  if (!navigator.wakeLock) {
    wakeStatus.textContent = "自動消灯の防止はこのブラウザでは利用できません。";
    return;
  }
  const current = generation;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!stream || document.hidden || current !== generation) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    wakeStatus.textContent = "自動消灯を防止しています。";
    lock.addEventListener("release", () => {
      if (wakeLock === lock) {
        wakeLock = null;
        wakeStatus.textContent = "自動消灯の防止が解除されました。";
      }
    });
  } catch {
    if (current === generation && stream) wakeStatus.textContent = "自動消灯を防止できませんでした。";
  }
}

function stopCamera() {
  generation += 1;
  liveZoom?.dispose();
  liveZoom = null;
  pinch.reset();
  video.classList.remove("zoom-enabled");
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  zoomApplying = false;
  zoomSlider.disabled = true;
  video.srcObject = null;
  captureButton.disabled = true;
  stopButton.disabled = true;
  startButton.disabled = starting;
  cameraSelect.disabled = starting || cameraSelect.options.length <= 1;
  if (wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    void lock.release().catch(() => {});
  }
  wakeStatus.textContent = "";
}

function cameraError(error) {
  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "カメラを使用できません。SafariまたはiPhoneの設定で、このサイトのカメラを許可してから再試行してください。";
  }
  if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
    return "背面カメラを取得できません。iPhoneのSafariで、別の背面カメラか「自動選択（背面）」を選んで再試行してください。";
  }
  if (error.name === "NotReadableError") return "カメラを使用できません。他のカメラアプリを閉じてから再試行してください。";
  return "カメラを開始できませんでした。ページを開き直して再試行してください。";
}

async function startCamera({ deviceId = cameraSelect.value, allowFallback = true } = {}) {
  if (starting || stream || updates.isNavigating()) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status.textContent = "カメラを使うには、HTTPSの公開URLをiPhoneのSafariで開いてください。";
    return;
  }
  starting = true;
  cameraSelect.disabled = true;
  zoomSlider.disabled = true;
  startButton.disabled = true;
  status.textContent = "カメラを準備しています。許可の確認が表示されたら許可してください。";
  resolution.textContent = "映像：準備中";
  const current = ++generation;
  try {
    const camera = await openSelectedCamera(navigator.mediaDevices, deviceId, allowFallback);
    if (current !== generation || document.hidden) {
      camera.stream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = camera.stream;
    const track = stream.getVideoTracks()[0];
    currentDeviceId = track.getSettings?.().deviceId || (camera.fallback ? "" : deviceId);
    currentName = track.label || "名前未取得";
    cameraName.textContent = `カメラ：${currentName}`;
    const facingKnown = track.getSettings?.().facingMode === "environment";
    request.textContent = `要求：${camera.requested.width.ideal} × ${camera.requested.height.ideal} px（ideal）`;
    video.srcObject = stream;
    track.addEventListener("ended", () => {
      if (stream === camera.stream) {
        stopCamera();
        status.textContent = "カメラが停止しました。「カメラを開始」で再開してください。";
      }
    });
    track.addEventListener("mute", updateVideoState);
    track.addEventListener("unmute", updateVideoState);
    await video.play();
    if (current !== generation) return;
    stopButton.disabled = false;
    await refreshCameraList(track, current);
    if (current !== generation) return;
    await configureZoom(track, current);
    if (current !== generation) return;
    rememberCamera();
    status.textContent = facingKnown
      ? "板面を映像に収めて「1コマを撮影」を押してください。"
      : "背面を指定しましたが向きの情報は取得できません。映像が背面カメラか確認してください。";
    if (camera.fallback) status.textContent = "前回のカメラを使えないため、背面の自動選択に戻しました。映像を確認してください。";
    updateVideoState();
    void keepScreenOn();
  } catch (error) {
    if (current === generation) {
      stopCamera();
      status.textContent = cameraError(error);
      resolution.textContent = "映像：未取得";
    }
  } finally {
    starting = false;
    startButton.disabled = Boolean(stream);
    updateVideoState();
  }
}

startButton.addEventListener("click", () => { void startCamera(); });
cameraSelect.addEventListener("change", () => {
  const deviceId = cameraSelect.value;
  stopCamera();
  void startCamera({ deviceId, allowFallback: false });
});
zoomSlider.addEventListener("input", () => { liveZoom?.request(Number(zoomSlider.value)); });
const pinch = createPinchZoom({ readZoom: () => Number(zoomSlider.value), onZoom: (value) => liveZoom?.request(value) });
video.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch" || zoomSlider.disabled || !liveZoom) return;
  if (pinch.start(event.pointerId, event.clientX, event.clientY)) video.setPointerCapture(event.pointerId);
});
video.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "touch" || zoomSlider.disabled || !liveZoom) return;
  pinch.move(event.pointerId, event.clientX, event.clientY);
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
  video.addEventListener(event, (pointer) => { pinch.end(pointer.pointerId); });
}
stopButton.addEventListener("click", () => {
  stopCamera();
  status.textContent = "カメラを停止しました。「カメラを開始」で再開できます。";
});
for (const event of ["loadeddata", "playing", "resize", "pause", "waiting"]) {
  video.addEventListener(event, updateVideoState);
}

captureButton.addEventListener("click", () => {
  try {
    const { width, height } = captureFrame(video, canvas);
    document.querySelector("#image-resolution").textContent = `撮影画像：${width} × ${height} px`;
    document.querySelector("#image-camera").textContent = `カメラ：${currentName}／${zoomStatus.textContent}`;
    stopCamera();
    cameraScreen.hidden = true;
    imageScreen.hidden = false;
    sizeButton.focus();
  } catch (error) {
    status.textContent = "画像を切り出せませんでした。映像が動いていることを確認して再試行してください。";
  }
});

sizeButton.addEventListener("click", () => {
  const actual = imageArea.classList.toggle("actual-size");
  sizeButton.setAttribute("aria-pressed", String(actual));
  sizeButton.textContent = actual ? "画面に合わせる" : "等倍で確認";
  imageArea.scrollTo(0, 0);
});

document.querySelector("#back").addEventListener("click", () => {
  imageScreen.hidden = true;
  cameraScreen.hidden = false;
  canvas.width = 0;
  canvas.height = 0;
  imageArea.classList.remove("actual-size");
  sizeButton.setAttribute("aria-pressed", "false");
  sizeButton.textContent = "等倍で確認";
  startButton.focus();
  void startCamera();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopCamera();
    status.textContent = "カメラを停止しました。「カメラを開始」で再開してください。";
  }
});
window.addEventListener("pagehide", stopCamera);

const updates = initializeUpdates(() => ({
  cameraActive: starting || Boolean(stream),
  imagePreview: !imageScreen.hidden,
}));
