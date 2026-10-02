import { config } from "./config.js";
import { TokenSession, tokenClientOptions } from "./login-logic.js";
import { classFolderName, FolderNameError } from "./folder-logic.js";
import { captureDestination, captureSettings, saveCapturedImage } from "./capture-save.js";
import { createDriveFolders, DriveFolderError } from "./drive-folders.js";
import { createDriveUpload } from "./drive-upload.js";
import { createUploadQueue } from "./upload-queue.js";
import { returnToCamera, setCaptureBlocked, setCaptureOperationActive, cameraIsNavigating } from "./camera-preview.js";

const session = new TokenSession();
const folders = createDriveFolders({ session });
const upload = createDriveUpload({ session, folders });
const $ = (id) => document.getElementById(id);
const controllers = new Set();
let queue;
let queueState = { pendingCount: null, status: "waiting", reason: null };
let settings = captureSettings();
let pending = [];
let captured = null;
let saving = false;
let initializing = true;
let authorizing = false;
let libraryReady = false;
let folderLoading = false;
let listing = 0;
let loginAttempt = 0;
let authMessage = "";
let destinationMessage = "";
let storedMessage = "";

function namesFor(className) {
  const cached = settings.lessons.find((lesson) => lesson.className === className);
  if (!cached) return null;
  return [...new Set([...cached.names, ...pending.filter((item) => item.className === className).map((item) => item.sessionFolderName)])];
}
function selection(capturedAt = Date.now()) {
  const existingNames = namesFor(settings.selectedClass);
  if (!settings.selectedClass || existingNames === null) throw new Error("保存先をオンラインで確認してください。");
  const text = $("session-number").value;
  const manualSession = text === "" ? undefined : /^\d+$/.test(text) ? Number(text) : NaN;
  return captureDestination({ className: settings.selectedClass, existingNames, capturedAt, manualSession });
}
function render() {
  const token = session.snapshot();
  setCaptureOperationActive(initializing || saving || authorizing || folderLoading || token.status === "valid");
  let destination = null;
  try { destination = selection(); } catch { /* 未確認や入力不正は撮影前に案内する。 */ }
  $("destination-status").textContent = (destination
    ? `授業：${destination.className}／${destination.sessionFolderName}`
    : `授業：${settings.selectedClass || "未選択"}／回：未確定。初回は保存先のオンライン確認が必要です。`)
    + (destinationMessage ? `（${destinationMessage}）` : "");
  setCaptureBlocked(initializing || saving || !destination);
  $("destination-status").setAttribute("aria-expanded", String($("save-options").open));
  const locked = initializing || saving || authorizing || folderLoading;
  $("apply-class").disabled = locked || !queue;
  $("class-name").disabled = locked;
  $("session-number").disabled = locked;
  $("refresh-folders").disabled = locked || token.status !== "valid" || navigator.onLine === false;
  $("google-login").disabled = locked || !libraryReady || !queue || queueState.status === "sending";
  $("google-login").textContent = token.status === "valid" ? "Googleアカウントを選び直す" : "Googleでログイン・取り直す";
  $("cancel-login").hidden = !authorizing;
  $("auth-status").textContent = authMessage || (token.status === "valid"
    ? `Googleログイン済み（残り約${Math.ceil(token.remainingSeconds / 60)}分）`
    : "未ログインです。端末内の送信待ちはログイン後に送れます。");
  $("save-image").disabled = saving || !captured || !queue;
  $("back").disabled = saving;
  $("retry-upload").disabled = !queue || saving || authorizing || queueState.status === "sending";
  document.querySelectorAll("[data-pending-count]").forEach((node) => {
    node.textContent = queueState.pendingCount === null ? "送信待ち：確認できません" : `送信待ち：${queueState.pendingCount}件`;
  });
  const reasonMessage = {
    authentication: "Googleログインを取り直すと再開します。画像は端末内に残っています。",
    permission: "保存先・回数・Driveの権限を確認してください。画像は端末内に残っています。",
    network: "通信の復帰後、前面で再送します。画像は端末内に残っています。",
    server: "時間をおいて再送します。画像は端末内に残っています。",
    upload: "送信完了を確認できません。画像を残して再試行します。",
    storage: "端末内の送信待ちを確認できません。画像確認中なら保存せず閉じないでください。",
    "locking-unavailable": "このブラウザでは送信の排他制御を利用できません。画像は端末内に残っています。",
  };
  const transfer = queueState.status === "sending" ? "ドライブへ送信しています。次の撮影もできます。"
    : reasonMessage[queueState.reason] || storedMessage || (queueState.pendingCount ? "前面・オンラインで順に送ります。" : "送信待ちはありません。");
  document.querySelectorAll("[data-transfer-status]").forEach((node) => { node.textContent = transfer; });
}
function showClasses() {
  $("class-list").replaceChildren(...settings.classes.map((name) => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));
}
async function remember() {
  try { await queue.writeCaptureSettings(settings); }
  catch { destinationMessage = "授業の設定を記憶できません。この画面では選択できます。"; }
}
async function readFolders(className) {
  const current = ++listing;
  const controller = new AbortController();
  controllers.add(controller);
  folderLoading = true;
  destinationMessage = "ドライブの回一覧を確認しています。";
  render();
  try {
    const files = await folders.listSessionFolders(className, { signal: controller.signal });
    if (current !== listing) return;
    settings.lessons = settings.lessons.filter((lesson) => lesson.className !== className);
    settings.lessons.push({ className, names: files.map((file) => file.name) });
    if (!settings.classes.includes(className)) settings.classes.push(className);
    pending = await queue.pendingDestinations();
    destinationMessage = "";
    showClasses();
    await remember();
  } catch (error) {
    if (current === listing) destinationMessage = namesFor(className) !== null
      ? "一覧を再取得できませんでした。端末内の確認済み一覧を使います。"
      : error instanceof DriveFolderError && error.reason === "ambiguous"
        ? "同名フォルダが複数あります。Driveで整理してから一覧を再取得してください。"
        : "保存先を確認できませんでした。Googleログインと通信を確認して一覧を再取得してください。";
  } finally {
    controllers.delete(controller);
    if (current === listing) { folderLoading = false; render(); }
  }
}
async function refreshClasses() {
  if (!queue || document.hidden || navigator.onLine === false || session.snapshot().status !== "valid") return;
  const controller = new AbortController();
  controllers.add(controller);
  folderLoading = true;
  render();
  try {
    const classes = await folders.listClasses({ signal: controller.signal });
    settings.classes = [...new Set([...settings.classes, ...classes.map((file) => file.name)])];
    showClasses();
    await remember();
  } catch { authMessage = "ログインしましたが授業一覧を取得できません。通信・保存先を確認してください。"; }
  finally { controllers.delete(controller); folderLoading = false; render(); }
  if (settings.selectedClass && !document.hidden) await readFolders(settings.selectedClass);
}
function authorize() {
  if (!libraryReady || authorizing || saving || folderLoading || cameraIsNavigating()) return;
  authorizing = true;
  const current = ++loginAttempt;
  authMessage = "Googleの画面で操作してください。戻らない場合はログイン待ちを中断できます。";
  render();
  const failed = () => {
    if (current !== loginAttempt) return;
    authorizing = false;
    authMessage = "Googleログインが完了しませんでした。テストユーザーで再試行してください。";
    render();
  };
  try {
    const client = window.google.accounts.oauth2.initTokenClient(tokenClientOptions(config.googleClientId, (response) => {
      if (current !== loginAttempt || !authorizing) return;
      authorizing = false;
      try { session.accept(response); }
      catch { failed(); return; }
      authMessage = "";
      render();
      void queue.resumeAfterAuthentication().catch(() => { storedMessage = "送信を再開できません。端末内の画像は残っています。"; render(); });
      void refreshClasses();
    }, failed));
    client.requestAccessToken({ prompt: session.snapshot().status === "valid" ? "select_account" : "" });
  } catch { failed(); }
}
$("google-login").addEventListener("click", authorize);
$("destination-status").addEventListener("click", () => { $("save-options").open = !$("save-options").open; render(); });
$("save-options").addEventListener("toggle", () => { $("destination-status").setAttribute("aria-expanded", String($("save-options").open)); });
$("cancel-login").addEventListener("click", () => {
  loginAttempt += 1;
  authorizing = false;
  authMessage = "ログイン待ちを中断しました。開いているGoogleの画面を閉じてから再試行してください。";
  render();
});
$("apply-class").addEventListener("click", async () => {
  try { settings.selectedClass = classFolderName($("class-name").value); }
  catch { destinationMessage = "授業名は空白だけ・前後の空白・区切り文字を含めず入力してください。"; render(); return; }
  $("session-number").value = "";
  destinationMessage = "";
  render();
  if (session.snapshot().status === "valid" && navigator.onLine !== false) await readFolders(settings.selectedClass);
  await remember();
  render();
});
$("session-number").addEventListener("input", () => {
  destinationMessage = "";
  try { selection(); }
  catch (error) { destinationMessage = error instanceof FolderNameError ? error.message : "授業の保存先をオンラインで確認してください。"; }
  render();
});
$("refresh-folders").addEventListener("click", () => { void refreshClasses(); });
$("retry-upload").addEventListener("click", () => {
  storedMessage = "";
  if (session.snapshot().status === "valid" && queueState.status === "authentication-required") {
    void queue.resumeAfterAuthentication().catch(() => { storedMessage = "送信を再開できません。"; render(); });
  } else void queue.retry();
});
document.addEventListener("bansho-captured", (event) => {
  try {
    captured = selection(event.detail.capturedAt);
    $("image-destination").textContent = `保存先：板書／${captured.className}／${captured.sessionFolderName}`;
    $("save-status").textContent = "確認したら保存してください。保存先は撮影時の授業と回です。";
  } catch { captured = null; $("save-status").textContent = "保存先を確認できません。撮り直して授業と回を選択してください。"; }
  render();
});
$("back").addEventListener("click", () => { captured = null; render(); });
$("save-image").addEventListener("click", async () => {
  if (saving || !captured || !queue || cameraIsNavigating()) return;
  saving = true;
  $("save-status").textContent = "撮影画像を端末内に保存しています。";
  render();
  try {
    await saveCapturedImage({ canvas: $("image"), destination: captured, enqueue: (item) => queue.enqueue(item) });
    pending.push({ className: captured.className, sessionFolderName: captured.sessionFolderName });
    captured = null;
    storedMessage = "端末内に保存しました。ドライブへは前面で順に送ります。";
    saving = false;
    $("save-options").open = false;
    render();
    returnToCamera();
  } catch {
    $("save-status").textContent = "端末内に保存できませんでした。画像を残しています。空き容量を確認し、再試行してください。";
  } finally { saving = false; render(); }
});

