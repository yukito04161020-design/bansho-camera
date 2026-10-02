import test from "node:test";
import assert from "node:assert/strict";
import { createDriveFolders, DriveFolderError } from "../public/drive-folders.js";
import { TokenSession, driveFileScope } from "../public/login-logic.js";

const mimeType = "application/vnd.google-apps.folder";
const input = { className: "数学Ⅰ", capturedAt: "2026-10-02T10:00:00+09:00" };
const record = (id, name, parent, extra = {}) => ({ id, name, parent, mimeType, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const reason = (value) => (error) => error instanceof DriveFolderError && error.reason === value;
function tokenSession() {
  const session = new TokenSession(() => 0);
  session.accept({ access_token: "synthetic-only", token_type: "Bearer", expires_in: 3600, scope: driveFileScope });
  return session;
}
function fixture(initial = [], hook) {
  const files = initial.map((file) => ({ ...file }));
  const calls = [];
  const session = tokenSession();
  const unescape = (value) => value.replace(/\\([\\'])/g, "$1");
  const fetcher = async (address, options) => {
    const url = new URL(address);
    const call = { url, options };
    calls.push(call);
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, "/drive/v3/files");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic-only");
    const override = await hook?.(call, files, calls);
    if (override) return override;
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.mimeType, mimeType);
      assert.equal(body.parents.length, 1);
      const created = record(`created_${files.length}`, body.name, body.parents[0]);
      files.push(created);
      return json(created);
    }
    const q = url.searchParams.get("q");
    assert.ok(q.includes(`mimeType = '${mimeType}' and trashed = false`));
    const parent = unescape(q.match(/'((?:\\.|[^'\\])*)' in parents/)[1]);
    const nameMatch = q.match(/and name = '((?:\\.|[^'\\])*)'$/);
    const name = nameMatch ? unescape(nameMatch[1]) : undefined;
    return json({ files: files.filter((file) => file.parent === parent && file.mimeType === mimeType
      && !file.trashed && (name === undefined || file.name === name)) });
  };
  return { api: createDriveFolders({ session, fetcher }), files, calls, session };
}
const hierarchy = [record("root_id", "板書", "root"), record("class_id", "数学Ⅰ", "root_id")];
const posts = (f) => f.calls.filter((call) => call.options.method === "POST");

test("3階層があれば再利用し、別の親・種類・ゴミ箱の同名は対象にしない", async () => {
  const f = fixture([...hierarchy, record("session_id", "第01回_2026-10-02", "class_id"),
    record("other", "板書", "elsewhere"), record("trashed", "板書", "root", { trashed: true }),
    record("text", "板書", "root", { mimeType: "text/plain" })]);
  assert.deepEqual(await f.api.ensureSessionFolder(input), { name: "第01回_2026-10-02", folderId: "session_id" });
  assert.equal(posts(f).length, 0);
});

test("初回は正しい親に3階層だけ作成し、2回目は同じIDを再利用する", async () => {
  const f = fixture();
  const first = await f.api.ensureSessionFolder(input);
  assert.deepEqual(posts(f).map((call) => JSON.parse(call.options.body)), [
    { name: "板書", mimeType, parents: ["root"] },
    { name: "数学Ⅰ", mimeType, parents: ["created_0"] },
    { name: "第01回_2026-10-02", mimeType, parents: ["created_1"] },
  ]);
  assert.deepEqual(await f.api.ensureSessionFolder(input), first);
  assert.equal(posts(f).length, 3);
});

test("不足する回だけ作り、休講の期間を加算しない", async () => {
  const f = fixture([...hierarchy, record("old", "第07回_2026-09-20", "class_id"),
    record("invalid", "第99回_2026-02-30", "class_id")]);
  assert.equal((await f.api.ensureSessionFolder(input)).name, "第08回_2026-10-02");
  assert.equal(posts(f).length, 1);
});

test("全ページを取得し、空ページの後にある同日の回も見つける", async () => {
  const f = fixture(hierarchy, (call) => {
    const q = call.url.searchParams.get("q") || "";
    if (!q.includes("'class_id' in parents")) return;
    assert.equal(call.url.searchParams.get("spaces"), "drive");
    assert.equal(call.url.searchParams.get("corpora"), "user");
    const page = call.url.searchParams.get("pageToken");
    return !page ? json({ files: [], nextPageToken: "page_2" }) : json({ files: [
      record("old", "第05回_2026-10-01", "class_id"), record("today", "第06回_2026-10-02", "class_id"),
    ] });
  });
  assert.deepEqual(await f.api.suggestSession(input), { name: "第06回_2026-10-02", folderId: "today" });
  assert.equal(posts(f).length, 0);
});

