import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { classFolderName, chooseSessionFolder, folderPath, japanDate, sessionFolderName } from "../public/folder-logic.js";

const day = "2026-09-30T09:00:00+09:00";
const fails = (reason) => (error) => error.reason === reason;

test("授業名・回・日本時間の日付で3階層のフォルダ名を返す", () => {
  assert.deepEqual(folderPath({ className: "数学Ⅰ", session: 1, capturedAt: day }), ["板書", "数学Ⅰ", "第01回_2026-09-30"]);
  assert.equal(sessionFolderName(9, day), "第09回_2026-09-30");
  assert.equal(sessionFolderName(10, day), "第10回_2026-09-30");
  assert.equal(sessionFolderName(100, day), "第100回_2026-09-30");
});

test("授業名はそのまま保持し、区切り文字・空白のみ・制御文字を拒否する", () => {
  assert.equal(classFolderName("応用 数学（A）"), "応用 数学（A）");
  for (const value of ["", " ", " 数学", "数学 ", "数/学", "数\\学", "数／学", "数\n学", "数\0学", ".", "..", null]) {
    assert.throws(() => classFolderName(value), fails("className"));
  }
});

test("新しい授業は第01回、同じ日は既存フォルダを再利用する", () => {
  assert.equal(chooseSessionFolder([], day), "第01回_2026-09-30");
  assert.equal(chooseSessionFolder(["第01回_2026-09-30"], "2026-09-30T23:59:59+09:00"), "第01回_2026-09-30");
});

test("別の日は最大回＋1、休講や回数の欠番があっても日数を加算しない", () => {
  const names = ["第07回_2026-09-01", "第02回_2026-08-25"];
  assert.equal(chooseSessionFolder(names, day), "第08回_2026-09-30");
  assert.equal(chooseSessionFolder(["第99回_2026-09-29"], day), "第100回_2026-09-30");
  assert.deepEqual(names, ["第07回_2026-09-01", "第02回_2026-08-25"]);
});

test("日本時間の午前0時直前と直後で次の回に分かれる", () => {
  const before = "2026-09-29T14:59:59.999Z";
  const after = "2026-09-29T15:00:00.000Z";
  assert.equal(japanDate(before), "2026-09-29");
  assert.equal(japanDate(after), "2026-09-30");
  const names = ["第03回_2026-09-29"];
  assert.equal(chooseSessionFolder(names, before), "第03回_2026-09-29");
  assert.equal(chooseSessionFolder(names, after), "第04回_2026-09-30");
});

test("年・月の境目、うるう年と同じ瞬間の別表記を日本時間で扱う", () => {
  assert.equal(japanDate("2026-12-31T15:00:00Z"), "2027-01-01");
  assert.equal(japanDate("2024-02-28T15:00:00Z"), "2024-02-29");
  for (const value of [day, "2026-09-30T00:00:00Z", "2026-09-29T17:00:00-07:00", new Date(day), Date.parse(day)]) {
    assert.equal(japanDate(value), "2026-09-30");
  }
});

test("端末相当のタイムゾーンが東京・UTC・米国でも結果が一致する", () => {
  const moduleUrl = new URL("../public/folder-logic.js", import.meta.url).href;
  const script = `import { chooseSessionFolder } from ${JSON.stringify(moduleUrl)}; console.log(chooseSessionFolder(['第03回_2026-09-29'], '2026-09-29T15:00:00Z'));`;
  for (const TZ of ["Asia/Tokyo", "UTC", "America/Los_Angeles"]) {
    assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ }, encoding: "utf8" }).trim(), "第04回_2026-09-30");
  }
});

test("手動指定は同日の自動提案より優先し、同じ日・同じ回は再利用できる", () => {
  const names = ["第02回_2026-09-29", "第03回_2026-09-30"];
  assert.equal(chooseSessionFolder(names, day, 7), "第07回_2026-09-30");
  assert.equal(chooseSessionFolder(names, day, 3), "第03回_2026-09-30");
  assert.equal(chooseSessionFolder(names, day, 1), "第01回_2026-09-30");
  assert.throws(() => chooseSessionFolder(names, day, 2), fails("collision"));
});

test("同日の複数フォルダは最大回を使い、並び順で変わらない", () => {
  const names = ["第03回_2026-09-30", "第07回_2026-09-30", "第08回_2026-10-01"];
  assert.equal(chooseSessionFolder(names, day), "第07回_2026-09-30");
  assert.equal(chooseSessionFolder([...names].reverse(), day), "第07回_2026-09-30");
});

test("規則外の名前・存在しない日付・危険な数値を無視する", () => {
  const invalid = ["手作り", "第1回_2026-09-29", "第00回_2026-09-29", "第099回_2026-09-29", "第99回_2026-02-29", "第99回_2026-04-31", "第99回_0000-01-01", "第99回_2026-13-01", "第99回_2026-09-00", "第99回_2026-9-29", "第99回_2026-09-29余分", "第9007199254740992回_2026-09-29", null, 99];
  assert.equal(chooseSessionFolder([...invalid, "第02回_2026-09-29"], day), "第03回_2026-09-30");
  assert.equal(chooseSessionFolder(["第05回_2024-02-29"], day), "第06回_2026-09-30");
});

test("不正な入力を拒否し、最大安全整数からの加算で丸めない", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => chooseSessionFolder([], day, value), fails("session"));
  }
  for (const value of ["2026-09-30", "2026-09-30T09:00:00", "2026-02-30T00:00:00Z", "2026-09-30T24:00:00Z", "invalid", new Date(NaN), NaN, Infinity, null]) {
    assert.throws(() => japanDate(value), fails("timestamp"));
  }
  assert.throws(() => chooseSessionFolder(null, day), fails("folders"));
  assert.throws(() => chooseSessionFolder([`第${Number.MAX_SAFE_INTEGER}回_2026-09-29`], day), fails("session"));
});
