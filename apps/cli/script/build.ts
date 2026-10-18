/**
 * Builds the distributable `openmimir` package:
 *  - dist/index.js       single-file bundle for `bunx openmimir` / npm
 *  - dist/web/           the web UI
 *  - dist/bin/<platform>/ standalone binaries (mimir or mimir.exe, plus web/), e.g.
 *                        darwin-arm64, windows-x64. Set MIMIR_TARGETS to choose; "" builds none.
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
// npm shows the README from the package folder; keep the repo root as the source of truth.
for (const file of ["README.md", "LICENSE"]) cpSync(join(root, "../..", file), join(root, file));
console.log("bundle  dist/index.js + dist/web");

const pkg = (await Bun.file(join(root, "package.json")).json()) as { version: string };

/** `bun-windows-x64-baseline` -> `windows-x64`: the folder and release asset name. */
function platformName(target: string): string {
  return target.replace(/^bun-/, "").replace(/-(baseline|modern)$/, "");
}

/**
 * Icon and file details for mimir.exe, so Windows shows OpenMimir in Explorer, Task
 * Manager and the firewall prompt. Bun can only add these when it runs on Windows.
 */
function windowsDetails(): string[] {
  if (process.platform !== "win32") return [];
  const [major = "0", minor = "0", patch = "0"] = pkg.version.split(/[.-]/);
  return [
    `--windows-icon=${join(root, "assets", "mimir.ico")}`,
    "--windows-title=OpenMimir",
    "--windows-publisher=OpenMimir contributors",
    `--windows-version=${major}.${minor}.${patch}.0`,
    "--windows-description=OpenMimir: one conversation for all your coding agents",
    "--windows-copyright=MIT License",
  ];
}

const defaultTargets =
  process.platform === "win32" ? "bun-windows-x64-baseline" : "bun-darwin-arm64,bun-darwin-x64";
const targets = (process.env.MIMIR_TARGETS ?? defaultTargets).split(",").filter(Boolean);
for (const target of targets) {
  const name = platformName(target);
  const windows = name.startsWith("windows-");
  const out = join(dist, "bin", name);
  const exe = windows ? "mimir.exe" : "mimir";
  mkdirSync(out, { recursive: true });
  const details = windows ? windowsDetails() : [];
  await $`bun build ${join(root, "src/index.ts")} --compile --target=${target} ${details} --outfile ${join(out, exe)}`.quiet();
  cpSync(web, join(out, "web"), { recursive: true });
  console.log(`binary  dist/bin/${name}/${exe}${details.length ? " (with icon and file details)" : ""}`);
}
