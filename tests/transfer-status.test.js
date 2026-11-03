import test from "node:test";
import assert from "node:assert/strict";
import { transferSummary, reasonMessages, clockTime } from "../public/transfer-status.js";

const state = (patch) => ({ pendingCount: 2, status: "waiting", reason: null, nextRetryAt: null, ...patch });
const tone = (queue, context = { loggedIn: true }) => transferSummary(queue, context);

test("送信中・送信済み・送信待ちなしを区別し、送信中は残り件数を示す", () => {
  assert.deepEqual(tone(state({ status: "sending" })), { tone: "sending", label: "送信中",
    detail: "ドライブへ送信しています（残り2件）。次の撮影もできます。" });
  assert.equal(tone(state({ pendingCount: 0 })).tone, "idle");
  assert.equal(tone(state({ pendingCount: 0 })).label, "");
  const sentAt = Date.parse("2026-11-03T10:42:00+09:00");
  const done = transferSummary(state({ pendingCount: 0 }), { loggedIn: true, lastSentAt: sentAt });
  assert.equal(done.tone, "done");
  assert.equal(done.label, "送信済み");
  assert.equal(done.detail, `すべてドライブに送信しました（最後の送信 ${clockTime(sentAt)}）。`);
  assert.equal(clockTime(sentAt), "10:42");
});

test("未ログインで送信待ちがあれば、失敗理由より先にログインが必要と示す", () => {
  for (const [queue, loggedIn] of [[state(), false], [state({ reason: "network" }), false],
    [state({ status: "authentication-required", reason: "authentication" }), true]]) {
    const result = tone(queue, { loggedIn });
    assert.equal(result.tone, "blocked");
    assert.equal(result.label, "要ログイン");
    assert.match(result.detail, /^送信待ち2件。/);
  }
  // 送信待ちがなければ、未ログインでも注意を出さない。
  assert.equal(tone(state({ pendingCount: 0 }), { loggedIn: false }).tone, "idle");
});

test("オフライン・失敗理由・通常の待機をそれぞれの文言で示す", () => {
  assert.equal(tone(state(), { loggedIn: true, online: false }).label, "オフライン");
  for (const reason of ["permission", "duplicate-folder", "folder", "network", "server", "timeout", "upload", "locking-unavailable"]) {
    const result = tone(state({ reason }));
    assert.equal(result.tone, "error");
    assert.equal(result.label, "送信失敗");
    assert.equal(result.detail, `送信待ち2件。${reasonMessages[reason]}`);
  }
  assert.equal(tone(state({ reason: "未知" })).detail, `送信待ち2件。${reasonMessages.upload}`);
  assert.deepEqual(tone(state()), { tone: "waiting", label: "送信待ち", detail: "送信待ち2件。前面・オンラインで順に送ります。" });
});

test("件数を確認できない・端末内保存の異常は確認不可とする", () => {
  assert.equal(tone(state({ pendingCount: null })).label, "確認不可");
  assert.equal(tone(state({ reason: "storage" })).tone, "error");
});

test("読めない画像は全件なら読込不可、一部なら後回しの件数を添える", () => {
  const all = tone(state({ unreadableCount: 2 }));
  assert.equal(all.tone, "error");
  assert.equal(all.label, "読込不可");
  assert.equal(all.detail, `送信待ち2件。${reasonMessages.unreadable}`);
  const some = tone(state({ pendingCount: 3, unreadableCount: 1, status: "sending" }));
  assert.equal(some.label, "送信中");
  assert.equal(tone(state({ pendingCount: 3, unreadableCount: 1 })).detail,
    "送信待ち3件（うち1件は読み込めないため後回し）。前面・オンラインで順に送ります。");
});
