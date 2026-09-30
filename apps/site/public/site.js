// Copy buttons
for (const button of document.querySelectorAll("#copy, .copy2")) {
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText("curl -fsSL https://openmimir.com/install.sh | bash");
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
  });
}

// Fade sections in as they scroll into view
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      observer.unobserve(entry.target);
    }
  },
  { threshold: 0.12 },
);
document.querySelectorAll(".reveal").forEach((el, i) => {
  el.style.setProperty("--d", `${(i % 4) * 70}ms`);
  observer.observe(el);
});

// The demo: a short voice conversation that plays on a loop
const demo = document.getElementById("demo");
const caption = document.getElementById("caption");
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const icon = (agent) => `<img src="/icons/${agent}.svg" alt="" />`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reduced ? 0 : ms));

function add(html, className) {
  const el = document.createElement("div");
  el.className = `msg ${className}`;
  el.innerHTML = html;
  demo.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  return el;
}

async function say(text) {
  // Live caption first, word by word, then it lands in the chat as the user's bubble.
  caption.classList.add("hearing");
  caption.textContent = "";
  for (const word of text.split(" ")) {
    caption.textContent += (caption.textContent ? " " : "") + word;
    await wait(120);
  }
  await wait(350);
  caption.classList.remove("hearing");
  caption.textContent = "Listening…";
  add(`<span class="src">🎙</span>${text}`, "user");
  await wait(700);
}

const reply = async (text, pause = 1400) => {
  add(text, "mimir");
  await wait(pause);
};

const session = (agent, label, title, project) =>
  add(
    `${icon(agent)}<div><span class="step-label">${label}</span> <b>${title}</b><small>${project} · <span class="state"><span class="st st-work"></span>Working</span></small></div>`,
    "step",
  );

async function play() {
  demo.innerHTML = "";
  await wait(600);
  await say("How's the billing refactor going?");
  session("codex", "Checked", "Billing refactor", "api · Codex");
  await wait(900);
  await reply("Codex is on the last migration. Tests pass so far.");
  await say("Nice. Have Claude fix the flaky login test.");
  await reply("I'll start Claude Code in web-app to fix the flaky login test. Go ahead?", 1200);
  await say("Yes.");
  const claude = session("claude", "Started", "Fix flaky login test", "web-app · Claude Code");
  await wait(2600);
  claude.querySelector(".state").innerHTML = '<span class="st st-done"></span>Finished';
  claude.classList.add("done");
  await wait(700);
  await reply(
    "Done. The test raced the session cookie. Claude added an await and it passed 50 runs in a row.",
    4200,
  );
  demo.classList.add("fade");
  await wait(700);
  demo.classList.remove("fade");
  if (!reduced) play();
}

if (demo) play();
