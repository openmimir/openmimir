import type { ChatMessage, MessageSource } from "@openmimir/protocol";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { type EventBus, newId } from "./bus.ts";
import { canApprove } from "./policy.ts";
import type { ProjectIndex } from "./projects.ts";
import type { Store } from "./store.ts";
import { statusLabel, type WorkerManager } from "./workers.ts";

export interface ForemanRequest {
  text: string;
  source: Exclude<MessageSource, "system">;
  /** Called with short labels while the foreman works, e.g. for voice progress. */
  onProgress?: (label: string) => void;
}

export interface ForemanDeps {
  model: LanguageModel;
  store: Store;
  bus: EventBus;
  workers: WorkerManager;
  projects: ProjectIndex;
}

const HISTORY_LIMIT = 40;

const BASE_PROMPT = `You are Mimir, a foreman for coding agents. The user talks to you in one ongoing conversation, by keyboard or by voice, often while away from their desk (riding an indoor bike, running, walking). You do not write code yourself. You start and steer worker agents (OpenCode sessions) that do the work in the user's repositories, and you keep track of what they are doing.

How you work:
- Turn requests into clear, self-contained instructions for a worker. Workers cannot see this conversation, so include the goal, relevant context, constraints and what "done" means.
- Prefer starting one worker per independent task. Reuse an existing worker (message_worker) for follow-ups on the same task.
- When asked about progress, check with worker_status or worker_changes instead of guessing.
- Never claim something is done, merged, pushed or fixed unless a tool result says so.
- Keep your own answers short and concrete. Lead with the answer.

Approvals:
- Workers sometimes ask permission before acting. Pending approvals are listed below.
- Approvals have a tier. "confirm" may be approved over voice, but only after you read the action back and the user explicitly confirms. "screen" can only be approved on a screen; tell the user it will wait for them.
- Rejecting is always allowed.`;

const VOICE_NOTE = `This request came in by voice. A separate voice model will say your reply out loud and may paraphrase it. Reply in at most three short sentences of plain speech: no markdown, no lists, no code, no file paths unless essential. Numbers and names should be easy to say.`;

const TEXT_NOTE = `This request came in by keyboard. Markdown is fine. Stay concise.`;

