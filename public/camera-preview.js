import { config } from "./config.js";
import { captureSharpestFrame } from "./sharpest-frame.js";
import { bindCameraStage } from "./camera-stage.js";
import { discoverCameras, chooseCamera, readChoices, rememberChoice, compareCameras, setCameraMagnification } from "./auto-camera.js";
import { captureDisabledReason } from "./capture-save.js";
import { captureFrame } from "./camera-logic.js";
import { applyTrackZoom, cameraOptions, normalizeZoom, openSelectedCamera, readCameraPreference, writeCameraPreference, zoomRange } from "./camera-options.js";
import { initializeUpdates } from "./app-update.js";
import { createLiveZoom } from "./camera-zoom.js";

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
const automaticCamera = !cameraSelect;
let automaticCandidates = null;
let selectedAutomatic = null;
let requestedMagnification = null;
let cancelComparison = null;
let comparisonStream = null;
let selectionReason = "";
let resumeCamera = false;
let stream = null;
let wakeLock = null;
let generation = 0;
let starting = false;
let zoomApplying = false;
let liveZoom = null;
let captureController = null;
let captureBlocked = false;
let operationActive = false;
export function setCaptureBlocked(value) { captureBlocked = value; updateVideoState(); }
export function setCaptureOperationActive(value) { operationActive = Boolean(value); }
export function cameraIsNavigating() { return updates.isNavigating(); }
let range = null;
let currentDeviceId = "";
let currentName = "名前未取得";
let currentZoom = null;
let storage;
try { storage = window.localStorage; } catch { /* 保存不可でも検証を続ける。 */ }
let preference = readCameraPreference(storage);
if (cameraSelect && preference.deviceId) {
  const option = document.createElement("option");
  option.value = preference.deviceId;
  option.textContent = "前回のカメラ（開始後に名前を取得）";
  cameraSelect.append(option);
  cameraSelect.value = preference.deviceId;
}

function rememberCamera() {
  preference = { deviceId: currentDeviceId, zoom: automaticCamera ? requestedMagnification : currentZoom };
  preferenceStatus.textContent = writeCameraPreference(storage, preference)
    ? preferenceStatus.textContent : "設定を記憶できません。この画面では引き続き利用できます。";
}

function showZoom(result, settled = true) {
  currentZoom = result.actual ?? result.requested;
  if (settled) zoomSlider.value = normalizeZoom(automaticCamera ? requestedMagnification : currentZoom, range);
  zoomStatus.textContent = result.actual === null
    ? `倍率：取得できません（指定 ${result.requested}×）`
    : `倍率：${result.actual}×${Math.abs(result.actual - result.requested) > range.step / 2 ? `（指定 ${result.requested}×は反映されませんでした）` : ""}`;
  if (!settled) zoomStatus.textContent += `（変更中：${zoomSlider.value}×）`;
}

