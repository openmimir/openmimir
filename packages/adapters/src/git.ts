import type { FileChange } from "./types.ts";

/** Uncommitted changes in a working tree, for agents without their own diff API. */
export async function gitChanges(directory: string): Promise<FileChange[]> {
  const run = async (args: string[]) => {
    const proc = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? text : "";
  };
  const numstat = await run(["diff", "HEAD", "--numstat"]);
  const untracked = await run(["ls-files", "--others", "--exclude-standard"]);
  const changes: FileChange[] = [];
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del, file] = line.split("\t");
    if (!file) continue;
    changes.push({
      file,
      status: "modified",
      additions: Number(add) || 0,
      deletions: Number(del) || 0,
      patch: await run(["diff", "HEAD", "--unified=3", "--", file]),
    });
  }
  for (const file of untracked.split("\n").filter(Boolean).slice(0, 50)) {
    changes.push({ file, status: "added", additions: 0, deletions: 0, patch: "" });
  }
  return changes;
}
