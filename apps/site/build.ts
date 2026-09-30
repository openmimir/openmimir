// Builds openmimir.com into dist/: copies public/ and renders the guides, sitemap and llms.txt.
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Page, render, renderIndex, SITE } from "./src/layout";
import { pages } from "./src/pages";

const root = import.meta.dir;
const out = join(root, "dist");

await rm(out, { recursive: true, force: true });
await cp(join(root, "public"), out, { recursive: true });

async function write(path: string, html: string) {
  // "/blog/x" -> dist/blog/x.html, served at /blog/x
  const file = join(out, `${path.slice(1)}.html`);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, html);
}

const guides = pages.filter((p) => !p.published);
for (const page of pages) {
  const related = guides.filter((p) => p.path !== page.path).slice(0, 4);
  await write(page.path, render(page, related));
}
const index = renderIndex(pages);
await write(index.path, render(index, []));

const all: Page[] = [index, ...pages];
const today = new Date().toISOString().slice(0, 10);
await Bun.write(
  join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><lastmod>${today}</lastmod></url>
${all.map((p) => `  <url><loc>${SITE}${p.path}</loc><lastmod>${p.published ?? today}</lastmod></url>`).join("\n")}
</urlset>
`,
);

await Bun.write(
  join(out, "llms.txt"),
  `# OpenMimir

> OpenMimir is a free, open-source (MIT) app for macOS that puts one conversation in front of all your coding agents: Claude Code, Codex and OpenCode. You can type to it or talk to it with full-duplex voice, from your desk, a phone or iPad, or an indoor trainer. It sees every existing session, starts new work, reports results back, and keeps risky commands behind an on-screen approval. It runs locally with your own API keys.

Install: \`curl -fsSL https://openmimir.com/install.sh | bash\`
Source: https://github.com/openmimir/openmimir

## Guides

${all
  .filter((p) => p.path !== "/guides")
  .map((p) => `- [${p.h1}](${SITE}${p.path}): ${p.summary}`)
  .join("\n")}
`,
);

console.log(`site: ${all.length + 1} pages -> dist/`);
