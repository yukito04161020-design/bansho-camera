// このファイルはそのまま公開されます。公開してよい値だけをまとめてください。
// APIキー、クライアントシークレット、トークン、パスワードは置かないでください。
// 後続のログイン実装から import { config } from "./config.js" で参照します。
export const config = Object.freeze({
  sharpestFrame: Object.freeze({ delayMs: 150, durationMs: 500, maxFrames: 8, scoreLongEdge: 800 }),
  timetableMargins: Object.freeze({ before: 10, after: 10 }),
  googleClientId: "787282760100-k8h7vvjcg765prd70q5cnalp7mhpdp1l.apps.googleusercontent.com",
});
