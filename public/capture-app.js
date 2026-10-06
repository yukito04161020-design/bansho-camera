import { selectLesson, manualLesson } from "./timetable-logic.js";
import { createTimetableSync } from "./timetable-sync.js";
import { createDriveTimetable } from "./drive-timetable.js";
import { createTimetableEditor } from "./timetable-editor.js";
import { config } from "./config.js";
import { TokenSession, tokenClientOptions } from "./login-logic.js";
import { classFolderName, FolderNameError, japanDate } from "./folder-logic.js";
import { captureDestination, captureSettings, saveCapturedImage, createCapturedDraft } from "./capture-save.js";
import { createDriveFolders, DriveFolderError } from "./drive-folders.js";
import { createDriveUpload } from "./drive-upload.js";
import { createUploadQueue } from "./upload-queue.js";
import { returnToCamera, setCaptureBlocked, setCaptureOperationActive, cameraIsNavigating } from "./camera-preview.js";
import { initializeCameraUi, showSettingsPage, showToast } from "./camera-ui.js";
import { prepareReviewSave } from "./review-save.js";
import { createCropEditor } from "./crop-editor.js";

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
let timetable = null;
let timetableSync;
let timetableBusy = false;
let timetableController;
let manualSelection = null;
let automaticKey;
const timetableEditor = createTimetableEditor({ save: (entries) => updateTimetable(entries) });
const crop = createCropEditor({ onChange: render });
initializeCameraUi();

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
// 判定が変わったときだけ選択を更新し、時間割外の手動選択を毎秒消さない。
function applyTimetable(capturedAt = Date.now(), force = false) {
  if (!queue || initializing || captured || saving) return;
  const result = selectLesson(timetable?.entries || [], capturedAt, manualSelection);
  const key = `${japanDate(capturedAt)}:${result.lesson?.key || "未判定"}:${result.className}`;
  if (!force && key === automaticKey) return;
  automaticKey = key;
  if (!result.manual) manualSelection = null;
  if (settings.selectedClass === result.className) return;
  settings.selectedClass = result.className;
  $("class-name").value = result.className;
  $("session-number").value = "";
  destinationMessage = "";
  if (result.className && !settings.classes.includes(result.className)) settings.classes.push(result.className);
  showClasses();
  void remember();
  if (result.className && session.snapshot().status === "valid" && navigator.onLine !== false && !document.hidden) {
    void readFolders(result.className);
  }
}
async function updateTimetable(entries) {
  if (!timetableSync || timetableBusy) return false;
  timetableBusy = true;
  timetableEditor.setBusy(true);
  render();
  timetableController = new AbortController();
  controllers.add(timetableController);
  let success = false;
  try {
    timetable = entries === undefined ? await timetableSync.load() : await timetableSync.save(entries);
    success = true;
    $("timetable-status").textContent = session.snapshot().status === "valid" && navigator.onLine !== false && !document.hidden
      ? "時間割をドライブと同期しました。" : "端末内の時間割を使います。次のログイン・通信復帰時に同期します。";
  } catch {
    try { timetable = await queue.readTimetable(); success = entries !== undefined
      && JSON.stringify(timetable?.entries) === JSON.stringify(entries); }
    catch { success = false; }
    $("timetable-status").textContent = "時間割を同期できません。端末内の内容を保持しています。Googleログインと通信を確認してください。";
  } finally {
    controllers.delete(timetableController);
    timetableBusy = false;
    timetableEditor.setRecord(timetable);
    timetableEditor.setBusy(false);
    applyTimetable();
    render();
  }
  return success;
}
function render() {
  const token = session.snapshot();
  crop.setLocked(saving);
  $("actual-size").disabled = saving || crop.busy;
  setCaptureOperationActive(initializing || saving || crop.busy || authorizing || folderLoading || timetableBusy || token.status === "valid");
  let destination = null;
  try { destination = selection(captured?.capturedAt); } catch { /* 未確認や入力不正は撮影前に案内する。 */ }
  const chip = destination ? `${destination.className}・${destination.sessionFolderName.split("_")[0]} ▾` : "授業を選ぶ ▾";
  $("destination-status").textContent = chip + (!manualSelection && selectLesson(timetable?.entries || [], Date.now()).className === settings.selectedClass && settings.selectedClass ? " 自動" : "");
  $("destination-status").classList.toggle("unselected", !destination);
  $("review-options").textContent = captured?.resolve() ? `${captured.destination.className}・${captured.destination.sessionFolderName.split("_")[0]} ▾` : chip;
  $("login-warning").hidden = token.status === "valid";
  $("login-icon").setAttribute("aria-label", token.status === "valid" ? "ログイン済み、Googleアカウントを選び直す" : "未ログイン、Googleにログイン");
  $("destination-message").textContent = destinationMessage || (!destination ? "授業を選び、初回はオンラインで保存先を確認してください。" : `${destination.className}／${destination.sessionFolderName}`);
  $("settings-destination").textContent = destination ? `${destination.className}・${destination.sessionFolderName.split("_")[0]}` : "未選択";
  $("settings-account").textContent = token.status === "valid" ? "ログイン済み" : "未ログイン";
  $("settings-timetable").textContent = `${timetable?.entries.length || 0}コマ`;
  $("settings-camera").textContent = $("camera-name").textContent.replace(/^カメラ：/, "");
  $("settings-app").textContent = $("update-dot").hidden ? "版・更新" : "更新あり";
  $("queue-badge").textContent = queueState.pendingCount ?? "?";
  $("queue-icon").dataset.state = queueState.status;
  $("queue-icon").dataset.failed = String(Boolean(queueState.reason));
  $("queue-icon").dataset.empty = String(queueState.pendingCount === 0);
  $("thumbnail-pending").hidden = !queueState.pendingCount;
  setCaptureBlocked(initializing ? "端末内保存を準備しています。" : saving ? "画像を保存しています。" : false);
  $("destination-status").setAttribute("aria-expanded", String($("options-panel").open));
  const locked = initializing || saving || authorizing || folderLoading || timetableBusy;
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
  const fixed = captured?.resolve();
  $("save-image").disabled = saving || !captured || !queue || !crop.ready;
  if (captured) {
    $("image-destination").textContent = fixed
      ? `保存先：板書／${fixed.className}／${fixed.sessionFolderName}`
      : "保存前に「授業と保存先を選ぶ」から授業を選び、回を確認してください。画像は残っています。";
  }
  $("back").disabled = saving || crop.busy;
  $("review-options").disabled = saving || crop.busy;
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
      void updateTimetable();
      void refreshClasses();
    }, failed));
    client.requestAccessToken({ prompt: session.snapshot().status === "valid" ? "select_account" : "" });
  } catch { failed(); }
}
$("google-login").addEventListener("click", authorize);
function openOptions() {
  showSettingsPage("save-options");
  $("options-panel").showModal();
  render();
}
for (const id of ["destination-status", "review-options"]) $(id).addEventListener("click", openOptions);
$("open-options").addEventListener("click", () => { showSettingsPage(null); $("options-panel").showModal(); });
$("login-icon").addEventListener("click", authorize);
$("queue-icon").addEventListener("click", () => { showSettingsPage("transfer-options"); $("options-panel").showModal(); });
$("close-options").addEventListener("click", () => { $("options-panel").close(); });
$("options-panel").addEventListener("close", render);
$("cancel-login").addEventListener("click", () => {
  loginAttempt += 1;
  authorizing = false;
  authMessage = "ログイン待ちを中断しました。開いているGoogleの画面を閉じてから再試行してください。";
  render();
});
$("apply-class").addEventListener("click", async () => {
  try { settings.selectedClass = classFolderName($("class-name").value); }
  catch { destinationMessage = "授業名は空白だけ・前後の空白・区切り文字を含めず入力してください。"; render(); return; }
  destinationMessage = "";
  manualSelection = manualLesson(timetable?.entries || [], captured?.capturedAt || Date.now(), settings.selectedClass);
  try { await queue.writeManualLesson(manualSelection); }
  catch { destinationMessage = "手動選択を記憶できません。この画面では選択できます。"; }
  $("session-number").value = "";
  captured?.reselect();
  render();
  if (session.snapshot().status === "valid" && navigator.onLine !== false) await readFolders(settings.selectedClass);
  await remember();
  captured?.reselect();
  render();
});
$("session-number").addEventListener("input", () => {
  captured?.reselect();
  destinationMessage = "";
  try { selection(captured?.capturedAt); }
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
  applyTimetable(event.detail.capturedAt);
  captured = createCapturedDraft(event.detail.capturedAt, selection);
  $("save-status").textContent = "補正画像と保存先を確認して保存してください。";
  $("image-info-panel").hidden = true;
  $("image-info").setAttribute("aria-expanded", "false");
  crop.begin($("image"));
  render();
});
$("back").addEventListener("click", () => { captured = null; crop.clear(); render(); });
$("save-image").addEventListener("click", async () => {
  if (saving || !captured || !queue || !crop.ready || cameraIsNavigating()) return;
  if (!captured.resolve()) { openOptions(); return; }
  saving = true;
  $("save-image").classList.add("busy");
  $("save-status").textContent = "撮影画像を端末内に保存しています。";
  render();
  try {
    const corrected = await prepareReviewSave({ draft: captured, crop, selectDestination: openOptions });
    if (!corrected || document.hidden) return;
    await saveCapturedImage({ canvas: corrected, destination: captured.destination, enqueue: (item) => queue.enqueue(item) });
    pending.push({ className: captured.destination.className, sessionFolderName: captured.destination.sessionFolderName });
    const thumb = $("thumbnail");
    thumb.getContext("2d").drawImage(corrected, 0, 0, 64, 64);
    $("last-image").disabled = false;
    captured = null;
    crop.clear();
    storedMessage = "端末内に保存しました。ドライブへは前面で順に送ります。";
    saving = false;
    $("options-panel").close();
    render();
    returnToCamera();
    showToast("保存しました");
  } catch {
    $("save-status").textContent = "端末内に保存できませんでした。画像を残しています。空き容量を確認し、再試行してください。";
  } finally { saving = false; $("save-image").classList.remove("busy"); render(); }
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
    timetableSync = createTimetableSync({ store: queue,
      drive: createDriveTimetable({ session, folders, signal: () => timetableController?.signal }),
      canSync: () => !document.hidden && navigator.onLine !== false && session.snapshot().status === "valid" });
    timetable = await queue.readTimetable();
    manualSelection = await queue.readManualLesson();
    timetableEditor.setRecord(timetable);
    timetableEditor.setBusy(false);
    $("timetable-status").textContent = "端末内の時間割を使います。ログイン後にドライブと同期します。";
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
  applyTimetable(Date.now(), true);
  render();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { controllers.forEach((controller) => controller.abort()); listing += 1; folderLoading = false; }
  else { applyTimetable(); render(); void updateTimetable(); }
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
window.addEventListener("pageshow", () => { applyTimetable(); render(); void updateTimetable(); });
window.addEventListener("online", () => { void updateTimetable(); });
window.setInterval(() => { if (!document.hidden) { applyTimetable(); render(); } }, 1000);
void initialize();

if (config.googleClientId) {
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.addEventListener("load", () => { libraryReady = typeof window.google?.accounts?.oauth2?.initTokenClient === "function"; render(); });
  script.addEventListener("error", () => { authMessage = "Googleログインを読み込めません。通信を確認してください。"; render(); });
  document.head.append(script);
} else { authMessage = "GoogleクライアントIDが未設定です。"; render(); }
