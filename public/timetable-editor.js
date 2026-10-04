import { timetableRecord } from "./timetable-logic.js";

export function createTimetableEditor({ save }) {
  const $ = (id) => document.getElementById(id);
  let entries = [];
  let editing = null;
  let busy = true;
  const weekdays = ["月", "火", "水", "木", "金", "土", "日"];
  function reset() {
    editing = null;
    $("timetable-form").reset();
    $("timetable-submit").textContent = "時間割を追加";
  }
  function render() {
    $("timetable-form").querySelectorAll("input, select, button").forEach((node) => { node.disabled = busy; });
    $("timetable-list").replaceChildren(...entries.map((entry) => {
      const row = document.createElement("li");
      const label = document.createElement("p");
      label.textContent = `${weekdays[entry.day - 1]}曜 ${entry.period}：${entry.className} ${entry.start}〜${entry.end}`;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "変更";
      edit.disabled = busy;
      edit.addEventListener("click", () => {
        editing = entry.id;
        for (const field of ["day", "period", "className", "start", "end"]) $("timetable-form").elements[field].value = entry[field];
        $("timetable-submit").textContent = "変更を保存";
        $("timetable-form").elements.period.focus();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "削除";
      remove.disabled = busy;
      remove.addEventListener("click", async () => {
        if (await save(entries.filter((item) => item.id !== entry.id)) && editing === entry.id) reset();
      });
      row.append(label, edit, remove);
      return row;
    }));
    $("timetable-empty").hidden = entries.length > 0;
  }
  $("open-timetable").addEventListener("click", () => {
    $("timetable-panel").hidden = false;
    $("timetable-form").elements.day.focus();
  });
  $("close-timetable").addEventListener("click", () => { $("timetable-panel").hidden = true; });
  $("timetable-reset").addEventListener("click", reset);
  $("timetable-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const fields = $("timetable-form").elements;
    const entry = { id: editing || crypto.randomUUID(), day: Number(fields.day.value), period: fields.period.value,
      className: fields.className.value, start: fields.start.value, end: fields.end.value };
    try {
      const next = editing ? entries.map((item) => item.id === editing ? entry : item) : [...entries, entry];
      timetableRecord({ updatedAt: 0, entries: next });
      if (await save(next)) reset();
    } catch (error) { $("timetable-status").textContent = error.message; }
  });
  render();
  return {
    setRecord(value) { entries = value?.entries || []; render(); },
    setBusy(value) { busy = value; $("open-timetable").disabled = value; render(); },
  };
}
