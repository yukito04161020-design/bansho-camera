import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export async function buildSite({ revision, sourceDirectory, outputDirectory }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("公開版には40桁のコミットIDが必要です。");
  await mkdir(outputDirectory, { recursive: true });
  await cp(sourceDirectory, outputDirectory, { recursive: true });
  async function stamp(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await stamp(path);
      } else if (entry.name.endsWith(".html")) {
        const source = await readFile(path, "utf8");
        const html = source
          .replace('name="app-version" content="development"', `name="app-version" content="${revision}"`)
          .replaceAll('data-app-version>開発版</span>', `data-app-version>${revision.slice(0, 7)}</span>`)
          .replace(/((?:src|href)=["'])(\.\/[^"']+\.(?:js|css|webmanifest|png))(["'])/g, `$1$2?v=${revision}$3`);
        await writeFile(path, html);
      } else if (entry.name.endsWith(".js")) {
        const source = await readFile(path, "utf8");
        await writeFile(path, source.replace(/(\bfrom\s+["'])(\.\/[^"']+\.js)(["'])/g, `$1$2?v=${revision}$3`));
      }
    }
  }
  await stamp(outputDirectory);
  await writeFile(join(outputDirectory, "version.json"), JSON.stringify({ version: revision }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const revision = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await buildSite({ revision, sourceDirectory: join(root, "public"), outputDirectory: join(root, "dist") });
  console.log(`公開版 ${revision.slice(0, 7)} をdistに出力しました。`);
}
