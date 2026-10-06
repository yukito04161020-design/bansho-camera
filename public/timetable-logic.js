import { config } from "./config.js";
import { classFolderName, japanDate } from "./folder-logic.js";

const minute = (text) => {
  if (typeof text !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    throw new TypeError("時刻は日本時間のHH:MMで入力してください。");
  }
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
};
export function timetableRecord(input) {
  if (!input || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0 || !Array.isArray(input.entries)) {
    throw new TypeError("時間割の更新時刻と登録内容を確認できません。");
  }
  const ids = new Set();
  const entries = input.entries.map((entry) => {
    if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
      || !Number.isInteger(entry.day) || entry.day < 1 || entry.day > 7
      || typeof entry.period !== "string" || !entry.period.trim()
      || minute(entry.start) >= minute(entry.end)) {
      throw new TypeError("曜日・時限・開始と終了の時刻を確認してください。終了は開始より後にしてください。");
    }
    ids.add(entry.id);
    return { id: entry.id, day: entry.day, period: entry.period,
      className: classFolderName(entry.className), start: entry.start, end: entry.end };
  });
  return { updatedAt: input.updatedAt, entries };
}

// 前後日の授業も調べ、日曜→月曜や日本時間の深夜にまたがる余裕を扱う。
export function detectLesson(entries, capturedAt, margins = config.timetableMargins) {
  const date = japanDate(capturedAt);
  const instant = new Date(capturedAt).getTime();
  const midnight = Date.parse(`${date}T00:00:00+09:00`);
  const candidates = [];
  for (const offset of [-1, 0, 1]) {
    const dayStart = midnight + offset * 86400000;
    const weekday = new Date(dayStart + 9 * 3600000).getUTCDay() || 7;
    for (const entry of entries) {
      if (entry.day !== weekday) continue;
      const start = dayStart + minute(entry.start) * 60000;
      const end = dayStart + minute(entry.end) * 60000;
      if (instant >= start - margins.before * 60000 && instant <= end + margins.after * 60000) {
        candidates.push({ entry, start, end, date: japanDate(dayStart),
          key: `${japanDate(dayStart)}:${entry.id}`,
          within: instant >= start && instant <= end });
      }
    }
  }
  const exact = candidates.filter((item) => item.within);
  const preferred = exact.length ? exact : candidates;
  return { lesson: preferred.length === 1 ? preferred[0] : null, candidates };
}
export function manualLesson(entries, capturedAt, className) {
  classFolderName(className);
  const result = detectLesson(entries, capturedAt);
  // 未判定の重なりでも、該当時限のどれかが続く間は手動選択を保つ。
  return { className, date: japanDate(capturedAt), keys: (result.lesson ? [result.lesson] : result.candidates).map((item) => item.key) };
}
export function selectLesson(entries, capturedAt, manual) {
  const result = detectLesson(entries, capturedAt);
  const manuallySelected = manual?.date === japanDate(capturedAt)
    && (manual.keys.length === 0 ? result.candidates.length === 0
      : result.lesson ? manual.keys.includes(result.lesson.key)
        : result.candidates.some((item) => manual.keys.includes(item.key)));
  return { className: manuallySelected ? manual.className : result.lesson?.entry.className || "",
    lesson: result.lesson, manual: Boolean(manuallySelected) };
}

export function manualLessonRecord(input) {
  if (!input) return null;
  if (typeof input.date !== "string" || japanDate(`${input.date}T00:00:00+09:00`) !== input.date
    || !Array.isArray(input.keys) || input.keys.some((key) => typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}:.+$/u.test(key))) {
    throw new TypeError("手動選択の時限を確認できません。");
  }
  return { className: classFolderName(input.className), date: input.date, keys: [...input.keys] };
}

// 月〜日、既定の1〜7限、その他は開始時刻の順。同じ時限は開始時刻で並べる。
export function sortTimetableEntries(entries) {
  const rank = (period) => {
    const index = config.periodPresets.findIndex((item) => item.period === period);
    return index < 0 ? config.periodPresets.length : index;
  };
  return [...entries].sort((a, b) => a.day - b.day || rank(a.period) - rank(b.period)
    || minute(a.start) - minute(b.start));
}
