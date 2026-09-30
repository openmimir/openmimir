/**
 * Builds the distributable `openmimir` package:
 *  - dist/index.js       single-file bundle for `bunx openmimir` / npm
 *  - dist/web/           the web UI
 *  - dist/bin/<target>/  standalone macOS binaries (mimir + web/) for Homebrew
 *
 * Run from the repo root with `bun run build` (it builds the web UI first).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const web = join(root, "../web/dist");

if (!existsSync(join(web, "index.html"))) {
  console.error("Build the web UI first: bun run --filter @openmimir/web build");
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const bundle = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir: dist,
  target: "bun",
  minify: false,
  sourcemap: "linked",
});
if (!bundle.success) {
  for (const message of bundle.logs) console.error(message);
  process.exit(1);
}
cpSync(web, join(dist, "web"), { recursive: true });
console.log("bundle  dist/index.js + dist/web");

const targets = (process.env.MIMIR_TARGETS ?? "bun-darwin-arm64,bun-darwin-x64").split(",").filter(Boolean);
for (const target of targets) {
  const out = join(dist, "bin", target.replace(/^bun-/, ""));
  mkdirSync(out, { recursive: true });
  await $`bun build ${join(root, "src/index.ts")} --compile --target=${target} --outfile ${join(out, "mimir")}`.quiet();
  cpSync(web, join(out, "web"), { recursive: true });
  console.log(`binary  dist/bin/${target.replace(/^bun-/, "")}/mimir`);
}
