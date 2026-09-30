import {
  AGENT_LABELS,
  type AgentKind,
  type ChatMessage,
  describeAction,
  type ForemanStep,
  type MessageSource,
  type SessionEvent,
} from "@openmimir/protocol";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { type EventBus, newId } from "./bus.ts";
import { formatDispatch } from "./dispatch.ts";
import { canApprove } from "./policy.ts";
import type { ProjectIndex } from "./projects.ts";
import { ago, IN_USE_MS, type SessionManager, statusLabel } from "./sessions.ts";
import type { Store } from "./store.ts";

export interface ForemanRequest {
  text: string;
  source: Exclude<MessageSource, "system">;
  /** Called with short labels while the foreman works, e.g. for voice progress. */
  onProgress?: (label: string) => void;
  /**
   * Set when Mimir itself starts the turn (e.g. a session finished). `text` is then
   * shown as a notice about `sessionId` and `context` goes to the model only.
   */
  internal?: { sessionId: string; context: string };
}

export interface ForemanDeps {
  model: LanguageModel;
  store: Store;
  bus: EventBus;
  sessions: SessionManager;
  projects: ProjectIndex;
  /** Agent used for new sessions unless the user asks for another one. */
  defaultAgent: AgentKind;
}

const HISTORY_LIMIT = 40;

const BASE_PROMPT = `You are Mimir, the master thread above all of the user's coding-agent sessions (OpenCode, Claude Code, Codex). The user talks to you in one ongoing conversation, by keyboard or by voice, often while away from their desk (riding an indoor bike, running, walking). You do not write code yourself: agent sessions do the work, and you steer them, collect their results and tell the user what matters.

You can see the user's recent sessions in every agent, and search_sessions searches each agent's whole history (months back), including sessions the user started themselves at their desk. You can continue any of them. The user should never have to name an agent, a session or an id. Work out what they mean from context:
- "How's the refactor going?" or "continue where I left off in the api repo" refers to an existing session. Match by project and topic, most recent first.
- If nothing recent matches, or the user says it is older, use search_sessions with the topic words and project before asking them. Try a couple of phrasings. Only ask the user once searching found nothing.
- Questions about sessions ("which session was that?", "what were we doing in X?") are questions: answer them, do not start work.
- A request for new, unrelated work gets a new session.
- If it is genuinely ambiguous between two sessions, ask one short question naming them by title.
- Never mention internal ids. Refer to sessions by their title and project.

Before you start or redirect work:
- Only act on a clear request: you must know which project, what outcome, and roughly what scope. If the request is vague ("work on the MCP", "fix the thing"), ask one short question first, offering your best guess, e.g. "Do you want me to continue the MCP data improvements session, or start something new, and if so what should it do?".
- Starting a new session is a bigger step than answering. When in doubt, answer or ask instead.

How you work:
- The user's exact words are attached to what you send automatically; you write the task. New session instructions must be self-contained: the agent cannot see this conversation. Include the goal, context, constraints and what "done" means.
- Follow-ups on existing work go to that session with message_session, so the agent keeps its context.
- When you send a session work, say in one short sentence what you asked it to do. You will automatically get its reply when it finishes and then report back; do not promise to "check" or "keep an eye on it" beyond that.
- Sessions the user touched in the last few minutes outside Mimir may be open on their screen. message_session will say so; then ask the user before sending.
- For progress questions, check with session_status or session_changes instead of guessing. Your earlier replies note which sessions you already checked: reuse that for follow-up questions, and only check again if the session is running, the user asks for an update, or it has been a while.
- Never claim something is done, merged, pushed or fixed unless a tool result says so.
- Keep answers short and concrete. Lead with the answer.

Approvals:
- Sessions sometimes pause to ask permission. Pending approvals are listed below.
- "confirm" tier may be approved over voice, but only after you read the action back and the user explicitly says "confirm". "screen" tier can only be approved on a screen; tell the user it will wait for them.
- Rejecting is always allowed.`;

