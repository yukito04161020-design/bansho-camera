import { createUpdateChecker } from "./update-policy.js";

// 送信待ち機能の実装時は、起動前にIndexedDBの件数を読む関数を登録してください。
// 取得失敗時はthrowまたは不明な値を返すと、自動切り替えを保留します。
let pendingUploadCounter = async () => 0;
export function registerPendingUploadCounter(counter) {
  pendingUploadCounter = counter;
}

export function readPendingUploadCount() {
  return pendingUploadCounter();
}

export function initializeUpdates(getActivity = () => ({ cameraActive: false, imagePreview: false })) {
  const currentVersion = document.querySelector('meta[name="app-version"]')?.content || "development";
  const notices = document.querySelectorAll("[data-update-status]");
  let navigating = false;
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
      return version;
    },
    readPendingUploads: readPendingUploadCount,
    getActivity: () => ({ ...getActivity(), pageVisible: !document.hidden }),
    applyUpdate: (version) => {
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
    },
  });
  async function checkAtStartup() {
    if (currentVersion === "development" || document.hidden) return;
    const result = await check();
    const message = {
      deferred: "新しい版があります。撮影・画像確認・送信待ちが終わった後、次に開いたときに切り替わります。",
      unavailable: "更新を確認できませんでした。現在の版で続けられます。",
    }[result] || "";
    if (result !== "busy") notices.forEach((notice) => { notice.textContent = message; });
  }
  // Safariのホーム画面起動が前の文書の復帰になる場合も確認する。
  window.addEventListener("pageshow", (event) => { if (event.persisted) void checkAtStartup(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void checkAtStartup(); });
  void checkAtStartup();
  return { isNavigating: () => navigating };
}