export class Foreman {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ForemanDeps) {}

  /** Requests are handled one at a time so the conversation stays in order. */
  handle(request: ForemanRequest): Promise<ChatMessage> {
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Record something that happened without asking the model, e.g. a worker finishing. */
  notice(text: string): ChatMessage {
    const message: ChatMessage = {
      id: newId("msg"),
      role: "notice",
      source: "system",
      text,
      createdAt: Date.now(),
    };
    this.deps.store.saveMessage(message);
    this.deps.bus.publish({ type: "message.upsert", message });
    return message;
  }

  private stateSummary(): string {
    const workers = this.deps.workers.list().slice(0, 15);
    const approvals = this.deps.workers.pendingApprovals();
    const projects = this.deps.projects.list();
    const lines: string[] = [];
    lines.push(`Current time: ${new Date().toISOString()}`);
    lines.push(
      `Known projects (${projects.length}): ${
        projects
          .slice(0, 60)
          .map((p) => p.name)
          .join(", ") || "none found"
      }`,
    );
    if (workers.length === 0) {
      lines.push("Workers: none yet.");
    } else {
      lines.push("Workers (newest first):");
      for (const w of workers) {
        lines.push(
          `- ${w.id} "${w.title}" in ${w.directory}: ${statusLabel(w.status)}${w.error ? ` (error: ${w.error.slice(0, 120)})` : ""}`,
        );
      }
    }
    if (approvals.length === 0) {
      lines.push("Pending approvals: none.");
    } else {
      lines.push("Pending approvals:");
      for (const a of approvals) {
        lines.push(
          `- ${a.id} from worker ${a.workerId}: ${a.action} ${a.resources.slice(0, 3).join(", ")} [tier: ${a.tier}]${a.message ? ` - ${a.message.slice(0, 160)}` : ""}`,
        );
      }
    }
    return lines.join("\n");
  }

  private history(): ModelMessage[] {
    const messages = this.deps.store.recentMessages(HISTORY_LIMIT);
    const result: ModelMessage[] = [];
    for (const m of messages) {
      if (m.pending || !m.text.trim()) continue;
      if (m.role === "user") {
        result.push({ role: "user", content: m.source === "voice" ? `(spoken) ${m.text}` : m.text });
      } else if (m.role === "assistant") {
        result.push({ role: "assistant", content: m.text });
      } else {
        result.push({ role: "user", content: `[update from Mimir, not the user] ${m.text}` });
      }
    }
    return result;
  }

  private tools(source: ForemanRequest["source"], progress: (label: string) => void) {
    const { workers, projects } = this.deps;
    return {
      list_projects: tool({
        description: "List the git repositories workers can be started in.",
        inputSchema: z.object({}),
        execute: async () => projects.list(),
      }),
      start_worker: tool({
        description:
          "Start a new worker agent (an OpenCode session) in a project and give it its first instructions. Returns the worker id.",
        inputSchema: z.object({
          project: z.string().describe("Project name from list_projects, or an absolute path."),
          title: z.string().describe("Short title, 2-6 words, e.g. 'Fix flaky auth tests'."),
          instructions: z.string().describe("Complete, self-contained instructions for the worker."),
        }),
        execute: async ({ project, title, instructions }) => {
          const ref = projects.resolve(project);
          if (!ref) {
            return { error: `No project matches "${project}". Call list_projects to see options.` };
          }
          progress(`Starting a worker in ${ref.name}`);
          const worker = await workers.start({ directory: ref.directory, title, instructions });
          return { workerId: worker.id, project: ref.name, status: worker.status };
        },
      }),
      message_worker: tool({
        description: "Send a follow-up instruction or answer to an existing worker.",
        inputSchema: z.object({ worker_id: z.string(), text: z.string() }),
        execute: async ({ worker_id, text }) => {
          progress("Messaging a worker");
          const worker = await workers.message(worker_id, text);
          return { workerId: worker.id, status: worker.status };
        },
      }),
      worker_status: tool({
        description: "Get a worker's status and the latest thing it said.",
        inputSchema: z.object({ worker_id: z.string() }),
        execute: async ({ worker_id }) => {
          progress("Checking on a worker");
          const worker = workers.get(worker_id);
          if (!worker) return { error: `No worker ${worker_id}` };
          const latest = await workers.latestText(worker_id).catch(() => worker.lastText);
          return {
            title: worker.title,
            status: statusLabel(worker.status),
            error: worker.error,
            latest: latest?.slice(-3000),
          };
        },
      }),
      worker_changes: tool({
        description: "List the files a worker changed in its latest turn, with a short diff preview.",
        inputSchema: z.object({
          worker_id: z.string(),
          include_patch: z.boolean().default(false).describe("Include patch text (truncated)."),
        }),
        execute: async ({ worker_id, include_patch }) => {
          progress("Looking at changes");
          const changes = await workers.changes(worker_id);
          return changes.slice(0, 40).map((c) => ({
            file: c.file,
            status: c.status,
            additions: c.additions,
            deletions: c.deletions,
            patch: include_patch ? c.patch.slice(0, 1500) : undefined,
          }));
        },
      }),
      stop_worker: tool({
        description: "Interrupt a worker that is currently running.",
        inputSchema: z.object({ worker_id: z.string() }),
        execute: async ({ worker_id }) => {
          progress("Stopping a worker");
          const worker = await workers.stop(worker_id);
          return { workerId: worker.id, status: statusLabel(worker.status) };
        },
      }),
      resolve_approval: tool({
        description:
          "Approve or reject a pending worker approval. For voice requests on 'confirm' tier approvals, set user_confirmed=true only after the user explicitly said 'confirm' for this specific action.",
        inputSchema: z.object({
          approval_id: z.string(),
          decision: z.enum(["approve", "reject"]),
          user_confirmed: z.boolean().default(false),
        }),
        execute: async ({ approval_id, decision, user_confirmed }) => {
          const approval = workers.pendingApprovals().find((a) => a.id === approval_id);
          if (!approval) return { error: `No pending approval ${approval_id}` };
          if (decision === "approve") {
            const check = canApprove(approval.tier, source, user_confirmed);
            if (!check.allowed) return { refused: true, reason: check.reason };
          }
          progress(decision === "approve" ? "Approving" : "Rejecting");
          const result = await workers.resolveApproval(approval_id, decision);
          return { approvalId: result.id, status: result.status };
        },
      }),
    };
  }

  private async run(request: ForemanRequest): Promise<ChatMessage> {
    const { store, bus } = this.deps;
    const userMessage: ChatMessage = {
      id: newId("msg"),
      role: "user",
      source: request.source,
      text: request.text,
      createdAt: Date.now(),
    };
    store.saveMessage(userMessage);
    bus.publish({ type: "message.upsert", message: userMessage });

    const reply: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      source: request.source,
      text: "",
      pending: true,
      createdAt: Date.now(),
    };
    bus.publish({ type: "message.upsert", message: reply });
    bus.publish({ type: "activity", activity: { busy: true, label: "Thinking" } });

    const progress = (label: string) => {
      bus.publish({ type: "activity", activity: { busy: true, label } });
      request.onProgress?.(label);
    };

    let lastFlush = 0;
    let streamError: unknown;
    try {
      const result = streamText({
        model: this.deps.model,
        system: [
          BASE_PROMPT,
          `Current state:\n${this.stateSummary()}`,
          request.source === "voice" ? VOICE_NOTE : TEXT_NOTE,
        ].join("\n\n"),
        messages: this.history(),
        tools: this.tools(request.source, progress),
        stopWhen: stepCountIs(8),
        onError: ({ error }) => {
          streamError = error;
        },
      });
      for await (const delta of result.textStream) {
        reply.text += delta;
        if (Date.now() - lastFlush > 60) {
          lastFlush = Date.now();
          bus.publish({ type: "message.upsert", message: { ...reply } });
        }
      }
      if (streamError) throw streamError;
      if (!reply.text.trim()) reply.text = "Done.";
    } catch (error) {
      reply.text = `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      reply.pending = false;
      store.saveMessage(reply);
      bus.publish({ type: "message.upsert", message: reply });
      bus.publish({ type: "activity", activity: { busy: false } });
    }
    return reply;
  }
}
