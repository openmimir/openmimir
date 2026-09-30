import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectRef } from "@openmimir/protocol";
import { expandHome } from "./config.ts";

/** Finds git repositories the foreman can start workers in. */
export class ProjectIndex {
  private cache: { at: number; projects: ProjectRef[] } | undefined;

  constructor(
    private readonly roots: string[],
    private readonly explicit: ProjectRef[],
  ) {}

  list(): ProjectRef[] {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.projects;
    const found = new Map<string, ProjectRef>();
    for (const project of this.explicit) {
      const directory = expandHome(project.directory);
      found.set(directory, { name: project.name, directory });
    }
    for (const root of this.roots.map(expandHome)) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root)) {
        if (entry.startsWith(".")) continue;
        const directory = join(root, entry);
        try {
          if (!statSync(directory).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!existsSync(join(directory, ".git"))) continue;
        if (!found.has(directory)) found.set(directory, { name: basename(directory), directory });
      }
    }
    const projects = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { at: Date.now(), projects };
    return projects;
  }

  /** Resolve a spoken or typed project name to a directory. */
  resolve(nameOrPath: string): ProjectRef | undefined {
    if (nameOrPath.startsWith("/") || nameOrPath.startsWith("~")) {
      const directory = expandHome(nameOrPath);
      return existsSync(directory) ? { name: basename(directory), directory } : undefined;
    }
    const wanted = normalize(nameOrPath);
    const projects = this.list();
    return (
      projects.find((p) => normalize(p.name) === wanted) ??
      projects.find((p) => normalize(p.name).includes(wanted) || wanted.includes(normalize(p.name)))
    );
  }
}

/** Voice transcripts say "open mimir" for "openmimir"; compare loosely. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