const VOICE_NOTE = `This request came in by voice. A separate voice model will say your reply out loud and may paraphrase it. Reply in at most three short sentences of plain speech: no markdown, no lists, no code, no file paths unless essential. Numbers and names should be easy to say.
Speech recognition makes mistakes, so starting or redirecting work by voice takes two turns. Call start_session or message_session as soon as the request is clear: over voice the first call is held and nothing happens. Then read back in one sentence what you understood and will do, and ask for a yes. When the user agrees in their next turn, call the same tool again with confirmed_by_user=true. If they correct you, call it with the corrected plan (held again). Reading and searching need no confirmation.`;

const TEXT_NOTE = `This request came in by keyboard. Markdown is fine. Stay concise.`;

const AGENT_ENUM = z.enum(["opencode", "claude", "codex"]);

/** A spoken "yes" only confirms a plan read back this recently. */
const READ_BACK_VALID_MS = 3 * 60_000;

const CONFIRMED = z
  .boolean()
  .default(false)
  .describe("Voice only: true once the user agreed, in a later turn, to the plan you read back.");

/** Earlier replies carry a note of what was looked at, so follow-ups do not repeat the work. */
function withStepNotes(message: ChatMessage, sessions: SessionManager): string {
  const notes = (message.steps ?? [])
    .filter((step) => step.state === "done")
    .map((step) => {
      const session = step.sessionId ? sessions.get(step.sessionId) : undefined;
      if (!session) return step.label;
      const project = session.directory.split("/").filter(Boolean).pop();
      return `${step.label} "${session.title}" (${AGENT_LABELS[session.agent]}, ${project}, ${session.id})`;
    });
  if (notes.length === 0) return message.text;
  const at = new Date(message.createdAt).toISOString().slice(11, 16);
  return `${message.text}\n\n[Mimir's own notes at ${at} UTC, not shown to the user: ${notes.join("; ")}.]`;
}

type BeginStep = (
  label: string,
  sessionId?: string,
  /** What is being sent to the session, shown to the user in full. */
  message?: string,
) => { done: (note?: string, sessionId?: string) => void; fail: (error: unknown) => void };

export class Foreman {
  private queue: Promise<unknown> = Promise.resolve();
  /** The voice turn in which Mimir read a plan back and asked for a yes. */
  private readBackAskedIn: { requestId: string; at: number } | undefined;

  constructor(private readonly deps: ForemanDeps) {}

