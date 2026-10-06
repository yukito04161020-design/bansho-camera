import { config } from "./config.js";
import { timetableRecord } from "./timetable-logic.js";

export const timetableAiPrompt = "この画像は大学の時間割です。各コマを1行ずつ『曜日 時限 授業名』の形式で書き出してください。曜日は月火水木金土日の1文字、時限は『1限』のように書きます。授業名は画像のとおりに書き、教室名や通知の数字は含めないでください。空きコマは書かないでください。2コマ続きの授業は、それぞれの時限を1行ずつ書いてください。説明や前置きは書かず、行だけを出力してください。";

// NFKCは括弧なども変えるので、英数字だけを揃える。
export const normalizeTimetableText = (text) => text.replace(/[Ａ-Ｚａ-ｚ０-９]/gu,
  (letter) => String.fromCharCode(letter.charCodeAt(0) - 0xfee0));

export function parseTimetableImport(text) {
  const entries = [];
  const errors = [];
  text.split(/\r\n|\n|\r/u).forEach((source, index) => {
    const line = normalizeTimetableText(source).trim();
    if (!line || line.startsWith("#")) return;
    try {
      const match = /^([月火水木金土日])(?:曜日|曜)?[ \u3000\t]+(\S+)(?:[ \u3000\t]+(.*))?$/u.exec(line);
      if (!match) throw new Error("曜日（月〜日）と時限または時刻を指定してください。");
      const [, weekday, slot, name] = match;
      const className = (name || "").trim();
      if (!className) throw new Error("授業名を入力してください。");
      let times;
      let period;
      if (/^\d+限$/u.test(slot)) {
        times = config.periodPresets.find((item) => item.period === slot);
        if (!times) throw new Error("時限は1〜7限で指定してください。");
        period = times.period;
      } else {
        const timeMatch = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/u.exec(slot);
        if (!timeMatch) throw new Error("時限は1〜7限、時刻はHH:MM-HH:MMで指定してください。");
        period = "その他";
        times = { start: timeMatch[1], end: timeMatch[2] };
      }
      const entry = { id: `line-${index + 1}`, day: "月火水木金土日".indexOf(weekday) + 1,
        period, start: times.start, end: times.end, className };
      entries.push(timetableRecord({ updatedAt: 0, entries: [entry] }).entries[0]);
    } catch (error) { errors.push({ lineNumber: index + 1, source, reason: error.message }); }
  });
  return { entries, errors };
}

export function applyTimetableImport(current, imported, mode, makeId = () => crypto.randomUUID()) {
  if (mode !== "add" && mode !== "replace") throw new TypeError("追加または置き換えを選んでください。");
  const next = mode === "add" ? [...current] : [];
  const key = (entry) => JSON.stringify([entry.day, entry.period, normalizeTimetableText(entry.className).trim()]);
  const seen = new Set(next.map(key));
  for (const entry of imported) {
    if (seen.has(key(entry))) continue;
    seen.add(key(entry));
    next.push({ ...entry, id: makeId() });
  }
  return timetableRecord({ updatedAt: 0, entries: next }).entries;
}
