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
