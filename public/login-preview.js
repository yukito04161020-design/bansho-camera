import { config } from "./config.js";
import { initializeUpdates } from "./app-update.js";
import { createTestText, TokenSession, tokenClientOptions } from "./login-logic.js";

const login = document.querySelector("#login");
const renew = document.querySelector("#renew");
const create = document.querySelector("#create-text");
const cancel = document.querySelector("#cancel-login");
const status = document.querySelector("#status");
const fileStatus = document.querySelector("#file-status");
const fileLink = document.querySelector("#file-link");
const session = new TokenSession();
let libraryReady = false;
let authorizing = false;
let uploading = false;
let deferredCreate = false;
let attempt = 0;
let uploadController = null;
const updates = initializeUpdates(() => ({
  cameraActive: false,
  imagePreview: false,
  operationActive: authorizing || uploading || deferredCreate || session.snapshot().status === "valid",
}));

const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const messages = {
  authorization: "Googleログインが完了しませんでした。テストユーザーのアカウントで再試行してください。",
  scope: "drive.fileだけの許可を確認できませんでした。Googleの許可内容を確認して再試行してください。",
  response: "トークンの有効期限を確認できませんでした。再度ログインしてください。",
  expired: "トークンを使えません。「トークンの取り直しを試す」を押してください。",
  forbidden: "ドライブへの作成が許可されませんでした。Drive APIの有効化とテストユーザー・権限の設定を確認してください。",
  network: "作成結果を確認できませんでした。ドライブにファイルがあるか確認してから再試行してください。",
  upload: "作成の成功を確認できませんでした。ドライブを確認してから再試行してください。",
};

function render() {
  const state = session.snapshot();
  document.querySelector("#token-state").textContent = {
    empty: "未取得", valid: "有効", expired: "期限切れ", invalid: "ドライブで拒否されました（取り直しが必要）",
  }[state.status];
  document.querySelector("#received-at").textContent = state.receivedAt === null ? "未取得" : timeFormat.format(state.receivedAt);
  document.querySelector("#expires-at").textContent = state.expiresAt === null ? "未取得" : timeFormat.format(state.expiresAt);
  document.querySelector("#remaining").textContent = state.receivedAt === null ? "未取得"
    : state.status === "invalid" ? "利用できません" : `${state.remainingSeconds} 秒`;
  login.disabled = !libraryReady || authorizing || uploading;
  renew.disabled = !libraryReady || authorizing || uploading || state.receivedAt === null;
  create.disabled = authorizing || uploading || state.status !== "valid";
  cancel.hidden = !authorizing;
}

async function createText() {
  if (authorizing || uploading || updates.isNavigating()) return;
  if (document.hidden) { deferredCreate = true; return; }
  deferredCreate = false;
  const current = attempt;
  const controller = new AbortController();
  uploadController = controller;
  uploading = true;
  fileLink.hidden = true;
  fileLink.removeAttribute("href");
  fileStatus.textContent = "テキストをドライブに作成しています。";
  render();
  try {
    const file = await createTestText(session, fetch, { signal: controller.signal });
    if (current !== attempt) return;
    fileStatus.textContent = `作成成功：${file.name}`;
    fileLink.href = `https://drive.google.com/file/d/${file.id}/view`;
    fileLink.hidden = false;
  } catch (error) {
    if (current === attempt) fileStatus.textContent = messages[error.reason] || messages.upload;
  } finally {
    if (current === attempt) {
      uploading = false;
      uploadController = null;
      render();
    }
  }
}

function authorize(retry) {
  if (!libraryReady || authorizing || uploading || updates.isNavigating()) return;
  authorizing = true;
  const current = ++attempt;
  status.textContent = "Googleの画面で操作してください。戻らない場合は、Googleの画面を閉じて「ログイン待ちを中断する」を押してください。";
  render();
  const onError = (error) => {
    if (current !== attempt || !authorizing) return;
    authorizing = false;
    status.textContent = error?.type === "popup_closed" ? "Googleの画面が閉じられました。再試行できます。"
      : error?.type === "popup_failed_to_open" ? "Googleの画面を開けませんでした。Safariのポップアップ設定を確認して再試行してください。"
        : "Googleの画面から応答を受け取れませんでした。再試行してください。";
    render();
  };
  try {
    const client = window.google.accounts.oauth2.initTokenClient(tokenClientOptions(config.googleClientId, (response) => {
      if (current !== attempt || !authorizing) return;
      authorizing = false;
      try {
        session.accept(response);
        status.textContent = retry ? "トークンを取り直しました。必要だった操作を記録し、テキスト作成を試してください。"
          : "Googleログインが完了しました。検証用のテキストを作成します。";
        if (!retry) void createText();
      } catch (error) {
        status.textContent = messages[error.reason] || messages.response;
      }
      render();
    }, onError));
    // ボタンの操作と同じ呼び出し内で要求し、ポップアップを開くユーザー操作を維持します。
    client.requestAccessToken({ prompt: retry ? "" : "select_account" });
  } catch { onError(); }
}

login.addEventListener("click", () => authorize(false));
renew.addEventListener("click", () => authorize(true));
create.addEventListener("click", () => { void createText(); });
cancel.addEventListener("click", () => {
  attempt += 1;
  authorizing = false;
  status.textContent = "ログイン待ちを中断しました。開いているGoogleの画面を閉じてから再試行してください。";
  render();
});
document.querySelector("#launch-mode").textContent = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone
  ? "起動方法：ホーム画面（全画面）" : "起動方法：ブラウザ（全画面での結果はホーム画面から確認してください）";

// 裏にいる間のタイマーに依存せず、戻った時点の実時刻で期限を判定します。
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    render();
    if (deferredCreate) void createText();
  }
});
window.addEventListener("pagehide", () => {
  attempt += 1;
  session.clear();
  uploadController?.abort();
  uploadController = null;
  authorizing = false;
  uploading = false;
  deferredCreate = false;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    status.textContent = "画面を開き直したため、トークンは未取得です。Googleログインを試してください。";
    render();
  }
});
window.setInterval(() => { if (!document.hidden) render(); }, 1000);

if (!config.googleClientId) {
  status.textContent = "GoogleクライアントIDが未設定です。設定後に開き直してください。";
} else {
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.addEventListener("load", () => {
    libraryReady = typeof window.google?.accounts?.oauth2?.initTokenClient === "function";
    status.textContent = libraryReady ? "「Googleでログインして検証する」を押してください。"
      : "Googleのログイン機能を利用できません。通信を確認して開き直してください。";
    render();
  });
  script.addEventListener("error", () => {
    status.textContent = "Googleのログイン機能を読み込めませんでした。通信を確認して開き直してください。";
  });
  document.head.append(script);
}
render();