  /** Requests are handled one at a time so the conversation stays in order. */
  handle(request: ForemanRequest): Promise<ChatMessage> {
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A session Mimir gave work to has finished: read its reply and tell the user what
   * it means for what they asked, instead of pasting the agent's raw output.
   */
  followUp(input: {
    sessionId: string;
    title: string;
    result: string;
    source: ForemanRequest["source"];
  }): Promise<ChatMessage> {
    const context = `[Mimir internal, not from the user] The session "${input.title}" (${input.sessionId}) just finished the work you gave it. Its final reply:
"""
${input.result.slice(0, 8000)}
"""
Tell the user what this means for what they asked, in your own words. Lead with the answer. Mention anything they need to do. Do not call tools unless something in the reply clearly needs checking. If nothing in it matters to the user, reply with one short sentence saying it finished.`;
    return this.handle({
      text: `"${input.title}" finished.`,
      source: input.source,
      internal: { sessionId: input.sessionId, context },
    });
  }

  /** Record something that happened without asking the model, e.g. a session finishing. */
  notice(text: string, sessionId?: string, event?: SessionEvent): ChatMessage {
    const message: ChatMessage = {
      id: newId("msg"),
      role: "notice",
      source: "system",
      text,
      sessionId,
      event,
      createdAt: Date.now(),
    };
    this.deps.store.saveMessage(message);
    this.deps.bus.publish({ type: "message.upsert", message });
    return message;
  }

  private stateSummary(): string {
    const sessions = this.deps.sessions.list().slice(0, 24);
    const approvals = this.deps.sessions.pendingApprovals();
    const projects = this.deps.projects.list();
    const lines: string[] = [];
    lines.push(`Current time: ${new Date().toISOString()}`);
    lines.push(
      `Available agents: ${this.deps.sessions.agents.map((a) => AGENT_LABELS[a]).join(", ")}. Default for new sessions: ${AGENT_LABELS[this.deps.defaultAgent]}.`,
    );
    lines.push(
      `Known projects (${projects.length}): ${
        projects
          .slice(0, 60)
          .map((p) => p.name)
          .join(", ") || "none found"
      }`,
    );
    if (sessions.length === 0) {
      lines.push("Sessions: none yet.");
    } else {
      lines.push("Recent sessions across all agents (newest first):");
      for (const t of sessions) {
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
        const session = this.deps.sessions.get(a.sessionId);
        lines.push(
          `- [${a.id}] "${session?.title ?? a.sessionId}" wants: ${a.action} ${a.resources.slice(0, 3).join(", ")} [tier: ${a.tier}]${a.message ? ` - ${a.message.slice(0, 160)}` : ""}`,
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
        result.push({ role: "assistant", content: withStepNotes(m, this.deps.sessions) });
      } else {
        result.push({ role: "user", content: `[update from Mimir, not the user] ${m.text}` });
      }
    }
    return result;
  }

  private tools(source: ForemanRequest["source"], begin: BeginStep, requestId: string, said?: string) {
    const { sessions, projects, defaultAgent } = this.deps;
    const dispatch = (task: string) => formatDispatch({ said, source, task });
    /**
     * Voice gets misheard, so work only starts after Mimir read the plan back and the
     * user agreed in a later turn. Returns a refusal to hand back to the model, or nothing.
     */
    const readBack = (plan: string, confirmed: boolean) => {
      if (source !== "voice") return undefined;
      const asked = this.readBackAskedIn;
      const askedEarlier =
        asked && asked.requestId !== requestId && Date.now() - asked.at < READ_BACK_VALID_MS;
      if (confirmed && askedEarlier) {
        this.readBackAskedIn = undefined;
        return undefined;
      }
      if (!askedEarlier) this.readBackAskedIn = { requestId, at: Date.now() };
      return {
        needsConfirmation: true,
        reason: `Nothing was done yet. Voice can be misheard: say back in one sentence what you understood and will do (${plan}) and ask the user to confirm. Call this again with confirmed_by_user=true only after they agree in their next turn.`,
      };
    };
    return {
      list_projects: tool({
        description: "List the git repositories new sessions can be started in.",
        inputSchema: z.object({}),
        execute: async () => projects.list(),
      }),
      recent_sessions: tool({
        description:
          "Recent sessions across all agents, including ones the user started at their desk, with what each one said last. Use it to find the session the user is referring to.",
        inputSchema: z.object({
          project: z.string().optional().describe("Only sessions in this project."),
          limit: z.number().int().min(1).max(30).default(12),
        }),
        execute: async ({ project, limit }) => {
          const step = begin(
            project ? `Looked through recent sessions in ${project}` : "Looked through recent sessions",
          );
          const all = await sessions.refresh(true);
          const wanted = project?.toLowerCase().replace(/[^a-z0-9]/g, "");
          const found = all
            .filter(
              (t) =>
                !wanted ||
                t.directory
                  .toLowerCase()
                  .replace(/[^a-z0-9/]/g, "")
                  .includes(wanted),
            )
            .slice(0, limit);
          step.done(`${found.length} found`);
          return found.map((t) => ({
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
      search_sessions: tool({
        description:
          "Search every agent's whole session history (not just recent ones) by topic words and/or project. Use it when the user refers to older work or nothing recent matches.",
        inputSchema: z.object({
          query: z
            .string()
            .optional()
            .describe("Topic words, e.g. 'lead finder export' or 'abuse detection'."),
          project: z.string().optional().describe("Only sessions in this project (worktrees included)."),
          limit: z.number().int().min(1).max(30).default(12),
        }),
        execute: async ({ query, project, limit }) => {
          const step = begin(
            ["Searched all session history", query && `for "${query}"`, project && `in ${project}`]
              .filter(Boolean)
              .join(" "),
          );
          const found = await sessions.search({ text: query, project, limit });
          step.done(`${found.length} found`);
          return found.map((t) => ({
            id: t.id,
            title: t.title,
            project: t.directory.split("/").filter(Boolean).pop(),
            agent: AGENT_LABELS[t.agent],
            status: statusLabel(t.status),
            lastActive: ago(t.updatedAt),
            lastSaid: t.lastText?.slice(-300),
          }));
        },
      }),
      start_session: tool({
        description: "Start a new agent session in a project, with its first instructions.",
        inputSchema: z.object({
          project: z.string().describe("Project name from the known projects, or an absolute path."),
          title: z.string().describe("Short title, 2-6 words, e.g. 'Fix flaky auth tests'."),
          instructions: z.string().describe("Complete, self-contained instructions for the agent."),
          agent: AGENT_ENUM.optional().describe("Only set this if the user asked for a specific agent."),
          confirmed_by_user: CONFIRMED,
        }),
        execute: async ({ project, title, instructions, agent, confirmed_by_user }) => {
          const pending = readBack(`start a new session in ${project}: ${title}`, confirmed_by_user);
          if (pending) return pending;
          const ref = projects.resolve(project);
          if (!ref) return { error: `No project matches "${project}". Call list_projects to see options.` };
          const chosen = agent ?? defaultAgent;
          if (!sessions.agents.includes(chosen))
            return { error: `${AGENT_LABELS[chosen]} is not available.` };
          const message = dispatch(instructions);
          const step = begin(
            `Started a new ${AGENT_LABELS[chosen]} session in ${ref.name}`,
            undefined,
            instructions,
          );
          try {
            const session = await sessions.start({
              agent: chosen,
              directory: ref.directory,
              title,
              instructions: message,
            });
            step.done(undefined, session.id);
            return {
              sessionId: session.id,
              project: ref.name,
              agent: AGENT_LABELS[chosen],
              status: statusLabel(session.status),
            };
          } catch (error) {
            step.fail(error);
            throw error;
          }
        },
      }),
      message_session: tool({
        description:
          "Send a follow-up instruction or answer to an existing session, whoever started it. The agent keeps its own context.",
        inputSchema: z.object({
          session_id: z.string(),
          text: z.string(),
          user_confirmed: z
            .boolean()
            .default(false)
            .describe("Set after the user agreed to message a session that may be open on their screen."),
          confirmed_by_user: CONFIRMED,
        }),
        execute: async ({ session_id, text, user_confirmed, confirmed_by_user }) => {
          const session = sessions.get(session_id);
          if (!session)
            return { error: `No session ${session_id}. Call recent_sessions or search_sessions.` };
          const pending = readBack(`send "${session.title}" new instructions`, confirmed_by_user);
          if (pending) return pending;
          if (!session.tracked && Date.now() - session.updatedAt < IN_USE_MS && !user_confirmed) {
            return {
              needsConfirmation: true,
              reason: `"${session.title}" was active ${ago(session.updatedAt)} outside Mimir and may be open on the user's screen. Ask before sending to it.`,
            };
          }
          const message = dispatch(text);
          const step = begin("Sent instructions to", session_id, text);
          try {
            const next = await sessions.message(session_id, message);
            step.done();
            return { sessionId: next.id, status: statusLabel(next.status) };
          } catch (error) {
            step.fail(error);
            throw error;
          }
        },
      }),
      session_status: tool({
        description: "Get a session's status and the latest thing its agent said.",
        inputSchema: z.object({ session_id: z.string() }),
        execute: async ({ session_id }) => {
          const session = sessions.get(session_id);
          if (!session) return { error: `No session ${session_id}` };
          const step = begin("Checked", session_id);
          const latest = await sessions.latestText(session_id).catch(() => session.lastText);
          step.done();
          return {
            title: session.title,
            agent: AGENT_LABELS[session.agent],
            status: statusLabel(session.status),
            lastActive: ago(session.updatedAt),
            error: session.error,
            latest: latest?.slice(-3000),
          };
        },
      }),
      session_changes: tool({
        description: "List the files a session changed, with a short diff preview.",
        inputSchema: z.object({
          session_id: z.string(),
          include_patch: z.boolean().default(false).describe("Include patch text (truncated)."),
        }),
        execute: async ({ session_id, include_patch }) => {
          const step = begin("Read the changes in", session_id);
          try {
            const changes = await sessions.changes(session_id);
            step.done(`${changes.length} file${changes.length === 1 ? "" : "s"} changed`);
            return changes.slice(0, 40).map((c) => ({
              file: c.file,
              status: c.status,
              additions: c.additions,
              deletions: c.deletions,
              patch: include_patch ? c.patch.slice(0, 1500) : undefined,
            }));
          } catch (error) {
            step.fail(error);
            throw error;
          }
        },
      }),
      stop_session: tool({
        description: "Interrupt a session that is currently running.",
        inputSchema: z.object({ session_id: z.string() }),
        execute: async ({ session_id }) => {
          const step = begin("Stopped", session_id);
          const session = await sessions.stop(session_id);
          step.done();
          return { sessionId: session.id, status: statusLabel(session.status) };
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
          const approval = sessions.pendingApprovals().find((a) => a.id === approval_id);
          if (!approval) return { error: `No pending approval ${approval_id}` };
          if (decision === "approve") {
            const check = canApprove(approval.tier, source, user_confirmed);
            if (!check.allowed) return { refused: true, reason: check.reason };
          }
          const verb = decision === "approve" ? "Approved" : "Rejected";
          const step = begin(
            `${verb} ${describeAction(approval.action, approval.resources)}`,
            approval.sessionId,
          );
          const result = await sessions.resolveApproval(approval_id, decision);
          step.done();
          return { approvalId: result.id, status: result.status };
        },
      }),
    };
  }

  private async run(request: ForemanRequest): Promise<ChatMessage> {
    const { store, bus } = this.deps;
    const opening: ChatMessage = request.internal
      ? {
          id: newId("msg"),
          role: "notice",
          source: "system",
          text: request.text,
          sessionId: request.internal.sessionId,
          event: "finished",
          createdAt: Date.now(),
        }
      : { id: newId("msg"), role: "user", source: request.source, text: request.text, createdAt: Date.now() };
    store.saveMessage(opening);
    bus.publish({ type: "message.upsert", message: opening });

    const reply: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      source: request.source,
      text: "",
      pending: true,
      createdAt: Date.now(),
    };
    bus.publish({ type: "message.upsert", message: reply });
    await this.deps.sessions.refresh().catch(() => undefined);

    const publishReply = () =>
      bus.publish({
        type: "message.upsert",
        message: { ...reply, steps: reply.steps?.map((step) => ({ ...step })) },
      });

    const begin: BeginStep = (label, sessionId, message) => {
      const step: ForemanStep = { id: newId("stp"), label, sessionId, state: "running", message };
      reply.steps = [...(reply.steps ?? []), step];
      if (sessionId) this.deps.sessions.focus(sessionId);
      publishReply();
      // Steps on a session show its chip in the UI; spoken progress needs the name.
      const title = sessionId ? this.deps.sessions.get(sessionId)?.title : undefined;
      request.onProgress?.(title ? `${label} "${title}"` : label);
      return {
        done: (note, id) => {
          step.state = "done";
          if (note) step.detail = step.detail ? `${step.detail}\n\n${note}` : note;
          if (id) {
            step.sessionId = id;
            this.deps.sessions.focus(id);
          }
          publishReply();
        },
        fail: (error) => {
          step.state = "error";
          step.detail = error instanceof Error ? error.message : String(error);
          publishReply();
        },
      };
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
        messages: request.internal
          ? [...this.history(), { role: "user", content: request.internal.context }]
          : this.history(),
        tools: this.tools(request.source, begin, reply.id, request.internal ? undefined : request.text),
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
    }
    return reply;
  }
}