async function refreshCameraList(track, current) {
  if (automaticCamera) return;
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
  if (automaticCamera) {
    range = selectedAutomatic.virtual && selectedAutomatic.range?.max > selectedAutomatic.range?.min
      ? selectedAutomatic.range : { min: 0.5, max: Math.max(10, ...automaticCandidates.map((camera) => (camera.base ?? 1) * (camera.range?.max ?? 1))), step: 0.1 };
    requestedMagnification = normalizeZoom(requestedMagnification, range);
    zoomSlider.min = range.min; zoomSlider.max = range.max; zoomSlider.step = range.step;
    const result = await setCameraMagnification(track, selectedAutomatic, requestedMagnification);
    if (current !== generation) return;
    showZoom(result);
    liveZoom = createLiveZoom({ range, initialZoom: requestedMagnification,
      applyZoom: async (value) => {
        requestedMagnification = value;
        const decision = chooseCamera(automaticCandidates, value, readChoices(storage));
        if (!decision.selected || decision.selected.deviceId !== currentDeviceId) {
          stopCamera();
          void startCamera();
          return { requested: value, actual: null };
        }
        return setCameraMagnification(track, selectedAutomatic, value);
      },
      onRequested: (value) => { requestedMagnification = value; zoomSlider.value = value; },
      onApplied: (result, { settled }) => { showZoom(result, settled); if (settled) rememberCamera(); },
      onError: () => { zoomStatus.textContent = "倍率の変更に失敗しました。再試行してください。"; },
      onBusy: (value) => { zoomApplying = value; updateVideoState(); },
    });
    return;
  }
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
  const reason = captureDisabledReason({ starting, hidden: document.hidden, ready, zoomApplying, blocked: captureController ? "撮影中…" : captureBlocked });
  captureButton.disabled = Boolean(reason);
  captureButton.classList.toggle("busy", Boolean(captureController));
  const explanation = document.querySelector("#capture-reason");
  if (explanation) { explanation.textContent = reason; explanation.hidden = !reason || (!stream && !starting && !captureController); }
  zoomSlider.disabled = Boolean(captureController) || !ready || !range || range.max <= range.min;
  video.classList.toggle("zoom-enabled", !zoomSlider.disabled);
  if (cameraSelect) cameraSelect.disabled = starting || cameraSelect.options.length <= 1;
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
  captureController?.abort();
  generation += 1;
  cancelComparison?.();
  comparisonStream?.getTracks().forEach((track) => track.stop());
  comparisonStream = null;
  liveZoom?.dispose();
  liveZoom = null;
  pinch.reset();
  video.classList.remove("zoom-enabled");
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  zoomApplying = false;
  zoomSlider.disabled = true;
  video.srcObject = null;
  updateVideoState();
  stopButton.disabled = true;
  startButton.disabled = starting;
  startButton.hidden = false;
  if (cameraSelect) cameraSelect.disabled = starting || cameraSelect.options.length <= 1;
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
    return "背面カメラを取得できません。カメラを再開して再試行してください。";
  }
  if (error.name === "NotReadableError") return "カメラを使用できません。他のカメラアプリを閉じてから再試行してください。";
  return "カメラを開始できませんでした。ページを開き直して再試行してください。";
}

