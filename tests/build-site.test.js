import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "../scripts/build-site.js";

test("公開物に同じコミットの版情報とキャッシュ回避用URLを埋め込む", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "bansho-build-"));
  const revision = "1234567890abcdef1234567890abcdef12345678";
  try {
    await buildSite({ revision, sourceDirectory: fileURLToPath(new URL("../public", import.meta.url)), outputDirectory });
    assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, "version.json"), "utf8")), { version: revision });
    for (const page of ["index.html", "camera.html", "camera-test.html", "login-test.html"]) {
      const html = await readFile(join(outputDirectory, page), "utf8");
      assert.ok(html.includes(`name="app-version" content="${revision}"`));
      assert.ok(html.includes("data-app-version>1234567</span>"));
      assert.equal(html.includes("開発版"), false);
      for (const asset of html.matchAll(/(?:src|href)=["'](\.\/[^"']+\.(?:js|css|png|webmanifest)(?:\?[^"']*)?)["']/g)) {
        assert.ok(asset[1].endsWith(`?v=${revision}`), asset[1]);
      }
    }
    for (const file of ["home.js", "app-update.js", "camera-preview.js", "camera-options.js", "login-preview.js",
      "capture-app.js", "capture-save.js", "drive-upload.js", "upload-store.js"]) {
      const script = await readFile(join(outputDirectory, file), "utf8");
      for (const dependency of script.matchAll(/from ["']([^"']+)["']/g)) {
        assert.ok(dependency[1].endsWith(`?v=${revision}`), dependency[1]);
      }
    }
    assert.equal((await readdir(outputDirectory)).includes("tests"), false);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("不正な版番号は公開物に埋め込まない", async () => {
  await assert.rejects(buildSite({ revision: "invalid" }), /40桁/);
});
