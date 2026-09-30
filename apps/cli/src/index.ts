#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { OpenCodeAdapter } from "@openmimir/adapters";
import { configPath, loadConfig, type MimirConfig, saveConfig } from "@openmimir/core";
import { AGENT_LABELS } from "@openmimir/protocol";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.ts";
import { startServer } from "./server.ts";

const VERSION = pkg.version;

function log(message: string) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  console.log(`${time} ${message}`);
}

function webDir(): string {
  if (process.env.MIMIR_WEB_DIR) return process.env.MIMIR_WEB_DIR;
  const here = dirname(new URL(import.meta.url).pathname);
  const candidates = [
    join(here, "web"), // npm bundle: dist/index.js + dist/web
    join(dirname(process.execPath), "web"), // standalone binary next to web/
    join(here, "../../web/dist"), // running from the repo
  ];
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? candidates[2]!;
}

function help() {
  console.log(`mimir ${VERSION}

One voice-first chat that controls all your coding agents.

Usage:
  mimir [serve]      Start the Mimir server (default)
  mimir init         Set up API keys, models and project folders
  mimir pair         Print a link to pair another device (iPad, phone)
  mimir doctor       Check that everything Mimir needs is reachable
  mimir version      Print the version

Config: ${configPath()}`);
}

async function serve() {
  const config = loadConfig();
  const app = await createApp(config, VERSION, log);
  await app.start();
  const server = startServer({
    app,
    port: config.server.port,
    host: config.server.host,
    allowedHosts: config.server.allowedHosts,
    secret: config.server.pairingSecret,
    webDir: webDir(),
    log,
  });
  const url = `http://localhost:${server.port}`;
  console.log(`
  Mimir ${VERSION} is running

  Open      ${url}
  Foreman   ${config.foreman.model}${app.foremanError() ? `  (not ready: ${app.foremanError()})` : ""}
  Voice     ${app.voice ? config.voice.model : "off (no OpenAI key)"}
  Agents    ${app
    .info()
    .agents.map((a) => `${AGENT_LABELS[a.kind]} ${a.available ? "✓" : `✗ (${a.detail ?? "unavailable"})`}`)
    .join(", ")}
`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("shutting down");
    // Close open browser connections too, so the port is free right away for a restart.
    server.stop(true);
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function ask(question: string, fallback?: string): string {
  const answer = prompt(`${question}${fallback ? ` [${fallback}]` : ""}:`);
  return answer?.trim() || fallback || "";
}

function mask(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 7)}…${value.slice(-4)}` : undefined;
}

async function init() {
  loadConfig(); // creates the file with defaults on first run
  const saved = JSON.parse(await Bun.file(configPath()).text()) as MimirConfig;
  console.log(`Setting up Mimir. Press enter to keep the value in brackets.\n`);

  const openai = ask(
    "OpenAI API key (voice + default foreman)",
    mask(saved.keys.openai) ?? (process.env.OPENAI_API_KEY ? "use $OPENAI_API_KEY" : undefined),
  );
  if (openai && !openai.includes("…") && !openai.startsWith("use $")) saved.keys.openai = openai;

  const anthropic = ask(
    "Anthropic API key (optional)",
    mask(saved.keys.anthropic) ?? (process.env.ANTHROPIC_API_KEY ? "use $ANTHROPIC_API_KEY" : "skip"),
  );
  if (anthropic && !anthropic.includes("…") && !anthropic.startsWith("use $") && anthropic !== "skip") {
    saved.keys.anthropic = anthropic;
  }

  saved.foreman.model = ask("Foreman model (provider/model)", saved.foreman.model);
  saved.voice.voice = ask("Voice (marin, gleam, meridian, vesper, willow, ...)", saved.voice.voice);
  const roots = ask("Folders with your repos (comma separated)", saved.projectRoots.join(", "));
  saved.projectRoots = roots
    .split(",")
    .map((root) => root.trim())
    .filter(Boolean);

  saveConfig(saved);
  console.log(`\nSaved ${configPath()}`);
  console.log(`\nStart Mimir with: mimir`);
}

function pair() {
  const config = loadConfig();
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => net!.address);
  console.log(`To use Mimir from another device, open one of these links on it:\n`);
  for (const host of config.server.allowedHosts) {
    console.log(`  https://${host}/pair?code=${config.server.pairingSecret}`);
  }
  if (config.server.host === "127.0.0.1" || config.server.host === "localhost") {
    console.log(`  (Mimir only listens on this Mac. Put Tailscale Serve or Cloudflare Tunnel in front of`);
    console.log(
      `   port ${config.server.port}, and add its hostname to server.allowedHosts in ${configPath()}.)`,
    );
  } else {
    for (const address of addresses) {
      console.log(`  http://${address}:${config.server.port}/pair?code=${config.server.pairingSecret}`);
    }
    console.log(
      `\n  Note: browsers only allow the microphone over HTTPS, so voice on other devices needs a tunnel.`,
    );
  }
  console.log(`\nAnyone with this link can control your agents. Treat it like a password.`);
}

async function doctor() {
  const config = loadConfig();
  const check = (ok: boolean, label: string, detail = "") =>
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  check(true, "config", configPath());
  check(Boolean(config.keys.openai), "OpenAI key", config.keys.openai ? "" : "needed for voice");
  const provider = config.foreman.model.split("/")[0];
  const foremanKey =
    provider === "openai" ? config.keys.openai : provider === "anthropic" ? config.keys.anthropic : undefined;
  check(Boolean(foremanKey), `foreman ${config.foreman.model}`, foremanKey ? "" : `no ${provider} key`);
  const which = Bun.which("opencode");
  check(Boolean(which), "opencode binary", which ?? "install from https://opencode.ai");
  const adapter = new OpenCodeAdapter({
    url: config.opencode.url,
    username: config.opencode.username,
    password: config.opencode.password,
  });
  const health = await adapter.health();
  check(
    health.ok || config.opencode.manage,
    "OpenCode server",
    health.ok
      ? `v${health.version ?? "?"} at ${config.opencode.url}`
      : config.opencode.manage
        ? "not running, Mimir will start it"
        : health.error,
  );
  for (const [kind, enabled] of [
    ["claude", config.agents.claude],
    ["codex", config.agents.codex],
  ] as const) {
    const path = Bun.which(kind);
    check(
      Boolean(path) || !enabled,
      `${AGENT_LABELS[kind]}`,
      !enabled ? "turned off" : (path ?? "not installed (optional)"),
    );
  }
  if (config.keys.openai) {
    const response = await fetch(`https://api.openai.com/v1/models/${config.voice.model}`, {
      headers: { authorization: `Bearer ${config.keys.openai}` },
    }).catch(() => undefined);
    check(
      Boolean(response?.ok),
      `voice model ${config.voice.model}`,
      response?.ok ? "" : "not available for this key",
    );
  }
}

const command = process.argv[2] ?? "serve";
switch (command) {
  case "serve":
    await serve();
    break;
  case "init":
    await init();
    break;
  case "pair":
    pair();
    break;
  case "doctor":
    await doctor();
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.error(`Unknown command "${command}".\n`);
    help();
    process.exit(1);
}
