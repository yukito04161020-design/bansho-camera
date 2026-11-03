// 送信待ちの状態を、撮影画面の短い表示と設定シートの説明文にまとめる。画面操作とは分けてテストする。
const kept = "画像は端末内に残っています。";
export const reasonMessages = Object.freeze({
  authentication: `Googleログインを取り直すと再開します。${kept}`,
  permission: `Driveへのアクセスが拒否されました。Drive APIの有効化とログイン中のアカウントを確認してください。${kept}`,
  "duplicate-folder": `保存先に同名フォルダが複数あります。Driveで整理すると再送できます。${kept}`,
  folder: `Driveの保存先フォルダを確認できませんでした。時間をおいて再送してください。${kept}`,
  network: `通信の復帰後、前面で再送します。${kept}`,
  server: `時間をおいて再送します。${kept}`,
  timeout: `Driveから応答がないため送信を中断しました。自動で再送します。${kept}`,
  unreadable: "端末内の画像を読み込めません。消さずに残しています。「送信を再開する」で読み直すか、「送信待ちの画像を写真に保存」を試してください。",
  upload: "送信完了を確認できません。画像を残して再試行します。",
  storage: "端末内の送信待ちを確認できません。画像確認中なら保存せず閉じないでください。",
  "locking-unavailable": `このブラウザでは送信の排他制御を利用できません。${kept}`,
});

export function clockTime(time) {
  return new Date(time).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
}

// tone：idle（なし）・done（送信済み）・sending・waiting・blocked（ログインや通信が必要）・error
export function transferSummary(queue, { loggedIn, online = true, lastSentAt = null } = {}) {
  const count = queue?.pendingCount;
  if (count === null || count === undefined || queue?.reason === "storage") {
    return { tone: "error", label: "確認不可", detail: reasonMessages.storage };
  }
  if (queue.status === "sending") {
    return { tone: "sending", label: "送信中", detail: `ドライブへ送信しています（残り${count}件）。次の撮影もできます。` };
  }
  if (count === 0) {
    return lastSentAt === null
      ? { tone: "idle", label: "", detail: "送信待ちはありません。" }
      : { tone: "done", label: "送信済み", detail: `すべてドライブに送信しました（最後の送信 ${clockTime(lastSentAt)}）。` };
  }
  const skipped = Math.min(count, queue.unreadableCount || 0);
  if (skipped === count) {
    return { tone: "error", label: "読込不可", detail: `送信待ち${count}件。${reasonMessages.unreadable}` };
  }
  // 読めない画像を後回しにしているときは、どの表示でも件数を添える。
  const waiting = `送信待ち${count}件${skipped ? `（うち${skipped}件は読み込めないため後回し）` : ""}。`;
  if (!loggedIn || queue.reason === "authentication" || queue.status === "authentication-required") {
    return { tone: "blocked", label: "要ログイン", detail: `${waiting}人型のアイコンからGoogleにログインすると送信します。${kept}` };
  }
  if (!online) return { tone: "blocked", label: "オフライン", detail: `${waiting}通信が戻ると送信します。${kept}` };
  if (queue.reason) {
    return { tone: "error", label: "送信失敗", detail: `${waiting}${reasonMessages[queue.reason] || reasonMessages.upload}` };
  }
  return { tone: "waiting", label: "送信待ち", detail: `${waiting}前面・オンラインで順に送ります。` };
}
