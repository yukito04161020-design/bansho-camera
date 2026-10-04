import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("実画像の未指定・存在しない場所・正解データなしでは測定をスキップ", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corner-measure-"));
  try {
    for (const directory of ["", join(dir, "missing"), dir]) {
      const output = execFileSync(process.execPath, ["scripts/measure-corners.js"], { env: { ...process.env, CORNER_SAMPLES_DIR: directory }, encoding: "utf8" });
      assert.match(output, /SKIP:/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
