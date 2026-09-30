import { captureFrame, openRearCamera } from "./camera-logic.js";

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
let stream = null;
let wakeLock = null;
let generation = 0;
let starting = false;

function updateVideoState() {
  const track = stream?.getVideoTracks()[0];
  const ready = Boolean(track && track.readyState === "live" && !track.muted &&
    !video.paused && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
  captureButton.disabled = !ready;
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
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  captureButton.disabled = true;
  stopButton.disabled = true;
  startButton.disabled = starting;
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
    return "背面カメラを取得できません。iPhoneのSafariで開いてください。";
  }
  if (error.name === "NotReadableError") return "カメラを使用できません。他のカメラアプリを閉じてから再試行してください。";
  return "カメラを開始できませんでした。ページを開き直して再試行してください。";
}

async function startCamera() {
  if (starting || stream) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status.textContent = "カメラを使うには、HTTPSの公開URLをiPhoneのSafariで開いてください。";
    return;
  }
  starting = true;
  startButton.disabled = true;
  status.textContent = "カメラを準備しています。許可の確認が表示されたら許可してください。";
  resolution.textContent = "映像：準備中";
  const current = ++generation;
  try {
    const camera = await openRearCamera(navigator.mediaDevices);
    if (current !== generation || document.hidden) {
      camera.stream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = camera.stream;
    const track = stream.getVideoTracks()[0];
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
    status.textContent = facingKnown
      ? "板面を映像に収めて「1コマを撮影」を押してください。"
      : "背面を指定しましたが向きの情報は取得できません。映像が背面カメラか確認してください。";
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
  }
}

startButton.addEventListener("click", startCamera);
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
