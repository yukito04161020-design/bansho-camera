import { parseTimetableImport, applyTimetableImport, timetableAiPrompt } from "./timetable-import.js";
import { config } from "./config.js";
import { timetableRecord, sortTimetableEntries } from "./timetable-logic.js";

export function createTimetableEditor({ save, document = globalThis.document,
  clipboard = globalThis.navigator?.clipboard, confirm = (message) => globalThis.confirm(message) }) {
  const $ = (id) => document.getElementById(id);
  let entries = [];
  let editing = null;
  let busy = true;
  let preview = null;
  let importing = false;
  const weekdays = ["月", "火", "水", "木", "金", "土", "日"];
  const selector = $("timetable-preset");
  selector.replaceChildren(...[
    ...config.periodPresets.map(({ period }) => ({ value: period, text: period })),
    { value: "", text: "その他（手入力）" },
  ].map(({ value, text }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    return option;
  }));
  function selectPeriod(applyTimes) {
    const fields = $("timetable-form").elements;
    const preset = config.periodPresets.find((item) => item.period === selector.value);
    fields.period.hidden = Boolean(preset);
    $("timetable-period-label").hidden = Boolean(preset);
    if (preset) {
      fields.period.value = preset.period;
      if (applyTimes) {
        fields.start.value = preset.start;
        fields.end.value = preset.end;
      }
    }
  }
  selector.addEventListener("change", () => selectPeriod(true));
  function reset() {
    editing = null;
    $("timetable-form").reset();
    selectPeriod(true);
    $("timetable-submit").textContent = "時間割を追加";
  }
  function renderImport() {
    const locked = busy || importing;
    for (const id of ["import-copy", "import-text", "import-check"]) $(id).disabled = locked;
    for (const id of ["import-add", "import-replace"]) $(id).disabled = locked || !preview?.entries.length;
  }
  function invalidatePreview() {
    preview = null;
    $("import-preview").hidden = true;
    renderImport();
  }
  $("import-text").addEventListener("input", invalidatePreview);
  $("import-copy").addEventListener("click", async () => {
    if (busy || importing) return;
    try {
      await clipboard.writeText(timetableAiPrompt);
      $("import-status").textContent = "依頼文をコピーしました。スクリーンショットと一緒にClaudeやChatGPTに送ってください。";
    } catch {
      $("import-status").textContent = "コピーできませんでした。下の依頼文を選択してコピーし、スクリーンショットと一緒にClaudeやChatGPTに送ってください。";
      $("import-prompt").hidden = false;
      $("import-prompt").value = timetableAiPrompt;
      $("import-prompt").focus();
      $("import-prompt").select();
    }
  });
  $("import-check").addEventListener("click", () => {
    if (busy || importing) return;
    preview = parseTimetableImport($("import-text").value);
    $("import-preview").hidden = false;
    $("import-valid").replaceChildren(...sortTimetableEntries(preview.entries).map((entry) => {
      const row = document.createElement("li");
      row.textContent = `${weekdays[entry.day - 1]}曜 ${entry.period} ${entry.start}〜${entry.end} ${entry.className}`;
      return row;
    }));
    $("import-errors").replaceChildren(...preview.errors.map((error) => {
      const row = document.createElement("li");
      row.textContent = `${error.lineNumber}行目：${error.reason}（${error.source}）`;
      return row;
    }));
    $("import-status").textContent = `読み込める行：${preview.entries.length}件、読めない行：${preview.errors.length}件。読める行だけを登録します。`;
    renderImport();
  });
  async function commitImport(mode) {
    if (busy || importing || !preview?.entries.length) return;
    if (mode === "replace" && !confirm("今の時間割をすべて消し、確認した時間割に置き換えますか？")) return;
    importing = true;
    renderImport();
    try {
      const next = applyTimetableImport(entries, preview.entries, mode);
      if (await save(next)) {
        reset();
        $("import-text").value = "";
        invalidatePreview();
        $("import-status").textContent = "時間割を登録しました。保存・同期の状態は上の案内を確認してください。";
      } else {
        $("import-status").textContent = "時間割を登録できませんでした。保存・同期の状態を確認して、もう一度試してください。";
      }
    } catch (error) { $("import-status").textContent = error.message; }
    finally { importing = false; renderImport(); }
  }
  $("import-add").addEventListener("click", () => commitImport("add"));
  $("import-replace").addEventListener("click", () => commitImport("replace"));
  function render() {
    renderImport();
    $("timetable-form").querySelectorAll("input, select, button").forEach((node) => { node.disabled = busy; });
    $("timetable-list").replaceChildren(...sortTimetableEntries(entries).map((entry) => {
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
        selector.value = config.periodPresets.some((item) => item.period === entry.period) ? entry.period : "";
        selectPeriod(false);
        $("timetable-submit").textContent = "変更を保存";
        selector.focus();
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
  reset();
  render();
  return {
    setRecord(value) { entries = value?.entries || []; render(); },
    setBusy(value) { busy = value; $("open-timetable").disabled = value; render(); },
  };
}
