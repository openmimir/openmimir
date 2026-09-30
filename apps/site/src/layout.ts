// Shared layout for the generated pages (guides, the blog post, the guides index).

export const SITE = "https://openmimir.com";
export const INSTALL = "curl -fsSL https://openmimir.com/install.sh | bash";

export interface Faq {
  q: string;
  a: string;
}

export interface Page {
  /** URL path without a trailing slash, e.g. "/claude-code-voice". */
  path: string;
  /** The <title>, around 50-60 characters. */
  title: string;
  /** Meta description, around 150 characters. */
  description: string;
  /** Small label above the headline. */
  eyebrow: string;
  h1: string;
  lead: string;
  /** Article HTML. */
  body: string;
  faq?: Faq[];
  /** Set on blog posts, so they get Article markup and a date. */
  published?: string;
  /** Shown in the guides index. */
  summary: string;
}

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const strip = (html: string) => html.replace(/<[^>]+>/g, "");

export function nav(): string {
  return `<header class="nav">
      <div class="nav-inner">
        <a class="brand" href="/">
          <img src="/favicon.svg" alt="" width="26" height="26" />
          OpenMimir
        </a>
        <nav>
          <a href="/#agents">Agents</a>
          <a href="/guides">Guides</a>
          <a href="/#faq">FAQ</a>
          <a class="gh" href="https://github.com/openmimir/openmimir">GitHub</a>
        </nav>
      </div>
    </header>`;
}

export function footer(): string {
  return `<footer>
      <span>OpenMimir · MIT licensed</span>
      <a href="/guides">Guides</a>
      <a href="https://github.com/openmimir/openmimir">GitHub</a>
      <a href="https://github.com/openmimir/openmimir/blob/main/SECURITY.md">Security</a>
    </footer>`;
}

export function installBox(): string {
  return `<div class="install">
          <span class="prompt">$</span>
          <code>${INSTALL}</code>
          <button type="button" class="copy2" aria-label="Copy install command">Copy</button>
        </div>`;
}

function jsonLd(page: Page): string {
  const graph: Record<string, unknown>[] = [
    {
      "@type": page.published ? "BlogPosting" : "TechArticle",
      headline: page.h1,
      description: page.description,
      url: SITE + page.path,
      ...(page.published ? { datePublished: page.published } : {}),
      publisher: { "@type": "Organization", name: "OpenMimir", url: SITE },
      about: { "@type": "SoftwareApplication", name: "OpenMimir", url: SITE },
    },
  ];
  if (page.faq?.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: page.faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: strip(f.a) },
      })),
    });
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
}

export function render(page: Page, related: Page[]): string {
  const url = SITE + page.path;
  const faq = page.faq?.length
    ? `<section class="faq doc-faq">
          <h2>Questions</h2>
          ${page.faq.map((f) => `<details><summary>${f.q}</summary><p>${f.a}</p></details>`).join("\n          ")}
        </section>`
    : "";
  const more = related.length
    ? `<section class="related">
          <h2>More guides</h2>
          <div class="related-grid">
            ${related.map((r) => `<a href="${r.path}"><b>${r.h1}</b><span>${r.summary}</span></a>`).join("\n            ")}
          </div>
        </section>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(page.title)}</title>
    <meta name="description" content="${esc(page.description)}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:title" content="${esc(page.title)}" />
    <meta property="og:description" content="${esc(page.description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:type" content="article" />
    <meta property="og:image" content="${SITE}/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="theme-color" content="#07090a" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/style.css" />
    <script type="application/ld+json">${jsonLd(page)}</script>
  </head>
  <body>
    <div class="backdrop" aria-hidden="true"></div>
    ${nav()}
    <main class="doc">
      <article>
        <p class="eyebrow">${page.eyebrow}</p>
        <h1>${page.h1}</h1>
        <p class="lead">${page.lead}</p>
        ${page.published ? `<p class="date">${new Date(page.published).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>` : ""}
        <div class="prose">
          ${page.body.trim()}
        </div>
        <section class="cta doc-cta">
          <h2>Try OpenMimir</h2>
          <p>Free and open source. Runs on your Mac with your own API keys.</p>
          ${installBox()}
        </section>
        ${faq}
        ${more}
      </article>
    </main>
    ${footer()}
    <script src="/site.js" defer></script>
  </body>
</html>
`;
}

export function renderIndex(pages: Page[]): Page {
  const guides = pages.filter((p) => !p.published);
  const posts = pages.filter((p) => p.published);
  const card = (p: Page) => `<a href="${p.path}"><b>${p.h1}</b><span>${p.summary}</span></a>`;
  return {
    path: "/guides",
    title: "Guides · OpenMimir",
    description:
      "Guides for steering Claude Code, Codex and OpenCode by voice, from your phone or iPad, and while you train, walk or ride.",
    eyebrow: "Guides",
    h1: "Guides",
    lead: "How to talk to your coding agents, check on them from anywhere, and keep working while you move.",
    summary: "",
    body: `<div class="related-grid">
            ${guides.map(card).join("\n            ")}
          </div>
          <h2>Stories</h2>
          <div class="related-grid">
            ${posts.map(card).join("\n            ")}
          </div>`,
  };
}
