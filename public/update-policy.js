// 不明な状態や送信待ち件数の取得失敗では切り替えない、安全側の判定です。
export function canApplyUpdate({ cameraActive, imagePreview, pageVisible, pendingUploads, operationActive = false } = {}) {
  return cameraActive === false && imagePreview === false && pageVisible === true && pendingUploads === 0
    && operationActive === false;
}

// 利用者が押した切り替えは、送信待ちやログイン中でも行う（送信待ちは端末内に残り、開き直した後に送る）。
// 未保存の撮影画像や保存中の内容を失わないよう、画像の確認中・保存などの処理中・裏にいる間は切り替えない。
export function canApplyManually({ imagePreview, pageVisible, operationBusy } = {}) {
  return imagePreview === false && pageVisible === true && operationBusy === false;
}

export function createUpdateChecker({ currentVersion, readLatestVersion, readPendingUploads, getActivity, applyUpdate }) {
  let checking = false;
  let applying = false;
  return async function checkForUpdate() {
    if (checking || applying) return "busy";
    checking = true;
    try {
      const latestVersion = await readLatestVersion();
      if (!latestVersion || latestVersion === currentVersion) return "current";
      const pendingUploads = await readPendingUploads();
      // 非同期の確認中に撮影が始まることがあるため、切り替えの直前に状態を読む。
      if (!canApplyUpdate({ ...getActivity(), pendingUploads })) return "deferred";
      applying = true;
      applyUpdate(latestVersion);
      return "applied";
    } catch {
      applying = false;
      return "unavailable";
    } finally {
      checking = false;
    }
  };
}