test("授業一覧・存在しない授業の提案は読み取りだけ", async () => {
  const empty = fixture();
  assert.deepEqual(await empty.api.listClasses(), []);
  assert.deepEqual(await empty.api.suggestSession(input), { name: "第01回_2026-10-02", folderId: null });
  assert.equal(posts(empty).length, 0);
  const f = fixture([...hierarchy, record("invalid", "bad/name", "root_id"), record("english", "英語", "root_id")]);
  assert.deepEqual(new Set((await f.api.listClasses()).map((file) => file.name)), new Set(["数学Ⅰ", "英語"]));
  assert.equal(posts(f).length, 0);
});

test("日本時間の境目で回を提案し、手動指定と別日衝突は既存ロジックに従う", async () => {
  const f = fixture([...hierarchy, record("old", "第03回_2026-10-01", "class_id")]);
  assert.equal((await f.api.suggestSession({ ...input, capturedAt: "2026-10-01T15:00:00Z" })).name, "第04回_2026-10-02");
  assert.equal((await f.api.suggestSession({ ...input, capturedAt: "2026-10-01T14:59:59Z" })).folderId, "old");
  assert.equal((await f.api.ensureSessionFolder({ ...input, manualSession: 8 })).name, "第08回_2026-10-02");
  await assert.rejects(f.api.ensureSessionFolder({ ...input, manualSession: 3 }), (error) => error.reason === "collision");
  assert.equal(posts(f).length, 1);
});

test("引用符を含む授業名を完全一致で検索し、勝手に書き換えない", async () => {
  const className = "先生's '英語' or name = '別授業";
  const f = fixture([hierarchy[0], record("quoted", className, "root_id")]);
  await f.api.suggestSession({ ...input, className });
  assert.equal(f.calls[1].url.searchParams.get("q"),
    `mimeType = '${mimeType}' and trashed = false and 'root_id' in parents and name = '先生\\'s \\'英語\\' or name = \\'別授業'`);
  assert.equal(posts(f).length, 0);
});

test("root・授業・回の同名重複は勝手に選ばず、作成を停止する", async () => {
  for (const files of [
    [...hierarchy, record("duplicate", "板書", "root")],
    [...hierarchy, record("duplicate", "数学Ⅰ", "root_id")],
    [...hierarchy, record("s1", "第01回_2026-10-02", "class_id"), record("s2", "第01回_2026-10-02", "class_id")],
  ]) {
    const f = fixture(files);
    await assert.rejects(f.api.ensureSessionFolder(input), reason("ambiguous"));
    assert.equal(posts(f).length, 0);
  }
  const f = fixture([...hierarchy, record("duplicate", "数学Ⅰ", "root_id")]);
  await assert.rejects(f.api.listClasses(), reason("ambiguous"));
});

test("一覧の失敗・不完全な検索・循環するページ・壊れた応答から作成しない", async () => {
  for (const [value, expected] of [
    [{ files: [], incompleteSearch: true }, "incomplete"], [{}, "response"],
    [{ files: null }, "response"], [{ files: [], nextPageToken: 12 }, "response"],
    [{ files: [], incompleteSearch: "false" }, "response"],
    [{ files: [], nextPageToken: "loop" }, "incomplete"],
    [{ files: [{ id: "bad/id", name: "板書", mimeType }] }, "response"],
    [{ files: [{ id: "ok", name: "板書", mimeType: "text/plain" }] }, "response"],
  ]) {
    const f = fixture([], () => json(value));
    await assert.rejects(f.api.ensureSessionFolder(input), reason(expected));
    assert.equal(posts(f).length, 0);
  }
  const f = fixture([], () => new Response("sensitive-test-value"));
  await assert.rejects(f.api.ensureSessionFolder(input), reason("response"));
  assert.equal(posts(f).length, 0);
});

test("期限切れなら通信せず、401はセッションを無効化する", async () => {
  const f = fixture([], () => json({ error: "sensitive-test-value" }, 401));
  await assert.rejects(f.api.listClasses(), reason("authentication"));
  assert.equal(f.session.snapshot().status, "invalid");
  await assert.rejects(f.api.listClasses(), reason("authentication"));
  assert.equal(f.calls.length, 1);
  const expired = fixture();
  expired.session.clear();
  await assert.rejects(expired.api.ensureSessionFolder(input), reason("authentication"));
  assert.equal(expired.calls.length, 0);
});

test("途中のページで失敗・期限切れになっても、部分一覧から回を決定して作成しない", async () => {
  for (const expiry of [false, true]) {
    const f = fixture(hierarchy, (call) => {
      if (!(call.url.searchParams.get("q") || "").includes("'class_id' in parents")) return;
      if (!call.url.searchParams.get("pageToken")) {
        if (expiry) f.session.clear();
        return json({ files: [record("old", "第01回_2026-10-01", "class_id")], nextPageToken: "next" });
      }
      return json({ error: "sensitive-test-value" }, 503);
    });
    await assert.rejects(f.api.ensureSessionFolder(input), reason(expiry ? "authentication" : "server"));
    assert.equal(posts(f).length, 0);
  }
});