async function startCamera({ deviceId = cameraSelect?.value || "", allowFallback = true } = {}) {
  if (starting || stream || document.hidden || !imageScreen.hidden || updates.isNavigating()) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status.textContent = "カメラを使うには、HTTPSの公開URLをiPhoneのSafariで開いてください。";
    return;
  }
  starting = true;
  updateVideoState();
  if (cameraSelect) cameraSelect.disabled = true;
  zoomSlider.disabled = true;
  startButton.disabled = true;
  status.textContent = "カメラを準備しています。許可の確認が表示されたら許可してください。";
  resolution.textContent = "映像：準備中";
  const current = ++generation;
  try {
    if (automaticCamera) {
      requestedMagnification ??= preference.zoom ?? 1;
      const active = () => current === generation && !document.hidden;
      automaticCandidates ||= await discoverCameras(navigator.mediaDevices, active);
      const decision = chooseCamera(automaticCandidates, requestedMagnification, readChoices(storage));
      selectionReason = decision.reason;
      const diagnostics = document.querySelector("#camera-diagnostics");
      if (diagnostics) diagnostics.textContent = selectionReason;
      selectedAutomatic = decision.selected;
      if (!selectedAutomatic) {
        const approved = await new Promise((resolve) => {
          const dialog = document.querySelector("#camera-comparison");
          const button = document.querySelector("#begin-comparison");
          const finish = (value) => { cancelComparison = null; dialog.close(); button.onclick = null; resolve(value); };
          document.querySelector("#comparison-images").replaceChildren();
          button.hidden = false;
          cancelComparison = () => finish(false);
          dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
          button.onclick = () => finish(true);
          if (active()) dialog.showModal(); else finish(false);
        });
        if (!approved || !active()) return;
        status.textContent = "見やすいカメラを撮り比べています。板面に向けたままお待ちください。";
        selectedAutomatic = await compareCameras(decision.candidates, {
          active,
          open: async (candidate) => {
            const opened = await openSelectedCamera(navigator.mediaDevices, candidate.deviceId, false);
            if (active()) comparisonStream = opened.stream;
            else opened.stream.getTracks().forEach((track) => track.stop());
            return opened;
          },
          capture: async (opened, candidate) => {
            await setCameraMagnification(opened.stream.getVideoTracks()[0], candidate, requestedMagnification);
            video.srcObject = null;
            video.load();
            video.srcObject = opened.stream;
            await video.play();
            await new Promise((resolve, reject) => {
              const deadline = performance.now() + 5000;
              function wait() {
                if (!active()) return reject(new Error("中断"));
                if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
                if (performance.now() > deadline) return reject(new Error("映像待ち時間超過"));
                setTimeout(wait, 50);
              }
              setTimeout(wait, 200);
            });
            const sample = document.createElement("canvas");
            captureFrame(video, sample);
            return sample;
          },
          choose: (samples) => new Promise((resolve) => {
            const dialog = document.querySelector("#camera-comparison");
            const list = document.querySelector("#comparison-images");
            list.replaceChildren();
            document.querySelector("#begin-comparison").hidden = true;
            const finish = (camera) => {
              cancelComparison = null;
              dialog.close(); list.replaceChildren(); resolve(camera);
            };
            cancelComparison = () => finish(null);
            dialog.oncancel = (event) => { event.preventDefault(); finish(null); };
            for (const { camera, image } of samples) {
              const card = document.createElement("div");
              const button = document.createElement("button");
              button.textContent = `${camera.label}を使う`;
              button.onclick = () => finish(camera);
              card.append(image, button); list.append(card);
            }
            if (active()) dialog.showModal(); else finish(null);
          }),
        });
        if (!rememberChoice(storage, decision.key, selectedAutomatic.deviceId)) preferenceStatus.textContent = "カメラの選択を記憶できません。次回は再度撮り比べます。";
      }
      if (!active()) return;
      deviceId = selectedAutomatic.deviceId;
    }
    const camera = await openSelectedCamera(navigator.mediaDevices, deviceId, automaticCamera ? false : allowFallback);
    if (current !== generation || document.hidden) {
      camera.stream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = camera.stream;
    const track = stream.getVideoTracks()[0];
    if (automaticCamera) {
      let capabilities = {};
      try { capabilities = track.getCapabilities?.() || {}; } catch {}
      selectedAutomatic = { ...selectedAutomatic, range: zoomRange(capabilities) };
    }
    currentDeviceId = track.getSettings?.().deviceId || (camera.fallback ? "" : deviceId);
    currentName = track.label || "名前未取得";
    cameraName.textContent = `カメラ：${currentName}`;
    const facingKnown = track.getSettings?.().facingMode === "environment";
    request.textContent = camera.requested.width
      ? `要求：${camera.requested.width.ideal} × ${camera.requested.height.ideal} px（ideal）`
      : "要求：ズームを優先し、取得可能な解像度を使用";
    const diagnostics = document.querySelector("#camera-diagnostics");
    if (diagnostics) {
      const zoom = selectedAutomatic?.range;
      diagnostics.textContent = `カメラ：${currentName}／ズーム：${zoom ? `${zoom.min}〜${zoom.max}×` : "非対応"}／${selectionReason}`;
    }
    video.srcObject = stream;
    track.addEventListener("ended", () => {
      if (stream === camera.stream) {
        stopCamera();
        status.textContent = "カメラが停止しました。「カメラを開始」で再開してください。";
      }
    });
    track.addEventListener("mute", () => { captureController?.abort(); updateVideoState(); });
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
      ? `板面を映像に収めて「${captureButton.textContent}」を押してください。`
      : "背面を指定しましたが向きの情報は取得できません。映像が背面カメラか確認してください。";
    if (camera.fallback) status.textContent = "前回のカメラを使えないため、背面の自動選択に戻しました。映像を確認してください。";
    updateVideoState();
    void keepScreenOn();
  } catch (error) {
    if (current === generation) {
      stopCamera();
      if (automaticCamera) automaticCandidates = null;
      status.textContent = cameraError(error);
      resolution.textContent = "映像：未取得";
    }
  } finally {
    starting = false;
    startButton.disabled = Boolean(stream);
    startButton.hidden = Boolean(stream);
    startButton.textContent = stream ? "カメラを開始" : "カメラを再開する";
    updateVideoState();
    if (resumeCamera && !document.hidden && imageScreen.hidden) { resumeCamera = false; void startCamera(); }
  }
}