async function initialize() {
  setCaptureBlocked(true);
  setCaptureOperationActive(true);
  try {
    queue = await createUploadQueue({ upload: async (item, context) => {
      const controller = new AbortController();
      controllers.add(controller);
      try { return await upload(item, { ...context, signal: controller.signal }); }
      finally { controllers.delete(controller); }
    } });
    settings = await queue.readCaptureSettings();
    pending = await queue.pendingDestinations();
    $("class-name").value = settings.selectedClass;
    showClasses();
    queue.subscribe((state) => {
      if (queueState.pendingCount !== null && state.pendingCount !== null && state.pendingCount < queueState.pendingCount) {
        storedMessage = "ドライブへの保存が完了しました。";
      }
      queueState = state;
      render();
    });
  } catch { storedMessage = "端末内保存を準備できません。空き容量やブラウザの設定を確認して開き直してください。"; }
  initializing = false;
  render();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { controllers.forEach((controller) => controller.abort()); listing += 1; folderLoading = false; }
  else render();
});
window.addEventListener("pagehide", () => {
  controllers.forEach((controller) => controller.abort());
  session.clear();
  loginAttempt += 1;
  authorizing = false;
  listing += 1;
  folderLoading = false;
  render();
});
window.addEventListener("pageshow", () => { render(); });
window.setInterval(() => { if (!document.hidden) render(); }, 1000);
void initialize();

if (config.googleClientId) {
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.addEventListener("load", () => { libraryReady = typeof window.google?.accounts?.oauth2?.initTokenClient === "function"; render(); });
  script.addEventListener("error", () => { authMessage = "Googleログインを読み込めません。通信を確認してください。"; render(); });
  document.head.append(script);
} else { authMessage = "GoogleクライアントIDが未設定です。"; render(); }
