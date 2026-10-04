import test from "node:test";
import assert from "node:assert/strict";
import { detectLesson, manualLesson, selectLesson, timetableRecord } from "../public/timetable-logic.js";

const lesson = (changes = {}) => ({ id: "math", day: 1, period: "1限", className: "数学", start: "09:00", end: "10:00", ...changes });
const at = (time, date = "2026-10-05") => `${date}T${time}:00+09:00`;
test("月〜日の曜日と日本時間から判定し、時間割外は未判定", () => {
  for (let day = 1; day <= 7; day++) {
    const entries = [lesson({ day })];
    assert.equal(detectLesson(entries, at("09:30", `2026-10-${String(4 + day).padStart(2, "0")}`)).lesson.entry.className, "数学");
    assert.equal(selectLesson(entries, at("11:00")).className, "");
  }
  assert.equal(detectLesson([lesson()], at("09:30", "2026-10-06")).lesson, null);
});
test("前後10分を含み、それより外を除く", () => {
  for (const time of ["08:50", "09:00", "10:00", "10:10"]) assert.ok(detectLesson([lesson()], at(time)).lesson);
  for (const time of ["08:49", "10:11"]) assert.equal(detectLesson([lesson()], at(time)).lesson, null);
  assert.equal(detectLesson([lesson()], at("08:50"), { before: 0, after: 0 }).lesson, null);
});
test("重なる余裕より本来の時間を優先し、本来の時間同士・余裕同士は未判定", () => {
  const entries = [lesson(), lesson({ id: "eng", className: "英語", start: "10:05", end: "11:00" })];
  assert.equal(detectLesson(entries, at("09:59")).lesson.entry.className, "数学");
  assert.equal(detectLesson(entries, at("10:06")).lesson.entry.className, "英語");
  assert.equal(detectLesson(entries, at("10:03")).lesson, null);
  assert.equal(detectLesson([lesson(), lesson({ id: "other" })], at("09:30")).lesson, null);
  assert.equal(detectLesson([], at("09:30")).lesson, null);
});
test("UTCの日付ではなく日本の日付で判定し、深夜の前後余裕と週の境目も扱う", () => {
  const entries = [lesson({ start: "00:05", end: "01:00" })];
  assert.equal(detectLesson(entries, "2026-10-04T15:05:00Z").lesson.date, "2026-10-05");
  assert.equal(detectLesson(entries, at("23:55", "2026-10-04")).lesson.date, "2026-10-05");
  assert.equal(detectLesson(entries, at("23:54", "2026-10-04")).lesson, null);
  const sunday = [lesson({ day: 7, start: "23:00", end: "23:59" })];
  assert.equal(detectLesson(sunday, at("00:09")).lesson.date, "2026-10-04");
  assert.equal(detectLesson(sunday, at("00:10")).lesson, null);
});
test("手動選択を同日の同じ時限で優先し、別時限と翌週に持ち越さない", () => {
  const entries = [lesson(), lesson({ id: "eng", className: "英語", start: "10:05", end: "11:00" })];
  const manual = manualLesson(entries, at("09:30"), "物理");
  assert.equal(selectLesson(entries, at("09:50"), manual).className, "物理");
  assert.equal(selectLesson(entries, at("10:03"), manual).className, "物理");
  assert.equal(selectLesson(entries, at("10:06"), manual).className, "英語");
  assert.equal(selectLesson(entries, at("10:12"), manual).manual, false);
  assert.equal(selectLesson(entries, at("09:30", "2026-10-12"), manual).className, "数学");
  const overlap = manualLesson(entries, at("10:03"), "化学");
  assert.equal(selectLesson(entries, at("10:06"), overlap).className, "化学");
});
test("授業名は既存フォルダ名規則で検証し、不正な時間割を拒否・任意フィールドを除く", () => {
  for (const className of [" 数学", "数学/演習", "数学／演習", "..", "数学\n"]) {
    assert.throws(() => timetableRecord({ updatedAt: 1, entries: [lesson({ className })] }));
  }
  for (const changes of [{ start: "9:00" }, { end: "24:00" }, { end: "08:00" }, { day: 0 }, { period: "" }]) {
    assert.throws(() => timetableRecord({ updatedAt: 1, entries: [lesson(changes)] }));
  }
  assert.throws(() => timetableRecord({ updatedAt: 1, entries: [lesson(), lesson()] }));
  const value = timetableRecord({ updatedAt: 1, entries: [lesson({ token: "ignored" })], token: "ignored" });
  assert.deepEqual(value, { updatedAt: 1, entries: [lesson()] });
});
