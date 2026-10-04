import { timetableRecord } from "./timetable-logic.js";

// 画面・認証・Drive APIに依存しない新旧比較。操作を直列化して編集中の上書きを防ぐ。
export function createTimetableSync({ store, drive, canSync, now = Date.now }) {
  let running = Promise.resolve();
  const serialize = (operation) => {
    const result = running.then(operation);
    running = result.catch(() => {});
    return result;
  };
  async function reconcile() {
    const local = await store.readTimetable();
    if (!canSync()) return local;
    const remote = await drive.read();
    if (remote && (!local || remote.updatedAt > local.updatedAt)) {
      await store.writeTimetable(remote);
      return remote;
    }
    if (local && (!remote || local.updatedAt > remote.updatedAt)) await drive.write(local);
    return local || remote;
  }
  return {
    load: () => serialize(reconcile),
    save: (entries) => {
      // 呼び出した時点の内容を固定し、後から入力欄を変えても保存対象を変えない。
      const copy = timetableRecord({ updatedAt: 0, entries }).entries;
      return serialize(async () => {
        const local = await store.readTimetable();
        // 端末への保存を先に完了する。通信失敗でも再ログイン時に再送できる。
        const value = timetableRecord({ updatedAt: Math.max(now(), (local?.updatedAt || 0) + 1), entries: copy });
        await store.writeTimetable(value);
        return reconcile();
      });
    },
  };
}
