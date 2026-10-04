import { classFolderName, chooseSessionFolder } from "./folder-logic.js";

export function captureDestination({ className, existingNames, capturedAt, manualSession }) {
  const name = classFolderName(className);
  const sessionFolderName = chooseSessionFolder(existingNames, capturedAt, manualSession);
  return { className: name, sessionFolderName, capturedAt: new Date(capturedAt).getTime() };
}

export function captureSettings(input = {}) {
  const classes = [...new Set((input.classes || []).map(classFolderName))];
  const lessons = (input.lessons || []).map((lesson) => ({
    className: classFolderName(lesson.className),
    names: [...new Set(lesson.names.map((name) => {
      if (typeof name !== "string") throw new TypeError("回一覧を確認できません。");
      return name;
    }))],
  }));
  const selectedClass = input.selectedClass ? classFolderName(input.selectedClass) : "";
  // 認証情報や任意の入力フィールドは複製しない。
  return { classes, lessons, selectedClass };
}

export async function saveCapturedImage({ canvas, destination, enqueue }) {
  if (!destination?.className || !destination?.sessionFolderName) {
    throw new Error("保存前に授業を選び、回と保存先を確認してください。画像は残っています。");
  }
  const fixed = { className: destination.className, sessionFolderName: destination.sessionFolderName,
    capturedAt: destination.capturedAt };
  if (!canvas?.width || !canvas?.height || typeof enqueue !== "function") {
    throw new Error("保存する撮影画像を確認できません。");
  }
  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((value) => {
        if (!(value instanceof Blob) || value.size === 0 || value.type !== "image/jpeg") {
          reject(new Error("撮影画像をJPEGに変換できませんでした。"));
        } else resolve(value);
      }, "image/jpeg", 0.95);
    } catch { reject(new Error("撮影画像をJPEGに変換できませんでした。")); }
  });
  // enqueueがIndexedDBの保存完了を確認してから戻る。送信完了は待たない。
  return enqueue({ ...fixed, blob });
}

// 撮影日時を保持し、未確定の宛先だけを確認画面で決める。
export function createCapturedDraft(capturedAt, resolveDestination) {
  let destination = null;
  const draft = { capturedAt, get destination() { return destination; },
    resolve() {
      if (!destination) {
        try { destination = resolveDestination(capturedAt); } catch { /* 選択を待つ。 */ }
      }
      return destination;
    } };
  draft.resolve();
  return draft;
}

export function captureDisabledReason({ starting, hidden, ready, zoomApplying, blocked }) {
  if (blocked) return typeof blocked === "string" ? blocked : "撮影の準備中です。しばらくお待ちください。";
  if (hidden) return "画面に戻ってカメラを開始してください。";
  if (starting) return "カメラを準備しています。しばらくお待ちください。";
  if (!ready) return "カメラを開始し、映像が動くまでお待ちください。";
  if (zoomApplying) return "倍率を変更しています。反映後に撮影できます。";
  return "";
}
