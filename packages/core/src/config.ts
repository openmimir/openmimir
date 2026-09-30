import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectRef } from "@openmimir/protocol";

export const CONFIG_VERSION = 1;

export interface MimirConfig {
  version: number;
  server: {
    port: number;
    host: string;
    /** Extra hostnames allowed to reach the server, e.g. a Tailscale name. */
    allowedHosts: string[];
    /** Secret used to pair other devices. Generated on first run. */
    pairingSecret: string;
  };
  foreman: {
    /** `provider/model`, e.g. `openai/gpt-6.1-sol` or `anthropic/claude-sonnet-5`. */
    model: string;
  };
  voice: {
    model: string;
    voice: string;
  };
  keys: {
    openai?: string;
    anthropic?: string;
  };
  agents: {
    /** Agent for new tasks unless the user asks for another one. */
    default: "opencode" | "claude" | "codex";
    /** Claude Code and Codex are used when installed, unless turned off here. */
    claude: boolean;
    codex: boolean;
  };
  opencode: {
    url: string;
    username: string;
    password: string;
    /** Start `opencode serve` automatically when nothing answers at `url`. */
    manage: boolean;
  };
  /** Folders scanned (one level deep) for git repositories. */
  projectRoots: string[];
  /** Explicitly named projects. */
  projects: ProjectRef[];
}

export function mimirHome(): string {
  return process.env.MIMIR_HOME ?? join(homedir(), ".openmimir");
}

export function configPath(): string {
  return join(mimirHome(), "config.json");
}

function randomSecret(bytes = 24): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString("base64url");
}

export function defaultConfig(): MimirConfig {
  return {
    version: CONFIG_VERSION,
    server: { port: 4747, host: "127.0.0.1", allowedHosts: [], pairingSecret: randomSecret() },
    foreman: { model: "openai/gpt-6.1-sol" },
    voice: { model: "gpt-live-1", voice: "marin" },
    keys: {},
    agents: { default: "opencode", claude: true, codex: true },
    opencode: {
      url: "http://127.0.0.1:4097",
      username: "opencode",
      password: randomSecret(18),
      manage: true,
    },
    projectRoots: [join(homedir(), "repos")],
    projects: [],
  };
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

/** Deep-merge saved config over defaults so new fields get sensible values. */
function merge<T>(base: T, override: unknown): T {
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return (override === undefined ? base : override) as T;
  }
  if (typeof override !== "object" || override === null) return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? merge(result[key], value) : value;
  }
  return result as T;
}

function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  // Future config migrations go here, keyed on raw.version.
  return { ...raw, version: CONFIG_VERSION };
}

export function loadConfig(): MimirConfig {
  const path = configPath();
  let config = defaultConfig();
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const version = typeof raw.version === "number" ? raw.version : 0;
    if (version > CONFIG_VERSION) {
      throw new Error(
        `${path} was written by a newer Mimir (config v${version}). Upgrade with \`mimir upgrade\`.`,
      );
    }
    if (version < CONFIG_VERSION) {
      writeFileSync(`${path}.v${version}.bak`, JSON.stringify(raw, null, 2));
    }
    config = merge(config, migrate(raw));
  } else {
    saveConfig(config);
  }
  return applyEnv(config);
}

/** Environment variables win over the config file, and are never written back. */
function applyEnv(config: MimirConfig): MimirConfig {
  const env = process.env;
  return {
    ...config,
    server: {
      ...config.server,
      port: env.MIMIR_PORT ? Number(env.MIMIR_PORT) : config.server.port,
      host: env.MIMIR_HOST ?? config.server.host,
    },
    foreman: { model: env.MIMIR_FOREMAN_MODEL ?? config.foreman.model },
    keys: {
      openai: config.keys.openai || env.OPENAI_API_KEY,
      anthropic: config.keys.anthropic || env.ANTHROPIC_API_KEY,
    },
    opencode: {
      ...config.opencode,
      url: env.MIMIR_OPENCODE_URL ?? config.opencode.url,
      password: env.MIMIR_OPENCODE_PASSWORD ?? config.opencode.password,
    },
  };
}

export function saveConfig(config: MimirConfig): void {
  const home = mimirHome();
  mkdirSync(home, { recursive: true });
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path, 0o600);
}