startButton.addEventListener("click", () => { resumeCamera = false; void startCamera(); });
cameraSelect?.addEventListener("change", () => {
  const deviceId = cameraSelect?.value || "";
  stopCamera();
  void startCamera({ deviceId, allowFallback: false });
});
zoomSlider.addEventListener("input", () => { liveZoom?.request(Number(zoomSlider.value)); });
const pinch = bindCameraStage(cameraScreen, {
  active: () => imageScreen.hidden && !cameraScreen.hidden && !document.querySelector("#options-panel")?.open,
  enabled: () => !zoomSlider.disabled && Boolean(liveZoom),
  readZoom: () => Number(zoomSlider.value), onZoom: (value) => liveZoom?.request(value),
});
stopButton.addEventListener("click", () => {
  stopCamera();
  status.textContent = "カメラを停止しました。「カメラを開始」で再開できます。";
});
for (const event of ["loadeddata", "playing", "resize", "pause", "waiting"]) {
  video.addEventListener(event, updateVideoState);
}

captureButton.addEventListener("click", async () => {
  if (!imageScreen.hidden || cameraScreen.hidden || captureButton.disabled || captureController || starting || document.hidden) return;
  cameraScreen.classList.remove("flash");
  void cameraScreen.offsetWidth;
  cameraScreen.classList.add("flash");
  const controller = new AbortController();
  captureController = controller;
  const current = generation;
  status.textContent = "撮影中…";
  updateVideoState();
  try {
    const capturedAt = Date.now();
    const result = await captureSharpestFrame({ video, output: canvas, settings: config.sharpestFrame,
      signal: controller.signal, active: () => {
        const track = stream?.getVideoTracks()[0];
        return current === generation && !document.hidden && track?.readyState === "live" && !track.muted && !video.paused;
      } });
    const diagnostics = document.querySelector("#capture-diagnostics");
    if (diagnostics) diagnostics.textContent = result.fallback
      ? "直前の撮影：0コマ／押した瞬間の1コマを採用／鮮明さ：計測なし"
      : `直前の撮影：${result.count}コマ／${result.selected}コマ目を採用／鮮明さ 最小：${result.min.toFixed(2)}・最大：${result.max.toFixed(2)}`;
    const { width, height } = canvas;
    captureController = null;
    document.querySelector("#image-resolution").textContent = `撮影画像：${width} × ${height} px`;
    document.querySelector("#image-camera").textContent = `カメラ：${currentName}／${zoomStatus.textContent}`;
    stopCamera();
    cameraScreen.hidden = true;
    imageScreen.hidden = false;
    sizeButton.focus();
    document.dispatchEvent(new CustomEvent("bansho-captured", { detail: { capturedAt } }));
  } catch (error) {
    if (error.name === "AbortError") {
      status.textContent = "撮影を中止しました。カメラの再開後に撮り直してください。";
    } else status.textContent = "画像を切り出せませんでした。映像が動いていることを確認して再試行してください。";
  } finally {
    if (captureController === controller) captureController = null;
    updateVideoState();
  }
});

sizeButton.addEventListener("click", () => {
  const actual = imageArea.classList.toggle("actual-size");
  sizeButton.setAttribute("aria-pressed", String(actual));
  sizeButton.setAttribute("aria-label", actual ? "画像を画面に合わせる" : "画像を等倍で確認");
  imageArea.scrollTo(0, 0);
});

export function returnToCamera() {
  imageScreen.hidden = true;
  cameraScreen.hidden = false;
  canvas.width = 0;
  canvas.height = 0;
  imageArea.classList.remove("actual-size");
  sizeButton.setAttribute("aria-pressed", "false");
  sizeButton.setAttribute("aria-label", "画像を等倍で確認");
  startButton.focus();
  void startCamera();
}
document.querySelector("#back").addEventListener("click", returnToCamera);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    resumeCamera = imageScreen.hidden && (Boolean(stream) || starting);
    stopCamera();
    if (resumeCamera) status.textContent = "前面に戻るとカメラを自動で再開します。";
  } else if (resumeCamera && imageScreen.hidden && !starting) {
    resumeCamera = false;
    void startCamera();
  }
});
window.addEventListener("pagehide", () => {
  resumeCamera ||= imageScreen.hidden && (Boolean(stream) || starting);
  stopCamera();
});
window.addEventListener("pageshow", () => {
  if (resumeCamera && imageScreen.hidden && !document.hidden && !starting) { resumeCamera = false; void startCamera(); }
});

const updates = initializeUpdates(() => ({
  cameraActive: starting || Boolean(stream),
  imagePreview: !imageScreen.hidden,
  operationActive,
}));
