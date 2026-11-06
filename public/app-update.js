import { canApplyManually, createUpdateChecker } from "./update-policy.js";
import { openUploadStore } from "./upload-store.js";

// 送信待ち機能の実装時は、起動前にIndexedDBの件数を読む関数を登録してください。
// 取得失敗時はthrowまたは不明な値を返すと、自動切り替えを保留します。
let pendingUploadCounter = async () => {
  const store = await openUploadStore();
  try { return await store.count(); }
  finally { store.close(); }
};
export function registerPendingUploadCounter(counter) {
  pendingUploadCounter = counter;
}

export function readPendingUploadCount() {
  return pendingUploadCounter();
}

export function initializeUpdates(getActivity = () => ({ cameraActive: false, imagePreview: false, operationBusy: false })) {
  const currentVersion = document.querySelector('meta[name="app-version"]')?.content || "development";
  const notices = document.querySelectorAll("[data-update-status]");
  const buttons = document.querySelectorAll("[data-update-apply]");
  const show = (message) => { notices.forEach((notice) => { notice.textContent = message; }); };
  let navigating = false;
  let latestVersion = null;
  let waitingVersion = null;
  function reload(version) {
    const url = new URL(location.href);
    // 配信の反映待ちで同じ古いHTMLが返っても、無限に再読み込みしない。
    const lastReload = Number.parseInt(url.searchParams.get("reload"), 10);
    if (url.searchParams.get("app-version") === version && Date.now() - lastReload < 30000) {
      throw new Error("公開の反映待ちです。");
    }
    url.searchParams.set("app-version", version);
    url.searchParams.set("reload", `${Date.now()}-${Math.random()}`);
    location.replace(url.href);
    navigating = true;
  }
  const check = createUpdateChecker({
    currentVersion,
    readLatestVersion: async () => {
      // no-storeと毎回異なるURLで、HTTPキャッシュに残った版情報を避ける。
      const url = new URL("./version.json", location.href);
      url.searchParams.set("check", `${Date.now()}-${Math.random()}`);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("版情報を取得できません。");
      const { version } = await response.json();
      if (version !== "development" && !/^[a-f0-9]{40}$/.test(version)) throw new Error("版情報が不正です。");
      latestVersion = version;
      return version;
    },
    readPendingUploads: readPendingUploadCount,
    getActivity: () => ({ ...getActivity(), pageVisible: !document.hidden }),
    applyUpdate: reload,
  });
  async function checkAtStartup() {
    if (currentVersion === "development" || document.hidden) return;
    const result = await check();
    if (result === "busy") return;
    waitingVersion = result === "deferred" ? latestVersion : null;
    buttons.forEach((button) => { button.hidden = !waitingVersion; });
    show({
      deferred: "新しい版があります。「新しい版に切り替える」を押すと切り替わります。送信待ちの画像は端末内に残り、切り替えた後はGoogleに再ログインしてください。押さない場合は、撮影・画像確認・送信待ちが終わった後に切り替わります。",
      unavailable: "更新を確認できませんでした。現在の版で続けられます。",
    }[result] || "");
  }
  // 送信待ちが送れないままでも新しい版にできるよう、利用者が押したときだけ送信待ちがあっても切り替える。
  buttons.forEach((button) => button.addEventListener("click", () => {
    if (!waitingVersion || navigating) return;
    if (!canApplyManually({ ...getActivity(), pageVisible: !document.hidden })) {
      show("新しい版への切り替えは、撮影画像の確認や保存が終わってから押してください。");
      return;
    }
    try { reload(waitingVersion); }
    catch { show("公開の反映待ちです。新しい版へは、少し待ってからもう一度押すと切り替わります。"); }
  }));
  // Safariのホーム画面起動が前の文書の復帰になる場合も確認する。
  window.addEventListener("pageshow", (event) => { if (event.persisted) void checkAtStartup(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void checkAtStartup(); });
  void checkAtStartup();
  return { isNavigating: () => navigating };
}
