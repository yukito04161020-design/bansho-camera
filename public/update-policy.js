// 不明な状態や送信待ち件数の取得失敗では切り替えない、安全側の判定です。
export function canApplyUpdate({ cameraActive, imagePreview, pageVisible, pendingUploads } = {}) {
  return cameraActive === false && imagePreview === false && pageVisible === true && pendingUploads === 0;
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
