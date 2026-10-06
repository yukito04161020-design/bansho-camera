import { bindLiveOutline } from "./live-outline.js";
const $ = id => document.getElementById(id);
let toastTimer;
export function showToast(text) {
  if (!text) return;
  const toast = $("image-screen").hidden ? $("toast") : $("review-toast");
  $("toast").hidden = true; $("review-toast").hidden = true;
  toast.textContent = text; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}
export function showSettingsPage(id) {
  document.querySelectorAll("[data-settings-detail]").forEach(node => { node.hidden = node.id !== id; });
  $("settings-menu").hidden = Boolean(id); $("settings-back").hidden = !id;
  $("options-title").textContent = id ? { "save-options": "授業と保存先", "account-options": "Googleアカウント", "camera-options": "撮影", "app-options": "アプリ", "timetable-panel": "時間割", "transfer-options": "送信の状態" }[id] : "設定";
}
export function zoomStops(min, max) {
  if (!(max > min)) return [min];
  const values = [.5, 1, 2, 3, 5].filter(v => v >= min && v <= max);
  if (values.length < 2) return [min, max];
  return values;
}
export function initializeCameraUi() {
  document.querySelectorAll("[data-settings-page]").forEach(button => button.addEventListener("click", () => showSettingsPage(button.dataset.settingsPage)));
  $("settings-back").addEventListener("click", () => showSettingsPage(null));
  $("open-timetable").addEventListener("click", () => showSettingsPage("timetable-panel"));
  $("close-timetable").addEventListener("click", () => showSettingsPage(null));
  $("image-info").addEventListener("click", () => { $("image-info-panel").hidden = !$("image-info-panel").hidden; $("image-info").setAttribute("aria-expanded", String(!$("image-info-panel").hidden)); });
  $("last-image").addEventListener("click", () => { showSettingsPage("transfer-options"); $("options-panel").showModal(); });
  const zoom = $("zoom"), group = $("zoom-buttons");
  let signature = "", hold, origin;
  function renderZoom() {
    const key = `${zoom.min}:${zoom.max}`;
    if (key !== signature) {
      signature = key;
      group.replaceChildren(...zoomStops(Number(zoom.min), Number(zoom.max)).map(value => {
        const button = document.createElement("button"); button.type = "button"; button.dataset.zoom = value;
        button.textContent = `${value}×`; button.setAttribute("aria-label", `倍率を${value}倍にする`);
        button.addEventListener("click", () => { zoom.value = value; zoom.dispatchEvent(new Event("input", { bubbles: true })); });
        return button;
      }));
    }
    for (const button of group.children) { button.disabled = zoom.disabled; button.setAttribute("aria-pressed", String(Math.abs(Number(button.dataset.zoom) - Number(zoom.value)) < .05)); }
    $("camera-start").hidden = $("camera").readyState >= 2 && !$("camera").paused;
  }
  group.addEventListener("pointerdown", event => { origin = event.clientX; hold = setTimeout(() => { zoom.hidden = false; }, 450); });
  group.addEventListener("pointermove", event => { if (origin !== undefined && Math.abs(event.clientX - origin) > 12) zoom.hidden = false; });
  for (const event of ["pointerup", "pointercancel"]) group.addEventListener(event, () => { clearTimeout(hold); origin = undefined; });
  zoom.addEventListener("change", () => { setTimeout(() => { zoom.hidden = true; }, 2000); });
  window.setInterval(renderZoom, 150); renderZoom();
  for (const id of ["status", "crop-status", "save-status"]) new MutationObserver(() => showToast($(id).textContent)).observe($(id), { childList: true, subtree: true, characterData: true });
  new MutationObserver(() => { $("update-dot").hidden = !document.querySelector("[data-update-status]").textContent.includes("新しい版"); }).observe(document.querySelector("[data-update-status]"), { childList: true });
  bindLiveOutline({ video: $("camera"), screen: $("camera-screen"), overlay: $("live-outline"), toggle: $("overlay-enabled") });
}
