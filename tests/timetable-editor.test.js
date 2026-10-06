import test from "node:test";
import assert from "node:assert/strict";
import { createTimetableEditor } from "../public/timetable-editor.js";
import { timetableRecord, sortTimetableEntries } from "../public/timetable-logic.js";

function fixture(options = {}) {
  const nodes = new Map();
  function node() {
    return { value: "", hidden: false, children: [], listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); }, focus() {}, select() {},
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
  const editor = createTimetableEditor({ document, save: async entries => { saved = entries; editor.setRecord({ entries }); return true; }, ...options });
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


test("貼り付け確認では有効行と行番号付きエラーを表示し、既存保存へ有効行だけ渡す", async () => {
  const f = fixture();
  f.$("import-text").value = "月 1限 架空の授業A\n火 8限 架空の授業B";
  assert.equal(f.$("import-add").disabled, true);
  f.$("import-check").fire("click");
  assert.equal(f.$("import-valid").children[0].textContent, "月曜 1限 08:50〜10:20 架空の授業A");
  assert.match(f.$("import-errors").children[0].textContent, /2行目.*1〜7限/);
  await f.$("import-add").fire("click");
  assert.equal(f.saved().length, 1); assert.equal(f.saved()[0].className, "架空の授業A");
  assert.equal(f.$("import-preview").hidden, true);
  assert.equal(f.$("import-text").value, "");
  assert.equal(f.$("import-add").disabled, true);
});

test("確認後の編集はプレビューを無効にし、処理中と有効行なしでは確定しない", async () => {
  const f = fixture();
  f.$("import-text").value = "月 1限 架空の授業A";
  f.$("import-check").fire("click");
  f.$("import-text").value = "月 2限 架空の授業B";
  f.$("import-text").fire("input");
  await f.$("import-add").fire("click"); assert.equal(f.saved(), undefined);
  f.$("import-check").fire("click");
  f.editor.setBusy(true);
  await f.$("import-add").fire("click"); assert.equal(f.saved(), undefined);
  assert.equal(f.$("import-text").disabled, true);
  f.editor.setBusy(false);
  f.$("import-text").value = "月 8限 架空の授業A";
  f.$("import-check").fire("click");
  await f.$("import-add").fire("click"); assert.equal(f.saved(), undefined);
});

test("置き換えは確認が必要で、キャンセルで既存を保持し、承認で古い授業を消す", async () => {
  let accepted = false; let confirmations = 0;
  const f = fixture({ confirm: message => { assert.match(message, /すべて消し/); confirmations++; return accepted; } });
  f.editor.setRecord({ entries: [entry("old", 1, "1限")] });
  f.$("import-text").value = "火 2限 架空の授業A"; f.$("import-check").fire("click");
  await f.$("import-replace").fire("click"); assert.equal(f.saved(), undefined);
  accepted = true; await f.$("import-replace").fire("click");
  assert.equal(confirmations, 2); assert.equal(f.saved().length, 1);
  assert.equal(f.saved()[0].day, 2); assert.equal(f.saved()[0].className, "架空の授業A");
});

test("依頼文をコピーし、失敗した場合は手動コピー用の文を表示する", async () => {
  let copied;
  const f = fixture({ clipboard: { async writeText(text) { copied = text; } } });
  await f.$("import-copy").fire("click");
  assert.ok(copied.startsWith("この画像は大学の時間割です。"));
  assert.ok(copied.endsWith("説明や前置きは書かず、行だけを出力してください。"));
  assert.match(f.$("import-status").textContent, /スクリーンショットと一緒にClaudeやChatGPT/);
  const failed = fixture({ clipboard: { async writeText() { throw new Error("不可"); } } });
  await failed.$("import-copy").fire("click");
  assert.equal(failed.$("import-prompt").hidden, false);
  assert.equal(failed.$("import-prompt").value, copied);
});

test("保存失敗時は確認内容を残し、再試行できる", async () => {
  const f = fixture({ save: async () => false });
  f.$("import-text").value = "月 1限 架空の授業A"; f.$("import-check").fire("click");
  await f.$("import-add").fire("click");
  assert.equal(f.$("import-preview").hidden, false); assert.equal(f.$("import-add").disabled, false);
  assert.match(f.$("import-status").textContent, /登録できません/);
});
