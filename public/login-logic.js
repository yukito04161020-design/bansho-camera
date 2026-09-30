export const driveFileScope = "https://www.googleapis.com/auth/drive.file";

// Googleの応答や例外には秘密情報が含まれる可能性があるため、画面には固定の理由だけを渡します。
export class LoginTestError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

export function tokenClientOptions(clientId, callback, errorCallback) {
  return {
    client_id: clientId,
    scope: driveFileScope,
    include_granted_scopes: false,
    callback,
    error_callback: errorCallback,
  };
}

// トークンはこのインスタンスのメモリ内だけに保持し、表示用の状態には含めません。
export class TokenSession {
  #token = "";
  #receivedAt = null;
  #expiresAt = null;
  #invalid = false;
  #clock;

  constructor(clock = Date.now) { this.#clock = clock; }

  accept(response) {
    this.clear();
    if (response?.error) throw new LoginTestError("authorization");
    const scopes = typeof response?.scope === "string" ? response.scope.trim().split(/\s+/) : [];
    if (!scopes.includes(driveFileScope) || scopes.some((scope) => scope !== driveFileScope)) {
      throw new LoginTestError("scope");
    }
    const lifetime = Number(response.expires_in);
    const now = this.#clock();
    const expiresAt = now + lifetime * 1000;
    if (typeof response.access_token !== "string" || !response.access_token.trim() ||
      typeof response.token_type !== "string" || response.token_type.toLowerCase() !== "bearer" ||
      !["number", "string"].includes(typeof response.expires_in) || !Number.isFinite(lifetime) || lifetime <= 0 ||
      !Number.isFinite(now) || !Number.isFinite(expiresAt) || Math.abs(expiresAt) > 8.64e15) {
      throw new LoginTestError("response");
    }
    this.#token = response.access_token;
    this.#receivedAt = now;
    this.#expiresAt = expiresAt;
    return this.snapshot();
  }

  snapshot() {
    if (this.#receivedAt === null) return { status: "empty", receivedAt: null, expiresAt: null, remainingSeconds: 0 };
    let remainingSeconds = Math.max(0, Math.ceil((this.#expiresAt - this.#clock()) / 1000));
    const status = this.#invalid ? "invalid" : remainingSeconds > 0 && this.#token ? "valid" : "expired";
    if (status === "expired") remainingSeconds = 0;
    if (status !== "valid") this.#token = "";
    return { status, receivedAt: this.#receivedAt, expiresAt: this.#expiresAt, remainingSeconds };
  }

  accessToken() {
    if (this.snapshot().status !== "valid") throw new LoginTestError("expired");
    return this.#token;
  }

  invalidate() { this.#token = ""; this.#invalid = true; }

  clear() {
    this.#token = "";
    this.#receivedAt = null;
    this.#expiresAt = null;
    this.#invalid = false;
  }
}

export async function createTestText(session, fetcher = fetch, { now = Date.now(), signal } = {}) {
  const token = session.accessToken();
  const timestamp = new Date(now).toISOString();
  const name = `bansho-camera-login-test_${timestamp.replace(/[:.]/g, "-")}.txt`;
  const boundary = "bansho_camera_login_test_boundary";
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name, mimeType: "text/plain" }),
    `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`,
    `板書カメラ Issue #6 ログイン検証\n作成日時：${timestamp}\n画像・アカウント情報・トークンは含みません。\n`,
    `\r\n--${boundary}--\r\n`,
  ].join("");
  let response;
  try {
    response = await fetcher("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      signal,
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    throw new LoginTestError("network");
  }
  if (signal?.aborted) throw new LoginTestError("network");
  if (response.status === 401) {
    session.invalidate();
    throw new LoginTestError("expired");
  }
  if (!response.ok) throw new LoginTestError(response.status === 403 ? "forbidden" : "upload");
  try {
    const file = await response.json();
    if (typeof file.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(file.id) || file.name !== name) {
      throw new Error("invalid file metadata");
    }
    return { id: file.id, name };
  } catch {
    throw new LoginTestError("upload");
  }
}
