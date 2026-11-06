// 送信待ちの画像を写真アプリへ控えとして保存する。送信待ちからは消さない。
// iOSの共有シートは操作直後にしか開けないため、読み出し（prepare）と共有（share）を別の操作に分ける。
export function backupFileName({ id, capturedAt }) {
  return `板書_${new Date(capturedAt).toISOString().replace(/[:.]/g, "-")}_${id}.jpg`;
}

export function createPendingBackup({ list, read, navigator = globalThis.navigator, File = globalThis.File }) {
  let files = [];
  let unreadable = 0;
  return {
    ready: () => files.length > 0,
    async prepare() {
      files = [];
      unreadable = 0;
      for (const image of await list()) {
        try {
          const blob = await read(image.id);
          if (blob instanceof Blob && blob.size) files.push(new File([blob], backupFileName(image), { type: "image/jpeg" }));
          else unreadable += 1;
        } catch { unreadable += 1; }
      }
      return { count: files.length, unreadable };
    },
    async share() {
      const data = { files };
      if (!files.length) return "empty";
      if (typeof navigator?.share !== "function" || !navigator.canShare?.(data)) return "unsupported";
      try {
        await navigator.share(data);
        files = [];
        return "shared";
      } catch (error) { return error?.name === "AbortError" ? "cancelled" : "failed"; }
    },
  };
}
