import assert from "node:assert/strict";
import test from "node:test";
import { createTestText, driveFileScope, LoginTestError, TokenSession, tokenClientOptions } from "../public/login-logic.js";

const fakeToken = "synthetic-test-value-not-a-real-credential";
const response = (overrides = {}) => ({ access_token: fakeToken, token_type: "Bearer", scope: driveFileScope, expires_in: 3600, ...overrides });
const reason = (expected) => (error) => error instanceof LoginTestError && error.reason === expected && !error.message.includes(fakeToken);

test("ログインはdrive.fileだけを要求し、以前の別の許可を含めない", () => {
  const callback = () => {};
  const errorCallback = () => {};
  assert.deepEqual(tokenClientOptions("public-client-id", callback, errorCallback), {
    client_id: "public-client-id", scope: "https://www.googleapis.com/auth/drive.file",
    include_granted_scopes: false, callback, error_callback: errorCallback,
  });
});

test("トークン取得時刻・期限を返し、表示用の状態にトークンを含めない", () => {
  const session = new TokenSession(() => 1000);
  assert.equal(session.snapshot().status, "empty");
  assert.deepEqual(session.accept(response()), { status: "valid", receivedAt: 1000, expiresAt: 3601000, remainingSeconds: 3600 });
  assert.equal(session.accessToken(), fakeToken);
  assert.equal(JSON.stringify(session.snapshot()).includes(fakeToken), false);
  assert.equal(JSON.stringify(session).includes(fakeToken), false);
});

test("裏でタイマーが動かなくても実時刻で期限を判定し、期限時刻から送信を止める", () => {
  let now = 1000;
  const session = new TokenSession(() => now);
  session.accept(response({ expires_in: "3600" }));
  now = 3600999;
  assert.equal(session.snapshot().remainingSeconds, 1);
  now = 3601000;
  assert.deepEqual(session.snapshot(), { status: "expired", receivedAt: 1000, expiresAt: 3601000, remainingSeconds: 0 });
  assert.throws(() => session.accessToken(), reason("expired"));
  now = 7201000;
  assert.equal(session.snapshot().remainingSeconds, 0);
  now = 1000;
  assert.equal(session.snapshot().status, "expired");
  assert.throws(() => session.accessToken(), reason("expired"));
});

test("取り直しで時刻と期限を更新し、画面を閉じたらトークンを失う", () => {
  let now = 1000;
  const session = new TokenSession(() => now);
  session.accept(response());
  now = 4000000;
  session.accept(response({ access_token: "replacement-fake-value", expires_in: 1800 }));
  assert.equal(session.snapshot().receivedAt, now);
  assert.equal(session.snapshot().expiresAt, now + 1800000);
  assert.equal(session.accessToken(), "replacement-fake-value");
  session.clear();
  assert.equal(session.snapshot().status, "empty");
  assert.throws(() => session.accessToken(), reason("expired"));
});

test("許可拒否・別権限・不足権限はトークンを採用しない", () => {
  for (const [value, expected] of [[response({ error: "access_denied" }), "authorization"],
    [response({ scope: "" }), "scope"],
    [response({ scope: `${driveFileScope} https://www.googleapis.com/auth/drive` }), "scope"],
    [null, "scope"]]) {
    const session = new TokenSession(() => 1000);
    session.accept(response());
    assert.throws(() => session.accept(value), reason(expected));
    assert.equal(session.snapshot().status, "empty");
    assert.throws(() => session.accessToken(), reason("expired"));
  }
});

test("トークンや有効期限の不正値を拒否する", () => {
  for (const value of [response({ access_token: "" }), response({ token_type: 7 }), response({ token_type: "unknown" }),
    ...[0, -1, NaN, Infinity, "bad", true, undefined].map((expires_in) => response({ expires_in }))]) {
    const session = new TokenSession(() => 1000);
    assert.throws(() => session.accept(value), reason("response"));
  }
});

function activeSession() {
  const now = Date.parse("2026-09-30T01:00:00Z");
  const session = new TokenSession(() => now);
  session.accept(response());
  return { session, now };
}

test("有効なトークンで固定のDrive APIにテキストと名前を1回だけ送る", async () => {
  const { session, now } = activeSession();
  let calls = 0;
  const name = "bansho-camera-login-test_2026-09-30T01-00-00-000Z.txt";
  const file = await createTestText(session, async (url, request) => {
    calls++;
    assert.equal(url, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, `Bearer ${fakeToken}`);
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.match(request.headers["Content-Type"], /^multipart\/related; boundary=/);
    assert.match(request.body, new RegExp(name.replaceAll(".", "\\.")));
    assert.match(request.body, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(request.body, /Issue #6/);
    assert.equal(request.body.includes(fakeToken), false);
    assert.ok(request.body.endsWith("--bansho_camera_login_test_boundary--\r\n"));
    return { ok: true, status: 200, json: async () => ({ id: "test-file-id", name }) };
  }, { now });
  assert.deepEqual(file, { id: "test-file-id", name });
  assert.equal(calls, 1);
});

test("期限切れのトークンでは通信しない", async () => {
  const session = new TokenSession();
  await assert.rejects(createTestText(session, () => assert.fail("通信しない")), reason("expired"));
});

test("401でトークンを無効にし、取り直すまで次の通信を止める", async () => {
  const { session, now } = activeSession();
  await assert.rejects(createTestText(session, async () => ({ ok: false, status: 401 }), { now }), reason("expired"));
  assert.equal(session.snapshot().status, "invalid");
  await assert.rejects(createTestText(session, () => assert.fail("通信しない")), reason("expired"));
  session.accept(response());
  assert.equal(session.snapshot().status, "valid");
});

test("403・失敗・通信断は秘密情報を返さず、自動で再送しない", async () => {
  for (const [status, expected] of [[403, "forbidden"], [500, "upload"]]) {
    const { session, now } = activeSession();
    let calls = 0;
    await assert.rejects(createTestText(session, async () => { calls++; return { ok: false, status }; }, { now }), reason(expected));
    assert.equal(calls, 1);
  }
  const { session, now } = activeSession();
  await assert.rejects(createTestText(session, async () => { throw new Error(fakeToken); }, { now }), reason("network"));
});

test("成功応答でも不正なファイル情報や壊れたJSONは成功扱いしない", async () => {
  const { session, now } = activeSession();
  for (const json of [async () => ({ id: "../other", name: "wrong" }), async () => ({}), async () => { throw new Error(fakeToken); }]) {
    await assert.rejects(createTestText(session, async () => ({ ok: true, status: 200, json }), { now }), reason("upload"));
  }
});

test("画面を閉じて中断した要求の401は、新しいセッションを無効にしない", async () => {
  const { session, now } = activeSession();
  const controller = new AbortController();
  let finish;
  const pending = createTestText(session, () => new Promise((resolve) => { finish = resolve; }), { now, signal: controller.signal });
  controller.abort();
  session.clear();
  session.accept(response({ access_token: "new-fake-value" }));
  finish({ ok: false, status: 401 });
  await assert.rejects(pending, reason("network"));
  assert.equal(session.accessToken(), "new-fake-value");
});
