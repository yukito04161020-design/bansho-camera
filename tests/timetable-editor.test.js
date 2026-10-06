import test from "node:test";
import assert from "node:assert/strict";
import { createTimetableEditor } from "../public/timetable-editor.js";
import { timetableRecord, sortTimetableEntries } from "../public/timetable-logic.js";

function fixture() {
  const nodes = new Map();
  function node() {
    return { value: "", hidden: false, children: [], listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); }, focus() {},
      fire(type) { return this.listeners[type]({ preventDefault() {} }); } };
  }
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  const $ = document.getElementById;
  const fields = Object.fromEntries(["day", "period", "className", "start", "end"].map(key => [key, node()]));
  fields.preset = $("timetable-preset");
  $("timetable-form").elements = fields;
  $("timetable-form").querySelectorAll = () => Object.values(fields);
  $("timetable-form").reset = () => { for (const field of Object.values(fields)) field.value = ""; fields.day.value = "1"; fields.preset.value = "1限"; };
  let saved;
  const editor = createTimetableEditor({ document, save: async entries => { saved = entries; editor.setRecord({ entries }); return true; } });
  editor.setBusy(false);
  return { $, fields, editor, saved: () => saved };
}
const expected = [["08:50", "10:20"], ["10:30", "12:00"], ["13:00", "14:30"], ["14:40", "16:10"], ["16:20", "17:50"], ["18:10", "19:40"], ["19:50", "21:20"]];
const entry = (id, day, period, start = "08:50", end = "10:20") => ({ id, day, period, start, end, className: "数学" });

test("1〜7限の選択で既定時刻が入り、手直しして保存できる", async () => {
  const f = fixture();
  assert.deepEqual(f.$("timetable-preset").children.map(item => item.textContent), ["1限", "2限", "3限", "4限", "5限", "6限", "7限", "その他（手入力）"]);
  for (const [index, times] of expected.entries()) {
    f.fields.preset.value = `${index + 1}限`;
    f.fields.preset.fire("change");
    assert.deepEqual([f.fields.start.value, f.fields.end.value], times);
    assert.equal(f.fields.period.value, `${index + 1}限`);
    assert.equal(f.fields.period.hidden, true);
  }
  f.fields.start.value = "19:55"; f.fields.className.value = "数学";
  await f.$("timetable-form").fire("submit");
  assert.equal(f.saved()[0].start, "19:55");
  assert.equal(f.saved()[0].period, "7限");
  assert.equal(f.fields.preset.value, "1限");
  assert.equal(f.fields.start.value, "08:50");
});

test("その他は表示名と時刻を手入力できる", async () => {
  const f = fixture(); f.fields.preset.value = ""; f.fields.preset.fire("change");
  assert.equal(f.fields.period.hidden, false);
  f.fields.period.value = "特別授業"; f.fields.start.value = "09:00"; f.fields.end.value = "11:00"; f.fields.className.value = "数学";
  await f.$("timetable-form").fire("submit");
  assert.deepEqual(f.saved()[0], { ...entry(f.saved()[0].id, 1, "特別授業", "09:00", "11:00") });
});

test("既存の自由文字列を読み込み、一致する表示名は時限として編集する。保存済み時刻は保持する", async () => {
  const f = fixture();
  const record = timetableRecord({ updatedAt: 1, entries: [entry("a", 1, "1限", "09:00", "10:00"), entry("b", 2, "自由な表示名")] });
  f.editor.setRecord(record);
  f.$("timetable-list").children[0].children[1].fire("click");
  assert.equal(f.fields.preset.value, "1限"); assert.equal(f.fields.period.hidden, true);
  assert.equal(f.fields.start.value, "09:00"); assert.equal(f.fields.end.value, "10:00");
  await f.$("timetable-form").fire("submit");
  assert.deepEqual(f.saved(), record.entries);
  f.$("timetable-list").children[1].children[1].fire("click");
  assert.equal(f.fields.preset.value, ""); assert.equal(f.fields.period.hidden, false);
  assert.equal(f.fields.period.value, "自由な表示名");
});

test("一覧を曜日・時限順に並べ、その他は開始時刻順に並べる。元の保存順は変えない", () => {
  const entries = [entry("sun", 7, "1限"), entry("two", 1, "2限"), entry("late", 1, "自由", "18:00", "19:00"), entry("one", 1, "1限"), entry("early", 1, "特別")];
  assert.deepEqual(sortTimetableEntries(entries).map(item => item.id), ["one", "two", "early", "late", "sun"]);
  assert.equal(entries[0].id, "sun");
  const f = fixture(); f.editor.setRecord({ entries });
  assert.deepEqual(f.$("timetable-list").children.map(row => row.children[0].textContent.split("：")[0]), ["月曜 1限", "月曜 2限", "月曜 特別", "月曜 自由", "日曜 1限"]);
});
