// Googleや画面に依存しない、授業フォルダの命名規則。
export class FolderNameError extends Error {
  constructor(reason) {
    super({
      className: "授業名は空白だけ、前後の空白、区切り文字、制御文字を含めず入力してください。",
      timestamp: "撮影日時は有効な日時とタイムゾーンを指定してください。",
      session: "回数は1以上の安全な整数を指定してください。",
      collision: "指定した回数は別の日に使われています。別の回数を指定してください。",
      folders: "既存フォルダ名は配列で指定してください。",
    }[reason]);
    this.name = "FolderNameError";
    this.reason = reason;
  }
}

function validDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function japanDate(capturedAt) {
  let instant;
  if (capturedAt instanceof Date) instant = capturedAt.getTime();
  else if (typeof capturedAt === "number") instant = capturedAt;
  else if (typeof capturedAt === "string") {
    // タイムゾーンのない文字列をDate.parseに渡すと端末の設定に依存する。
    const match = capturedAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!match || !validDate(match[1]) || Number(match[2]) > 23
      || Number(match[3]) > 59 || Number(match[4]) > 59) throw new FolderNameError("timestamp");
    instant = Date.parse(capturedAt);
  }
  if (!Number.isFinite(instant) || !Number.isFinite(new Date(instant).getTime())) throw new FolderNameError("timestamp");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Tokyo", calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", era: "short",
  }).formatToParts(instant);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const date = `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
  if (get("era") !== "AD" || !validDate(date)) throw new FolderNameError("timestamp");
  return date;
}

function validateSession(session) {
  if (!Number.isSafeInteger(session) || session < 1) throw new FolderNameError("session");
  return session;
}

export function sessionFolderName(session, capturedAt) {
  return `第${String(validateSession(session)).padStart(2, "0")}回_${japanDate(capturedAt)}`;
}

function parseFolder(name) {
  if (typeof name !== "string") return null;
  const match = name.match(/^第(0[1-9]|[1-9]\d+)回_(\d{4}-\d{2}-\d{2})$/);
  if (!match || !validDate(match[2])) return null;
  const session = Number(match[1]);
  return Number.isSafeInteger(session) ? { session, date: match[2], name } : null;
}

export function chooseSessionFolder(existingNames, capturedAt, manualSession) {
  if (!Array.isArray(existingNames)) throw new FolderNameError("folders");
  const date = japanDate(capturedAt);
  const folders = existingNames.map(parseFolder).filter(Boolean);
  if (manualSession !== undefined) {
    validateSession(manualSession);
    if (folders.some((folder) => folder.session === manualSession && folder.date !== date)) {
      throw new FolderNameError("collision");
    }
    return sessionFolderName(manualSession, capturedAt);
  }
  // 同日に複数ある場合は最大の回を採用し、配列の並び順に依存しない。
  const sameDay = folders.filter((folder) => folder.date === date);
  if (sameDay.length) return sameDay.reduce((latest, folder) => folder.session > latest.session ? folder : latest).name;
  const maximum = folders.reduce((max, folder) => Math.max(max, folder.session), 0);
  return sessionFolderName(maximum + 1, capturedAt);
}

export function classFolderName(className) {
  if (typeof className !== "string" || !className || className !== className.trim()
    || className === "." || className === ".." || /[\/\\／\u0000-\u001f\u007f-\u009f]/u.test(className)) {
    throw new FolderNameError("className");
  }
  // 勝手な置換・空白除去で別の授業と同名にしない。
  return className;
}

export function folderPath({ className, session, capturedAt }) {
  return ["板書", classFolderName(className), sessionFolderName(session, capturedAt)];
}
