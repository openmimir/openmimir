# OpenMimir

**One chat that runs all your coding agents. Type to it, or talk to it hands-free.**

Mimir is one conversation in front of all your coding agents: OpenCode, Claude Code and Codex. It
already sees the sessions you started at your desk, so "how's the reachkit refactor going?" or
"carry on with that" just works, and new requests start new sessions without you picking an agent. Add full-duplex voice and you can run it all from an indoor bike, a treadmill or a walk: it
listens while it talks, you can interrupt it, and it tells you when a session finishes or needs you.

> Status: early (v0.1). Works on macOS at a desk and on the indoor trainer. Phone calls and
> outdoor/running mode are next. See the [roadmap](#roadmap).

## How it works

```
 Keyboard chat │ Trainer screen │ Full-duplex voice (GPT-Live over WebRTC)
               └───────┬────────┘
               Mimir server on your Mac (one process)
        foreman model · memory · session state · approval rules
                       │
          OpenCode · Claude Code · Codex
```

- **The foreman** is a frontier model (OpenAI or Anthropic, your choice). It sees recent sessions in
  every agent, starts new sessions, continues existing ones, checks status and changes, and handles
  approvals.
- **Voice** uses OpenAI's `gpt-live-1`. Your browser streams audio straight to OpenAI; the Mimir
  server brokers the session, listens in, and handles everything the voice model delegates.
- **Sessions** are the agents' own sessions. OpenCode runs through your OpenCode background service
  (the one your OpenCode app uses), so Mimir's messages show up live in your OpenCode windows; Claude Code and Codex run headless (`claude -p`, `codex exec`) and are picked up
  automatically when installed.

## Requirements

- macOS (Apple Silicon or Intel)
- [Bun](https://bun.sh) 1.3+
- [OpenCode](https://opencode.ai) v2 (`opencode` on your PATH). Claude Code and Codex are optional.
- An OpenAI API key (voice, and the default foreman). An Anthropic key is optional.

## Quick start

```sh
bunx openmimir init    # API keys, foreman model, where your repos live
bunx openmimir         # starts the server
```

Open <http://localhost:4747>, then type a request or press **⌘⇧Space** to talk:

> "Add a section about setup to the openmimir README."

Switch to **Trainer** mode for a big, glanceable screen with live captions and huge approve/reject
buttons.

### From source

```sh
git clone https://github.com/openmimir/openmimir && cd openmimir
bun install
bun run dev          # builds the web UI and starts the server on :4747
```

For UI work, run `bun run dev:server` and `bun run dev:web` side by side (Vite on :5173 proxies to
the server).

## Commands

| Command        | What it does                                               |
| -------------- | ---------------------------------------------------------- |
| `mimir`        | Start the server (same as `mimir serve`)                   |
| `mimir init`   | Set API keys, models and project folders                   |
| `mimir pair`   | Print a link to pair another device (iPad on the trainer)  |
| `mimir doctor` | Check keys, OpenCode and voice model access                |

## Configuration

Config lives in `~/.openmimir/config.json` (created on first run, `chmod 600`). Environment
variables override it: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MIMIR_PORT`, `MIMIR_FOREMAN_MODEL`,
`MIMIR_OPENCODE_URL`, `MIMIR_HOME`.

```jsonc
{
  "foreman": { "model": "openai/gpt-6.1-sol" },   // or "anthropic/<model>"
  "voice": { "model": "gpt-live-1", "voice": "marin" },
  "projectRoots": ["~/repos"],                     // git repos in here are available for new sessions
  "opencode": { "url": "auto" }                    // your OpenCode background service
}
```

## Using it from an iPad or phone

Browsers only allow the microphone on `localhost` or HTTPS, so other devices need a tunnel. The
easiest is [Tailscale Serve](https://tailscale.com/kb/1312/serve):

```sh
tailscale serve --bg 4747
```

Add your Tailscale hostname (e.g. `my-mac.tail1234.ts.net`) to `server.allowedHosts` in the config,
restart Mimir, run `mimir pair` and open the printed link on the device once.

## Safety

Mimir can drive agents that change code on your machine, so:

- The server listens on `127.0.0.1` only. Other devices must pair first.
- Every API call needs a token; websites you visit cannot talk to Mimir.
- Risky shell commands (push, deploy, `rm -rf`, `sudo`, ...) are held for approval in OpenCode and
  blocked outright in Claude Code. Codex follows its own sandbox settings.
- Approvals are tiered. Normal edits and commands can be approved by voice, but only after
  you explicitly say "confirm". Pushes, deploys, deletes and similar can only be approved on a screen.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Costs

You bring your own keys. Voice is billed by OpenAI per minute of session (about $0.05/min for
`gpt-live-1` at the time of writing), plus the foreman model's tokens and whatever your agents use.
Mimir itself is free.

## Roadmap

- [x] Foreman chat over OpenCode, Claude Code and Codex, including sessions you started yourself
- [x] Approvals and live session status
- [x] Full-duplex voice at the desk (GPT-Live, WebRTC)
- [x] Trainer mode: glanceable screen with captions
- [ ] Phone calls (SIP) and a screenless mode for outdoor rides and runs
- [ ] Wake word, breathing-proof turn taking, running mode
- [ ] Menubar desktop app
- [ ] Cloud agents so your laptop can sleep

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture notes are in [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
