import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ClerkAuth } from "./auth.js";
import { authBinding, type Config } from "./config.js";
import * as c from "./contracts.js";
import { Dpop, generateDpopKey, hash } from "./dpop.js";
import { BridgeError, errorResult } from "./errors.js";
import { Http } from "./http.js";
import { Store, type State, type Operation } from "./store.js";
import { T3Api, type TokenCache } from "./t3.js";
import { lastActivityAt, threadAttention, threadStatus } from "./thread-status.js";

const operationId = c.id.describe("Unique ID for this operation. Keep this ID and all arguments unchanged when retrying, including after a timeout.");
export const startInput = z.object({
  operationId, environmentId: c.id, projectId: c.id, title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(100_000), modelSelection: c.modelSelection.optional(),
  runtimeMode: c.runtimeMode.default("approval-required"), interactionMode: c.interactionMode.default("default"),
});
export const messageInput = z.object({ operationId, environmentId: c.id, threadId: c.id, instructions: z.string().trim().min(1).max(100_000) });
export const interruptInput = z.object({ operationId, environmentId: c.id, threadId: c.id, turnId: c.id.optional() });
export const listThreadsInput = z.object({
  environmentId: c.id, projectId: c.id.optional(), status: threadStatus.optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20),
});
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class Bridge {
  private cache: TokenCache = { environments: new Map() };
  constructor(public config: Config, public store = new Store(config.stateDir), public http = new Http()) {}

  private run<T>(fn: (api: T3Api, state: State, save: () => Promise<void>) => Promise<T>) {
    return this.store.locked(async (state, save) => {
      if (!state.auth?.sessionId) throw new BridgeError("login_required", "Sign in with t3code-mcp login, or use login-start and login-verify for agent-guided setup.");
      if (state.auth.binding !== authBinding(this.config)) throw new BridgeError("config_mismatch", "Credentials belong to a different deployment. Use a separate state directory.");
      if (!state.privateJwk) { state.privateJwk = generateDpopKey(); await save(); }
      const signer = new Dpop(state.privateJwk);
      const identity = `${state.auth.sessionId}:${signer.thumbprint}`;
      if (this.cache.identity !== identity) this.cache = { identity, environments: new Map() };
      return fn(new T3Api(this.config, this.http, new ClerkAuth(this.config, this.http, state, save), signer, this.cache), state, save);
    });
  }

  listEnvironments(input: { offset: number; limit: number; checkAvailability: boolean }) {
    return this.run(async api => {
      const all = await api.environments();
      const page = all.slice(input.offset, input.offset + input.limit);
      const environments = [];
      // Keep one account credential renewal in flight; probe a bounded page.
      for (const item of page) {
        let availability: Record<string, unknown> = { status: "unchecked" };
        if (input.checkAvailability) {
          try { availability = await api.status(item.environmentId); }
          catch (error) { availability = { status: "unavailable", error: errorResult(error) }; }
        }
        environments.push({ environmentId: item.environmentId, label: clip(item.label, 200), endpoint: item.endpoint.httpBaseUrl, ...availability });
      }
      return { environments, total: all.length, nextOffset: input.offset + page.length < all.length ? input.offset + page.length : null };
    });
  }

  listProjects(input: { environmentId: string; offset: number; limit: number }) {
    return this.run(async api => {
      const all = (await api.shell(input.environmentId)).projects;
      return { environmentId: input.environmentId, projects: all.slice(input.offset, input.offset + input.limit).map(p => ({ ...p, title: clip(p.title, 200), workspaceRoot: clip(p.workspaceRoot, 2000) })), total: all.length,
        nextOffset: input.offset + input.limit < all.length ? input.offset + input.limit : null };
    });
  }

  listThreads(input: z.infer<typeof listThreadsInput>) {
    return this.run(async api => {
      const snapshot = await api.shell(input.environmentId);
      if (input.projectId && !snapshot.projects.some(p => p.id === input.projectId)) {
        throw new BridgeError("project_not_found", "This project does not exist on the selected environment.");
      }
      const all = snapshot.threads
        .filter(t => !t.archivedAt && (!input.projectId || t.projectId === input.projectId))
        .map(t => ({ thread: t, attention: threadAttention(t), lastActivityAt: lastActivityAt(t) }))
        .filter(t => !input.status || t.attention.status === input.status)
        .sort((a, b) => (b.lastActivityAt ? Date.parse(b.lastActivityAt) : -Infinity) - (a.lastActivityAt ? Date.parse(a.lastActivityAt) : -Infinity)
          || (a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0));
      const page = all.slice(input.offset, input.offset + input.limit);
      return {
        environmentId: input.environmentId, scope: "unarchived", snapshotSequence: snapshot.snapshotSequence, observedAt: new Date().toISOString(),
        threads: page.map(({ thread: t, attention, lastActivityAt }) => ({
          threadId: t.id, projectId: t.projectId, title: clip(t.title, 200), ...attention,
          session: t.session && { ...t.session, lastError: t.session.lastError && clip(t.session.lastError, 2000) }, latestTurn: t.latestTurn,
          createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null, lastActivityAt,
        })),
        total: all.length, nextOffset: input.offset + page.length < all.length ? input.offset + page.length : null,
      };
    });
  }

  getThread(input: { environmentId: string; threadId: string; turnLimit: number; beforeCursor?: string }) {
    return this.run(async api => {
      const detail = await api.thread(input.environmentId, input.threadId, input.turnLimit, input.beforeCursor);
      if (detail.thread.id !== input.threadId) throw new BridgeError("identity_mismatch", "The response names another thread.");
      const snapshot = await api.shell(input.environmentId);
      const summary = snapshot.threads.find(t => t.id === input.threadId);
      const t = detail.thread;
      const current = summary ?? t;
      return {
        environmentId: input.environmentId, threadId: t.id, projectId: current.projectId, title: clip(current.title, 200),
        session: current.session && { ...current.session, lastError: current.session.lastError && clip(current.session.lastError, 2000) }, latestTurn: current.latestTurn,
        ...threadAttention(summary), statusSnapshotSequence: summary ? snapshot.snapshotSequence : null,
        messages: t.messages.slice(-20).map(m => ({ ...m, text: clip(m.text, 3000) })),
        activities: t.activities.slice(-12).map(a => ({ ...a, summary: clip(a.summary, 500), payload: clip(JSON.stringify(a.payload) ?? "null", 1500) })),
        outputTruncated: t.messages.length > 20 || t.messages.some(m => m.text.length > 3000) || t.activities.length > 12 || t.activities.some(a => (JSON.stringify(a.payload)?.length ?? 0) > 1500 || a.summary.length > 500),
        page: detail.page ?? null, snapshotSequence: detail.snapshotSequence,
      };
    });
  }

  startThread(input: z.infer<typeof startInput>) {
    return this.mutate("start_thread", input, async api => {
      const project = (await api.shell(input.environmentId)).projects.find(p => p.id === input.projectId);
      if (!project) throw new BridgeError("project_not_found", "This project does not exist on the selected environment.");
      const modelSelection = input.modelSelection ?? project.defaultModelSelection;
      if (!modelSelection) throw new BridgeError("model_required", "This project has no default model. Supply a configured provider instanceId and model.");
      if (project.defaultThreadEnvMode === "worktree") throw new BridgeError("worktree_required", "This project defaults to worktrees. Worktree preparation requires T3's WebSocket bootstrap and is not implemented yet.");
      const threadId = randomUUID(), createdAt = new Date().toISOString();
      return { threadId, commands: [
        { type: "thread.create", commandId: randomUUID(), threadId, projectId: input.projectId, title: input.title,
          modelSelection, runtimeMode: input.runtimeMode, interactionMode: input.interactionMode, branch: null, worktreePath: null, createdAt },
        { type: "thread.turn.start", commandId: randomUUID(), threadId,
          message: { messageId: randomUUID(), role: "user", text: input.instructions, attachments: [] },
          modelSelection, runtimeMode: input.runtimeMode, interactionMode: input.interactionMode, createdAt },
      ] };
    });
  }

  sendMessage(input: z.infer<typeof messageInput>) {
    return this.mutate("send_message", input, async api => {
      const { thread } = await api.thread(input.environmentId, input.threadId, 1);
      return { threadId: input.threadId, commands: [{ type: "thread.turn.start", commandId: randomUUID(), threadId: input.threadId,
        message: { messageId: randomUUID(), role: "user", text: input.instructions, attachments: [] },
        modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode, createdAt: new Date().toISOString() }] };
    });
  }

  interruptThread(input: z.infer<typeof interruptInput>) {
    return this.mutate("interrupt_thread", input, async api => {
      const { thread } = await api.thread(input.environmentId, input.threadId, 1);
      const turnId = input.turnId ?? thread.session?.activeTurnId ?? (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : undefined);
      if (!turnId) throw new BridgeError("no_active_turn", "There is no active turn to interrupt.");
      return { threadId: input.threadId, commands: [{ type: "thread.turn.interrupt", commandId: randomUUID(), threadId: input.threadId, turnId, createdAt: new Date().toISOString() }] };
    });
  }

  private mutate(kind: string, input: { operationId: string; environmentId: string }, prepare: (api: T3Api) => Promise<{ threadId: string; commands: Record<string, unknown>[] }>) {
    return this.run(async (api, state, save) => {
      if (!state.auth?.accountId) await new ClerkAuth(this.config, this.http, state, save).token();
      const key = hash(stable([state.auth!.accountId, input.environmentId, input.operationId]));
      const fingerprint = hash(stable([kind, input]));
      let operation: Operation | undefined = state.operations[key];
      if (operation && operation.fingerprint !== fingerprint) throw new BridgeError("operation_conflict", "This operationId has already been used with different arguments. Restore the original arguments for a retry.");
      if (!operation) {
        if (Object.keys(state.operations).length >= 10_000) throw new BridgeError("journal_full", "The operation journal is full. Archive the state directory only after resolving all outstanding operations.");
        const prepared = await prepare(api);
        operation = { fingerprint, environmentId: input.environmentId, ...prepared, accepted: 0, sequences: [] };
        state.operations[key] = operation;
        await save(); // Durable command IDs and payloads BEFORE any side effect.
      }
      const ids = { operationId: input.operationId, environmentId: input.environmentId, threadId: operation.threadId,
        commandIds: operation.commands.map(command => command.commandId) };
      while (operation.accepted < operation.commands.length) {
        const command = operation.commands[operation.accepted]!;
        try {
          const result = await api.dispatch(input.environmentId, command);
          operation.sequences.push(result.sequence);
          operation.accepted++;
          await save();
        } catch (error) {
          throw new BridgeError("operation_incomplete", "The operation did not finish confirming acceptance. Inspect get_thread, then retry the exact arguments with the same operationId.", {
            ...ids, confirmedCommands: operation.accepted, stage: command.type, cause: errorResult(error),
          });
        }
      }
      return { ...ids, status: "accepted", sequences: operation.sequences,
        next: "Use get_thread to check provider startup, progress, errors, and requests for input. Acceptance does not mean the task completed." };
    });
  }
}