test("ページ間で同じIDを重ねて返しても重複扱いせず、名前が変わった場合は停止する", async () => {
  for (const renamed of [false, true]) {
    const f = fixture([], (call) => {
      const second = call.url.searchParams.get("pageToken");
      return json({ files: [record("root_id", second && renamed ? "別の名前" : "板書", "root")],
        ...(!second ? { nextPageToken: "next" } : {}) });
    });
    if (renamed) await assert.rejects(f.api.listClasses(), reason("response"));
    else {
      // root検索が終わった後の授業一覧にも同じページ分割を返す。
      assert.deepEqual(await f.api.listClasses(), [{ id: "root_id", name: "板書" }]);
    }
    assert.equal(posts(f).length, 0);
  }
});

test("403・429・5xx・通信失敗を固定の分類にし、外部本文や例外を漏らさない", async () => {
  for (const [status, expected] of [[403, "permission"], [429, "server"], [503, "server"], [400, "response"]]) {
    const f = fixture([], () => json({ error: "sensitive-test-value" }, status));
    await assert.rejects(f.api.listClasses(), (error) => {
      assert.ok(reason(expected)(error));
      assert.ok(!JSON.stringify(error).includes("sensitive-test-value"));
      assert.ok(!error.stack.includes("sensitive-test-value"));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const f = fixture([], () => { throw new Error("sensitive-test-value"); });
  await assert.rejects(f.api.listClasses(), reason("network"));
});

test("中断前・通信中・JSON解析中は作成や後続リクエストを始めない", async () => {
  const before = new AbortController();
  before.abort();
  const f = fixture();
  await assert.rejects(f.api.ensureSessionFolder(input, { signal: before.signal }), reason("cancelled"));
  assert.equal(f.calls.length, 0);
  for (const stage of ["fetch", "json"]) {
    const controller = new AbortController();
    const pending = fixture([], (call) => {
      assert.equal(call.options.signal, controller.signal);
      if (stage === "fetch") { controller.abort(); return json({ files: [] }); }
      return { ok: true, status: 200, async json() { controller.abort(); return { files: [] }; } };
    });
    await assert.rejects(pending.api.ensureSessionFolder(input, { signal: controller.signal }), reason("cancelled"));
    assert.equal(pending.calls.length, 1);
    assert.equal(posts(pending).length, 0);
  }
});

test("同時の同日依頼は直列化し、3階層を重複して作らない", async () => {
  const f = fixture();
  const results = await Promise.all([f.api.ensureSessionFolder(input), f.api.ensureSessionFolder(input), f.api.ensureSessionFolder(input)]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.equal(posts(f).length, 3);
});

test("作成の応答が失われても自動でPOSTを重ねず、次の依頼で既存を再検索する", async () => {
  let lost = false;
  const f = fixture([], (call, files) => {
    if (call.options.method === "POST" && !lost) {
      lost = true;
      const body = JSON.parse(call.options.body);
      files.push(record("created_before_disconnect", body.name, body.parents[0]));
      throw new Error("connection lost");
    }
  });
  await assert.rejects(f.api.ensureSessionFolder(input), reason("network"));
  assert.equal(posts(f).length, 1);
  await f.api.ensureSessionFolder(input);
  assert.equal(posts(f).length, 3);
  assert.equal(f.files.filter((file) => file.name === "板書").length, 1);
});

test("不正な作成応答を成功扱いせず、後続階層を作らない", async () => {
  const f = fixture([], (call) => call.options.method === "POST" ? json(record("id", "別の名前", "root")) : undefined);
  await assert.rejects(f.api.ensureSessionFolder(input), reason("response"));
  assert.equal(posts(f).length, 1);
});

test("不正な入力は通信前に拒否し、作成待機中の引数変更に影響されない", async () => {
  const f = fixture();
  assert.throws(() => f.api.ensureSessionFolder({ ...input, className: "bad/name" }));
  await assert.rejects(f.api.suggestSession({ ...input, capturedAt: "2026-10-02" }));
  assert.equal(f.calls.length, 0);
  const date = new Date(input.capturedAt);
  const mutable = { ...input, capturedAt: date };
  const pending = f.api.ensureSessionFolder(mutable);
  mutable.className = "別授業";
  date.setUTCFullYear(2030);
  assert.equal((await pending).name, "第01回_2026-10-02");
  assert.equal(f.files[1].name, input.className);
});
