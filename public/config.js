// このファイルはそのまま公開されます。公開してよい値だけをまとめてください。
// APIキー、クライアントシークレット、トークン、パスワードは置かないでください。
// 後続のログイン実装から import { config } from "./config.js" で参照します。
export const config = Object.freeze({
  googleClientId: "787282760100-k8h7vvjcg765prd70q5cnalp7mhpdp1l.apps.googleusercontent.com",
  // Googleドライブへの保存で要求する権限
  driveScopes: ["https://www.googleapis.com/auth/drive"],
});
