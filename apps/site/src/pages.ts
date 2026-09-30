import type { Page } from "./layout";

// Each guide targets one search intent (see the comment above each page).
// Keep claims about other products to what their own docs say, and link to them.

const CLAUDE_VOICE_DOCS = "https://code.claude.com/docs/en/voice-dictation";
const CLAUDE_RC_DOCS = "https://code.claude.com/docs/en/remote-control";
const CODEX_REMOTE_DOCS = "https://learn.chatgpt.com/docs/remote";

const phoneSetup = `<h2>Setting it up on a phone or iPad</h2>
          <p>OpenMimir runs on your Mac and serves its interface to any browser. Browsers only allow the microphone on
          HTTPS, so put your Mac on a private network with an HTTPS name, and pair the device once:</p>
          <ol>
            <li>Install and start OpenMimir on the Mac: <code>mimir init</code>, then <code>mimir</code>.</li>
            <li>Expose it privately, for example with Tailscale Serve (<code>tailscale serve --bg 4747</code>) or a
            Cloudflare Tunnel with access control.</li>
            <li>Run <code>mimir pair</code> and open the link on your phone or iPad. Add it to the home screen.</li>
          </ol>
          <p>Your Mac has to stay on and awake, since that is where the agents run.</p>`;

export const pages: Page[] = [
  // claude code voice (720), claude code voice mode (720), claude code voice input (210), speech to text (70)
  {
    path: "/claude-code-voice",
    title: "Claude Code voice mode, hands-free and full duplex · OpenMimir",
    description:
      "Talk to Claude Code like a colleague: full-duplex voice, live captions and spoken reports. How OpenMimir compares to Claude Code's built-in /voice dictation.",
    eyebrow: "Claude Code · Voice",
    h1: "Talk to Claude Code, hands-free",
    lead: "Claude Code's built-in voice turns speech into a prompt. OpenMimir goes one step further: a spoken conversation that starts work, follows it, and tells you out loud what happened.",
    summary: "Built-in /voice dictation vs a full spoken conversation with your sessions.",
    body: `
          <h2>What Claude Code's built-in voice does</h2>
          <p>Claude Code has <a href="${CLAUDE_VOICE_DOCS}">voice dictation</a>: run <code>/voice</code>, then hold or tap
          Space and speak. Your words are transcribed into the prompt, tuned for coding terms. It is great at your desk. It
          needs a claude.ai account (not an API key), a local microphone, and you still read the answers on screen.</p>

          <h2>What OpenMimir adds</h2>
          <p>OpenMimir is a single conversation that sits in front of all your Claude Code sessions (and Codex and OpenCode,
          if you use them). You talk to it, it talks back, and it drives the sessions for you.</p>
          <ul>
            <li><b>Full duplex.</b> It listens while it speaks, so you can interrupt. There is no key to hold.</li>
            <li><b>Spoken results.</b> When a session finishes, OpenMimir reads the reply and tells you the outcome in a
            sentence or two instead of making you read a transcript.</li>
            <li><b>No ids, no picking.</b> "How's the billing refactor?" finds the right session, including ones you started
            yourself in the terminal last week.</li>
            <li><b>Read-back before work.</b> Before it starts or redirects anything by voice, it repeats the plan and waits
            for your "yes".</li>
            <li><b>Live captions.</b> What it heard is on screen as you speak, so a mishearing is obvious.</li>
            <li><b>Approvals stay safe.</b> Pushes, deploys and <code>rm -rf</code> need a tap on the screen; voice can't
            approve them.</li>
          </ul>

          <h2>Which one to use</h2>
          <table>
            <thead><tr><th></th><th>Claude Code <code>/voice</code></th><th>OpenMimir</th></tr></thead>
            <tbody>
              <tr><td>Input</td><td>Dictation into the prompt</td><td>Spoken conversation</td></tr>
              <tr><td>Output</td><td>Text in the terminal</td><td>Spoken summary plus captions</td></tr>
              <tr><td>Hands</td><td>Hold or tap a key</td><td>Hands-free</td></tr>
              <tr><td>Sessions</td><td>The one you're in</td><td>All of them, across agents</td></tr>
              <tr><td>Auth</td><td>claude.ai account</td><td>Whatever your Claude Code uses; OpenAI key for voice</td></tr>
            </tbody>
          </table>
          <p>They work well together: dictate at the desk, and switch to OpenMimir when you step away, ride the trainer
          or walk.</p>

          <h2>How it works</h2>
          <p>Voice runs on OpenAI's realtime model with your own key, straight from your browser. A separate model plans
          what to do and calls Claude Code headless (<code>claude -p --resume</code>), so the conversation continues in
          the same session. You can open it later with <code>claude --resume</code> and see everything that happened.</p>`,
    faq: [
      {
        q: "Does Claude Code have a voice mode?",
        a: `Yes, <code>/voice</code> dictation: speech becomes the prompt. It doesn't speak answers back. OpenMimir adds a two-way spoken conversation on top.`,
      },
      {
        q: "Can I use OpenMimir with a Claude API key instead of a subscription?",
        a: "Yes. OpenMimir calls the Claude Code CLI you already have, with whatever login it uses. Voice itself uses your OpenAI key.",
      },
      {
        q: "What does voice cost?",
        a: "Around $0.05 per minute of conversation with OpenAI's realtime model, paid directly to OpenAI. OpenMimir itself is free.",
      },
    ],
  },

  // claude code remote control (3600), claude code remote (1600), claude code mobile (1000), iphone (140), android (210)
  {
    path: "/claude-code-remote-control",
    title: "Claude Code Remote Control alternative: by voice, all sessions · OpenMimir",
    description:
      "Steer Claude Code from your phone or iPad without reading a terminal. How OpenMimir compares to Claude Code Remote Control, and when to use each.",
    eyebrow: "Claude Code · Remote",
    h1: "Steer Claude Code from your phone, by voice",
    lead: "Remote Control puts one Claude Code session on your phone. OpenMimir puts all of them behind one conversation you can talk to.",
    summary: "Remote Control vs OpenMimir, and how to use Claude Code from a phone or iPad.",
    body: `
          <h2>What Remote Control does</h2>
          <p>Anthropic's <a href="${CLAUDE_RC_DOCS}">Remote Control</a> connects the Claude app or claude.ai/code to a
          Claude Code session running on your machine. You see the conversation, send messages, look at diffs and get
          push notifications. It needs a Pro, Max, Team or Enterprise plan (API keys aren't supported), and you start it
          per session with <code>/remote-control</code> or run a server with <code>claude remote-control</code>.</p>
          <p>If you want to read a diff on the couch, it is excellent.</p>

          <h2>Where OpenMimir is different</h2>
          <ul>
            <li><b>Every session, no setup per session.</b> OpenMimir reads Claude Code's history directly, so it already
            knows the sessions you started in the terminal, including old ones. Nothing to enable first.</li>
            <li><b>Talk instead of type.</b> Full-duplex voice with live captions. Useful when your hands or eyes are busy:
            on a trainer, a treadmill, cooking, walking the dog.</li>
            <li><b>Summaries instead of transcripts.</b> Ask "is the migration done?" and get one sentence back.</li>
            <li><b>Not only Claude.</b> The same conversation covers Codex and OpenCode sessions.</li>
            <li><b>Your keys, your machine.</b> Works with API keys. Everything except the model calls stays on your Mac.</li>
          </ul>

          <table>
            <thead><tr><th></th><th>Remote Control</th><th>OpenMimir</th></tr></thead>
            <tbody>
              <tr><td>Scope</td><td>One session per connection (more in server mode)</td><td>All sessions, all agents</td></tr>
              <tr><td>Interaction</td><td>Chat and diffs in the Claude app</td><td>Voice or text, big trainer view</td></tr>
              <tr><td>Setup</td><td>Enable per session or run a server</td><td>Install once, pair a device once</td></tr>
              <tr><td>Plan</td><td>Claude subscription</td><td>Any Claude Code login, plus an OpenAI key</td></tr>
              <tr><td>Cost</td><td>Included in the plan</td><td>Free and open source; voice about $0.05/min</td></tr>
            </tbody>
          </table>

          ${phoneSetup}

          <h2>Using both</h2>
          <p>They don't conflict. Use OpenMimir to talk through what's going on and send instructions, and open Remote
          Control or your terminal when you want to read the actual code.</p>`,
    faq: [
      {
        q: "Can I use Claude Code on my phone?",
        a: "Yes. Anthropic's Remote Control shows a running session in the Claude app. OpenMimir lets you talk to all your sessions from a phone or iPad browser.",
      },
      {
        q: "Does OpenMimir need Remote Control turned on?",
        a: "No. It reads Claude Code's local session history and continues sessions through the Claude Code CLI.",
      },
      {
        q: "Does my code leave my Mac?",
        a: "Your code stays where Claude Code runs. OpenMimir sends your requests to the model provider you choose and audio to OpenAI's voice model, and has no telemetry.",
      },
    ],
  },

  // codex remote control (1300), codex mobile (1300), codex cli remote control (210), codex iphone (140)
  {
    path: "/codex-remote-control",
    title: "Codex remote control by voice, from your phone or iPad · OpenMimir",
    description:
      "Check on Codex and send it new instructions from your phone, hands-free. How OpenMimir compares to Codex Remote in the ChatGPT app.",
    eyebrow: "Codex · Remote",
    h1: "Control Codex from your phone, by voice",
    lead: "Start Codex tasks, ask how they're going and hear the result, without opening a terminal or reading a diff on a small screen.",
    summary: "Codex Remote vs OpenMimir, and how to use the Codex CLI from a phone.",
    body: `
          <h2>What Codex Remote does</h2>
          <p>OpenAI's <a href="${CODEX_REMOTE_DOCS}">Codex Remote</a> connects the ChatGPT mobile app to the ChatGPT
          desktop app on your computer. From your phone you can start tasks, follow progress, approve actions and review
          diffs. It's the right tool if you live in the ChatGPT app.</p>

          <h2>Where OpenMimir fits</h2>
          <ul>
            <li><b>Works with the Codex CLI.</b> OpenMimir reads the sessions in <code>~/.codex/sessions</code>, so it
            sees threads you ran in the terminal, and continues them with <code>codex exec resume</code>.</li>
            <li><b>Voice first.</b> Ask "what did Codex find in the auth review?" and hear a two-sentence answer.</li>
            <li><b>One place for every agent.</b> If you also use Claude Code or OpenCode, the same conversation covers
            those sessions. You never have to say which agent.</li>
            <li><b>Reports back on its own.</b> When a task it started finishes, OpenMimir tells you the outcome.</li>
          </ul>

          <table>
            <thead><tr><th></th><th>Codex Remote</th><th>OpenMimir</th></tr></thead>
            <tbody>
              <tr><td>Works with</td><td>ChatGPT desktop app</td><td>Codex CLI, Claude Code, OpenCode</td></tr>
              <tr><td>Interaction</td><td>Tasks, approvals and diffs in the app</td><td>Voice or text conversation</td></tr>
              <tr><td>Account</td><td>ChatGPT account</td><td>Your own API keys</td></tr>
            </tbody>
          </table>

          ${phoneSetup}`,
    faq: [
      {
        q: "Can I use Codex from my phone?",
        a: "Yes. Codex Remote does it through the ChatGPT app. OpenMimir does it by voice or text in a browser, for Codex CLI sessions.",
      },
      {
        q: "Does OpenMimir see Codex sessions I started in the terminal?",
        a: "Yes. It reads Codex's session files, including older ones, and can search their full history.",
      },
    ],
  },

  // claude code dashboard (480), claude code sessions (210), resume session (260), session manager (90), orchestrator (260)
  {
    path: "/coding-agent-dashboard",
    title: "One dashboard for Claude Code, Codex and OpenCode sessions · OpenMimir",
    description:
      "See every Claude Code, Codex and OpenCode session in one place, what's running and what needs you, and steer them from one conversation.",
    eyebrow: "Sessions",
    h1: "Every coding agent session in one place",
    lead: "If you run a few agents at once, the hard part is remembering which terminal had what. OpenMimir keeps track for you and lets you just ask.",
    summary: "What's running, what needs you, and how to pick up an old session without its id.",
    body: `
          <h2>What you see</h2>
          <p>OpenMimir lists sessions from Claude Code, Codex and OpenCode together, with a live status: <b>working</b>,
          <b>needs you</b>, <b>failed</b> or idle. It works out what is running from each agent's own history files, so
          sessions you started by hand show up too, not only the ones OpenMimir started.</p>

          <h2>Instead of a list, a conversation</h2>
          <p>A list of forty sessions isn't much help. The main view is a chat:</p>
          <ul>
            <li>"What was I working on yesterday?"</li>
            <li>"Pick up the review from last week and fix what it found."</li>
            <li>"Is anything waiting on me?"</li>
          </ul>
          <p>It searches the full history of every agent to find the right session, so you never copy a session id or run
          <code>claude --resume</code> and scroll. When it messages a session, you see inline which one and exactly what it
          sent.</p>

          <h2>Resuming sessions</h2>
          <p>Resuming works per agent: <code>claude -p --resume</code> for Claude Code, <code>codex exec resume</code> for
          Codex, and the OpenCode server API for OpenCode, so messages show up live in the OpenCode app. The history stays
          in each agent's own format, so you can always go back to the terminal.</p>

          <h2>Safety</h2>
          <p>Risky commands such as pushes, deploys, <code>sudo</code> and <code>rm -rf</code> wait for your approval.
          These rules are enforced in code, not only in a prompt.</p>`,
    faq: [
      {
        q: "Does it run agents in parallel worktrees?",
        a: "No. OpenMimir doesn't replace your agents or how you run them. It sits in front of the sessions you already have and lets you steer them.",
      },
      {
        q: "Where is the data stored?",
        a: "In <code>~/.openmimir</code> on your Mac. Agent history stays where each agent keeps it.",
      },
    ],
  },

  // opencode mobile (260), opencode remote (140)
  {
    path: "/opencode-remote",
    title: "OpenCode on your phone: remote control by voice · OpenMimir",
    description:
      "Talk to your OpenCode sessions from a phone or iPad. OpenMimir drives your OpenCode service, so every message also shows up live in the OpenCode app.",
    eyebrow: "OpenCode · Remote",
    h1: "Use OpenCode from your phone, by voice",
    lead: "OpenMimir connects to your OpenCode background service. Talk to it from a phone or iPad, and everything it sends appears live in OpenCode on your Mac.",
    summary: "Drive OpenCode sessions remotely, with every message visible in the OpenCode app.",
    body: `
          <h2>How it connects</h2>
          <p>OpenMimir finds your OpenCode background service automatically and uses its HTTP API. That means it isn't a
          separate copy of OpenCode: the sessions, messages and results are the same ones you see in the app. If no service
          is running, it starts a private <code>opencode serve</code> instead.</p>

          <h2>What you can do</h2>
          <ul>
            <li>Ask what any session is doing, in plain language.</li>
            <li>Send a follow-up to a session without naming it: "tell the docs session to add an install section".</li>
            <li>Start new work in any project folder, after it reads the plan back to you.</li>
            <li>Hear a short summary when a session finishes.</li>
          </ul>

          ${phoneSetup}`,
    faq: [
      {
        q: "Does OpenCode have a mobile app?",
        a: "OpenCode runs on your computer. You can reach its web interface remotely, or use OpenMimir to talk to your sessions from a phone.",
      },
      {
        q: "Do messages from OpenMimir show up in OpenCode?",
        a: "Yes, live, because OpenMimir uses your OpenCode service rather than a separate server.",
      },
    ],
  },

  // Story for links and AI answers: coding on a trainer, treadmill or walk.
  {
    path: "/blog/coding-on-an-indoor-trainer",
    title: "Coding on an indoor trainer: steering AI agents while you ride · OpenMimir",
    description:
      "What actually works when you want to keep coding agents busy during a trainer session, a treadmill walk or a run, and why OpenMimir was built for it.",
    eyebrow: "Story",
    h1: "Coding on an indoor trainer",
    lead: "Coding agents do the typing now. So does the work still need you at the desk? We tried steering them from the saddle.",
    summary: "What works, what doesn't, and why OpenMimir started on a bike trainer.",
    published: "2026-09-30",
    body: `
          <p>A good agent session runs for twenty minutes without you. That's about the length of a warm-up. The obvious
          question: can you keep three agents busy while you ride, and not come back to a pile of questions an hour later?</p>

          <h2>What doesn't work</h2>
          <ul>
            <li><b>Reading code on the bars.</b> At threshold power you can't review a diff, and you shouldn't try.</li>
            <li><b>Typing.</b> Obviously. Even a phone keyboard is too much.</li>
            <li><b>Push-to-talk.</b> Holding a key or a button every time you speak gets old fast, and sweaty hands miss.</li>
            <li><b>Walls of text.</b> A transcript of what the agent did is useless mid-interval.</li>
          </ul>

          <h2>What does</h2>
          <ul>
            <li><b>Short spoken questions and short answers.</b> "Is the migration done?" "Yes, tests pass, one warning
            about a deprecated flag."</li>
            <li><b>Planning.</b> Describing the next piece of work out loud is easier than writing it. The agent turns it
            into a plan; you say yes.</li>
            <li><b>Big, glanceable status.</b> What's running, what's waiting on you. Nothing to scroll.</li>
            <li><b>A confirmation step.</b> The agent repeats what it's about to do before it starts. Mishearings happen
            with a fan blowing in your face.</li>
            <li><b>Leaving the risky stuff for later.</b> Pushes and deploys wait until you're back at a screen.</li>
          </ul>

          <h2>The setup</h2>
          <p>OpenMimir runs on the Mac at the desk. An iPad on the handlebars shows trainer mode: the conversation in large
          type, live captions of what it heard, how many sessions are running, which ones need you, and huge approve and
          reject buttons. Earbuds
          carry the voice. The same setup works on a treadmill or a walking pad.</p>
          <ol>
            <li>Install OpenMimir and run <code>mimir init</code>.</li>
            <li>Make it reachable over HTTPS on your network (Tailscale Serve is the easiest) and run <code>mimir pair</code>.</li>
            <li>Open the link on the iPad, switch to <b>Trainer</b>, and start talking.</li>
          </ol>

          <h2>Other people doing this</h2>
          <p>We're not alone. Developers already dictate GitHub issues from Zwift sessions, pair walking pads with voice
          dictation into Claude Code, or use Remote Control to check on sessions at the gym. The common lesson matches ours:
          talk during the workout, review at the desk.</p>

          <h2>What's next</h2>
          <p>Outdoors is the next step: a screenless mode that reads back what it heard, and phone calls so it works on a
          run or a ride without a screen at all.</p>`,
  },
];
