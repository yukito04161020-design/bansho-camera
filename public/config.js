// このファイルはそのまま公開されます。公開してよい値だけをまとめてください。
// APIキー、クライアントシークレット、トークン、パスワードは置かないでください。
// 後続のログイン実装から import { config } from "./config.js" で参照します。
export const config = Object.freeze({
  sharpestFrame: Object.freeze({ delayMs: 150, durationMs: 500, maxFrames: 8, scoreLongEdge: 800 }),
  periodPresets: Object.freeze([
    ["1限", "08:50", "10:20"],
    ["2限", "10:30", "12:00"],
    ["3限", "13:00", "14:30"],
    ["4限", "14:40", "16:10"],
    ["5限", "16:20", "17:50"],
    ["6限", "18:10", "19:40"],
    ["7限", "19:50", "21:20"],
  ].map(([period, start, end]) => Object.freeze({ period, start, end }))),
  timetableMargins: Object.freeze({ before: 10, after: 10 }),
  googleClientId: "787282760100-k8h7vvjcg765prd70q5cnalp7mhpdp1l.apps.googleusercontent.com",
});
