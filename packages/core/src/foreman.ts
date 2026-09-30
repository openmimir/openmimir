import { AGENT_LABELS, type AgentKind, type ChatMessage, type MessageSource } from "@openmimir/protocol";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { type EventBus, newId } from "./bus.ts";
import { canApprove } from "./policy.ts";
import type { ProjectIndex } from "./projects.ts";
import type { Store } from "./store.ts";
import { ago, IN_USE_MS, statusLabel, type TaskManager } from "./tasks.ts";

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
  tasks: TaskManager;
  projects: ProjectIndex;
  /** Agent used for new tasks unless the user asks for another one. */
  defaultAgent: AgentKind;
}

const HISTORY_LIMIT = 40;

const BASE_PROMPT = `You are Mimir, the user's single point of contact for all their coding agents (OpenCode, Claude Code, Codex). The user talks to you in one ongoing conversation, by keyboard or by voice, often while away from their desk (riding an indoor bike, running, walking). You do not write code yourself: coding agents do the work, and you run them.

Every agent session is a task. You can see the user's recent sessions in every agent, including ones they started themselves at their desk, and you can continue any of them. The user should never have to name an agent, a session or an id. Work out what they mean from context:
- "How's the refactor going?" or "continue where I left off in reachkit" refers to an existing task. Match by project and topic, most recent first.
- A request for new, unrelated work gets a new task.
- If it is genuinely ambiguous between two tasks, ask one short question naming them by title.
- Never mention internal ids, and do not call things "workers" or "sessions". Use task titles and project names.

How you work:
- New task instructions must be self-contained: the agent cannot see this conversation. Include the goal, context, constraints and what "done" means.
- Follow-ups on existing work go to that task with message_task, so the agent keeps its context.
- Tasks the user touched in the last few minutes outside Mimir may be open on their screen. message_task will say so; then ask the user before sending.
- For progress questions, check with task_status or task_changes instead of guessing.
- Never claim something is done, merged, pushed or fixed unless a tool result says so.
- Keep answers short and concrete. Lead with the answer.

Approvals:
- Tasks sometimes pause to ask permission. Pending approvals are listed below.
- "confirm" tier may be approved over voice, but only after you read the action back and the user explicitly says "confirm". "screen" tier can only be approved on a screen; tell the user it will wait for them.
- Rejecting is always allowed.`;

const VOICE_NOTE = `This request came in by voice. A separate voice model will say your reply out loud and may paraphrase it. Reply in at most three short sentences of plain speech: no markdown, no lists, no code, no file paths unless essential. Numbers and names should be easy to say.`;

const TEXT_NOTE = `This request came in by keyboard. Markdown is fine. Stay concise.`;

const AGENT_ENUM = z.enum(["opencode", "claude", "codex"]);

