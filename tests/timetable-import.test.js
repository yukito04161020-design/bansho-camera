import test from "node:test";
import assert from "node:assert/strict";
import { parseTimetableImport, applyTimetableImport } from "../public/timetable-import.js";
import { config } from "../public/config.js";

test("曜日表記・区切り・全角英数字と両形式を読み込み、括弧と授業内の空白を保持する", () => {
  const result = parseTimetableImport("# コメント\r\n\n月 1限 架空の授業Ａ\n火曜　２限　架空の授業Ｂ（２組）\n水曜日\t3限\t架空の 授業C (３組)　\n土 １８:００-１９:３０ 架空の授業D");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.entries.map(({ day, period, start, end, className }) => ({ day, period, start, end, className })), [
    { day: 1, period: "1限", start: "08:50", end: "10:20", className: "架空の授業A" },
    { day: 2, period: "2限", start: "10:30", end: "12:00", className: "架空の授業B（2組）" },
    { day: 3, period: "3限", start: "13:00", end: "14:30", className: "架空の 授業C (3組)" },
    { day: 6, period: "その他", start: "18:00", end: "19:30", className: "架空の授業D" },
  ]);
  for (const [index, preset] of config.periodPresets.entries()) {
    const entry = parseTimetableImport(`${"月火水木金土日"[index]} ${preset.period} 架空の授業`).entries[0];
    assert.equal(entry.day, index + 1);
    assert.equal(entry.start, preset.start); assert.equal(entry.end, preset.end);
  }
});

test("不正行は元の行番号と理由を報告し、有効行だけ読み込む", () => {
  const result = parseTimetableImport("\n# コメント\n1限 架空の授業\n月 8限 架空の授業\n火 19:30-18:00 架空の授業\n水 1限\n木 25:00-26:00 架空の授業\n金 1限 架空/授業\n日 7限 架空の授業\n土 18:00-18:00 架空の授業");
  assert.deepEqual(result.errors.map(e => e.lineNumber), [3, 4, 5, 6, 7, 8, 10]);
  assert.match(result.errors[0].reason, /曜日/); assert.match(result.errors[1].reason, /1〜7限/);
  assert.match(result.errors[2].reason, /終了は開始より後/); assert.match(result.errors[3].reason, /授業名/);
  assert.ok(result.errors.every(e => e.reason && e.source)); assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].day, 7);
});

test("追加は既存・入力内の重複を除外し、同名の別曜日・時限は残す。置き換えは古い時間割を消す", () => {
  const current = parseTimetableImport("月 1限 架空の授業Ａ\n火 2限 古い架空の授業").entries;
  const imported = parseTimetableImport("月 1限 架空の授業A\n月 1限 架空の授業A\n火 1限 架空の授業A\n月 2限 架空の授業A").entries;
  let serial = 0; const makeId = () => `new-${++serial}`;
  const added = applyTimetableImport(current, imported, "add", makeId);
  assert.equal(added.length, 4); assert.deepEqual(added.slice(0, 2), current);
  assert.deepEqual(applyTimetableImport(added, imported, "add", makeId), added);
  const replaced = applyTimetableImport(current, imported, "replace", makeId);
  assert.equal(replaced.length, 3); assert.ok(replaced.every(e => e.className === "架空の授業A"));
  assert.equal(new Set(replaced.map(e => e.id)).size, 3);
  assert.deepEqual(applyTimetableImport(current, [], "replace"), []);
  assert.equal(current.length, 2);
});
