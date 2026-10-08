// 送信待ちとは独立して、直前の補正後JPEGだけをメモリに保持する。
export function createPhotoShare({ navigator = globalThis.navigator, File = globalThis.File,
  URL = globalThis.URL, open = (...args) => globalThis.open(...args), notify, prompt,
  storage }) {
  let file = null, url = null;
  let enabled = true;
  try { storage ??= globalThis.localStorage; enabled = storage.getItem("bansho-camera.photos") !== "off"; } catch {}
  function clear() { file = null; if (url) URL.revokeObjectURL(url); url = null; }
  return {
    enabled: () => enabled,
    setEnabled(value) { enabled = Boolean(value); try { storage.setItem("bansho-camera.photos", enabled ? "on" : "off"); } catch {} },
    clear,
    saved(blob) {
      clear();
      file = new File([blob], "板書.jpg", { type: "image/jpeg" });
      url = URL.createObjectURL(file);
      if (enabled) prompt("保存しました", () => this.share());
    },
    async share() {
      if (!file) return;
      const data = { files: [file] };
      try {
        if (typeof navigator.share === "function" && navigator.canShare?.(data)) {
          await navigator.share(data);
        } else {
          open(url, "_blank", "noopener");
          notify("長押しして写真に追加してください");
        }
      } catch (error) {
        if (error.name !== "AbortError") notify("写真への保存を開けません。再試行してください");
      }
    },
  };
}