export class Foreman {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ForemanDeps) {}

  /** Requests are handled one at a time so the conversation stays in order. */
  handle(request: ForemanRequest): Promise<ChatMessage> {
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Record something that happened without asking the model, e.g. a task finishing. */
  notice(text: string, taskId?: string): ChatMessage {
    const message: ChatMessage = {
      id: newId("msg"),
      role: "notice",
      source: "system",
      text,
      taskId,
      createdAt: Date.now(),
    };
    this.deps.store.saveMessage(message);
    this.deps.bus.publish({ type: "message.upsert", message });
    return message;
  }

  private stateSummary(): string {
    const tasks = this.deps.tasks.list().slice(0, 24);
    const approvals = this.deps.tasks.pendingApprovals();
    const projects = this.deps.projects.list();
    const lines: string[] = [];
    lines.push(`Current time: ${new Date().toISOString()}`);
    lines.push(
      `Available agents: ${this.deps.tasks.agents.map((a) => AGENT_LABELS[a]).join(", ")}. Default for new tasks: ${AGENT_LABELS[this.deps.defaultAgent]}.`,
    );
    lines.push(
      `Known projects (${projects.length}): ${
        projects
          .slice(0, 60)
          .map((p) => p.name)
          .join(", ") || "none found"
      }`,
    );
    if (tasks.length === 0) {
      lines.push("Tasks: none yet.");
    } else {
      lines.push("Recent tasks across all agents (newest first):");
      for (const t of tasks) {
        const project = t.directory.split("/").filter(Boolean).pop();
        const who =
          t.origin === "mimir" ? "started by you" : t.tracked ? "continued by you" : "started by the user";
        lines.push(
          `- [${t.id}] "${t.title}" · ${project} · ${AGENT_LABELS[t.agent]} · ${statusLabel(t.status)} · ${ago(t.updatedAt)} · ${who}${t.error ? ` · error: ${t.error.slice(0, 100)}` : ""}`,
        );
      }
    }
    if (approvals.length === 0) {
      lines.push("Pending approvals: none.");
    } else {
      lines.push("Pending approvals:");
      for (const a of approvals) {
        const task = this.deps.tasks.get(a.taskId);
        lines.push(
          `- [${a.id}] "${task?.title ?? a.taskId}" wants: ${a.action} ${a.resources.slice(0, 3).join(", ")} [tier: ${a.tier}]${a.message ? ` - ${a.message.slice(0, 160)}` : ""}`,
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
    const { tasks, projects, defaultAgent } = this.deps;
    return {
      list_projects: tool({
        description: "List the git repositories new tasks can be started in.",
        inputSchema: z.object({}),
        execute: async () => projects.list(),
      }),
      recent_tasks: tool({
        description:
          "Recent tasks across all agents, including sessions the user started at their desk, with what each one said last. Use it to find the task the user is referring to.",
        inputSchema: z.object({
          project: z.string().optional().describe("Only tasks in this project."),
          limit: z.number().int().min(1).max(30).default(12),
        }),
        execute: async ({ project, limit }) => {
          progress("Looking at recent tasks");
          const all = await tasks.refresh(true);
          const wanted = project?.toLowerCase().replace(/[^a-z0-9]/g, "");
          return all
            .filter(
              (t) =>
                !wanted ||
                t.directory
                  .toLowerCase()
                  .replace(/[^a-z0-9/]/g, "")
                  .includes(wanted),
            )
            .slice(0, limit)
            .map((t) => ({
              id: t.id,
              title: t.title,
              project: t.directory.split("/").filter(Boolean).pop(),
              agent: AGENT_LABELS[t.agent],
              status: statusLabel(t.status),
              lastActive: ago(t.updatedAt),
              lastSaid: t.lastText?.slice(-400),
            }));
        },
      }),
      start_task: tool({
        description: "Start a new task: a fresh agent session in a project, with its first instructions.",
        inputSchema: z.object({
          project: z.string().describe("Project name from the known projects, or an absolute path."),
          title: z.string().describe("Short title, 2-6 words, e.g. 'Fix flaky auth tests'."),
          instructions: z.string().describe("Complete, self-contained instructions for the agent."),
          agent: AGENT_ENUM.optional().describe("Only set this if the user asked for a specific agent."),
        }),
        execute: async ({ project, title, instructions, agent }) => {
          const ref = projects.resolve(project);
          if (!ref) return { error: `No project matches "${project}". Call list_projects to see options.` };
          const chosen = agent ?? defaultAgent;
          if (!tasks.agents.includes(chosen)) return { error: `${AGENT_LABELS[chosen]} is not available.` };
          progress(`Starting a task in ${ref.name}`);
          const task = await tasks.start({ agent: chosen, directory: ref.directory, title, instructions });
          return {
            taskId: task.id,
            project: ref.name,
            agent: AGENT_LABELS[chosen],
            status: statusLabel(task.status),
          };
        },
      }),
      message_task: tool({
        description:
          "Send a follow-up instruction or answer to an existing task, whoever started it. The agent keeps its own context.",
        inputSchema: z.object({
          task_id: z.string(),
          text: z.string(),
          user_confirmed: z
            .boolean()
            .default(false)
            .describe("Set after the user agreed to message a task that may be open on their screen."),
        }),
        execute: async ({ task_id, text, user_confirmed }) => {
          const task = tasks.get(task_id);
          if (!task) return { error: `No task ${task_id}. Call recent_tasks.` };
          if (!task.tracked && Date.now() - task.updatedAt < IN_USE_MS && !user_confirmed) {
            return {
              needsConfirmation: true,
              reason: `"${task.title}" was active ${ago(task.updatedAt)} outside Mimir and may be open on the user's screen. Ask before sending to it.`,
            };
          }
          progress(`Messaging "${task.title}"`);
          const next = await tasks.message(task_id, text);
          return { taskId: next.id, status: statusLabel(next.status) };
        },
      }),
      task_status: tool({
        description: "Get a task's status and the latest thing its agent said.",
        inputSchema: z.object({ task_id: z.string() }),
        execute: async ({ task_id }) => {
          progress("Checking on a task");
          const task = tasks.get(task_id);
          if (!task) return { error: `No task ${task_id}` };
          const latest = await tasks.latestText(task_id).catch(() => task.lastText);
          return {
            title: task.title,
            agent: AGENT_LABELS[task.agent],
            status: statusLabel(task.status),
            lastActive: ago(task.updatedAt),
            error: task.error,
            latest: latest?.slice(-3000),
          };
        },
      }),
      task_changes: tool({
        description: "List the files a task changed, with a short diff preview.",
        inputSchema: z.object({
          task_id: z.string(),
          include_patch: z.boolean().default(false).describe("Include patch text (truncated)."),
        }),
        execute: async ({ task_id, include_patch }) => {
          progress("Looking at changes");
          const changes = await tasks.changes(task_id);
          return changes.slice(0, 40).map((c) => ({
            file: c.file,
            status: c.status,
            additions: c.additions,
            deletions: c.deletions,
            patch: include_patch ? c.patch.slice(0, 1500) : undefined,
          }));
        },
      }),
      stop_task: tool({
        description: "Interrupt a task that is currently running.",
        inputSchema: z.object({ task_id: z.string() }),
        execute: async ({ task_id }) => {
          progress("Stopping a task");
          const task = await tasks.stop(task_id);
          return { taskId: task.id, status: statusLabel(task.status) };
        },
      }),
      resolve_approval: tool({
        description:
          "Approve or reject a pending approval. For voice requests on 'confirm' tier approvals, set user_confirmed=true only after the user explicitly said 'confirm' for this specific action.",
        inputSchema: z.object({
          approval_id: z.string(),
          decision: z.enum(["approve", "reject"]),
          user_confirmed: z.boolean().default(false),
        }),
        execute: async ({ approval_id, decision, user_confirmed }) => {
          const approval = tasks.pendingApprovals().find((a) => a.id === approval_id);
          if (!approval) return { error: `No pending approval ${approval_id}` };
          if (decision === "approve") {
            const check = canApprove(approval.tier, source, user_confirmed);
            if (!check.allowed) return { refused: true, reason: check.reason };
          }
          progress(decision === "approve" ? "Approving" : "Rejecting");
          const result = await tasks.resolveApproval(approval_id, decision);
          return { approvalId: result.id, status: result.status };
        },
      }),
    };
  }

  private async run(request: ForemanRequest): Promise<ChatMessage> {
    const { store, bus } = this.deps;
    await this.deps.tasks.refresh().catch(() => undefined);
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
