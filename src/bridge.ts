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
import type { Orchestration, PreparedOperation, RuntimeSummary } from "./orchestration.js";

const operationId = c.id.describe("Unique ID for this operation. Keep this ID and all arguments unchanged when retrying, including after a timeout.");
export const startInput = z.object({
  operationId, environmentId: c.id, projectId: c.id, title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(100_000), modelSelection: c.modelSelection.optional(),
  runtimeMode: c.runtimeMode.default("approval-required"), interactionMode: c.interactionMode.default("default"),
});
export const messageInput = z.object({ operationId, environmentId: c.id, threadId: c.id, instructions: z.string().trim().min(1).max(100_000), mode: z.enum(["auto", "queue", "steer", "restart"]).optional() });
export const interruptInput = z.object({ operationId, environmentId: c.id, threadId: c.id, turnId: c.id.optional(), runId: c.id.optional() });
export const listThreadsInput = z.object({
  environmentId: c.id, projectId: c.id.optional(), status: threadStatus.optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20),
});
function boundedRuntime(runtime: RuntimeSummary): RuntimeSummary {
  return { ...runtime, lastError: runtime.lastError ? clip(runtime.lastError, 2000) : null };
}
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
      const apiVersion = await api.orchestration(input.environmentId);
      const all = (await apiVersion.shell()).projects;
      return { environmentId: input.environmentId, projects: all.slice(input.offset, input.offset + input.limit).map(p => ({ ...p, title: clip(p.title, 200), workspaceRoot: clip(p.workspaceRoot, 2000) })), total: all.length,
        nextOffset: input.offset + input.limit < all.length ? input.offset + input.limit : null };
    });
  }

  listThreads(input: z.infer<typeof listThreadsInput>) {
    return this.run(async api => {
      const apiVersion = await api.orchestration(input.environmentId);
      const snapshot = await apiVersion.shell();
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
        environmentId: input.environmentId, protocolVersion: apiVersion.version, scope: "unarchived", snapshotSequence: snapshot.snapshotSequence, observedAt: new Date().toISOString(),
        threads: page.map(({ thread: t, attention, lastActivityAt }) => ({
          threadId: t.id, projectId: t.projectId, title: clip(t.title, 200), ...attention,
          session: t.session && { ...t.session, lastError: t.session.lastError && clip(t.session.lastError, 2000) }, latestTurn: t.latestTurn,
          ...(t.runtime ? { runtime: boundedRuntime(t.runtime) } : {}),
          createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null, lastActivityAt,
        })),
        total: all.length, nextOffset: input.offset + page.length < all.length ? input.offset + page.length : null,
      };
    });
  }

  getThread(input: { environmentId: string; threadId: string; turnLimit: number; beforeCursor?: string }) {
    return this.run(async api => {
      const apiVersion = await api.orchestration(input.environmentId);
      const detail = await apiVersion.thread(input.threadId, input.turnLimit, input.beforeCursor);
      if (detail.thread.id !== input.threadId) throw new BridgeError("identity_mismatch", "The response names another thread.");
      const snapshot = await apiVersion.shell();
      const summary = snapshot.threads.find(t => t.id === input.threadId);
      const t = detail.thread;
      const current = summary ?? t;
      return {
        environmentId: input.environmentId, protocolVersion: apiVersion.version, threadId: t.id, projectId: current.projectId, title: clip(current.title, 200),
        session: current.session && { ...current.session, lastError: current.session.lastError && clip(current.session.lastError, 2000) }, latestTurn: current.latestTurn,
        ...(current.runtime ? { runtime: boundedRuntime(current.runtime) } : {}),
        ...(detail.runtimeRequests ? { runtimeRequests: detail.runtimeRequests.map(r => ({ ...r, responseCapability: { ...r.responseCapability, ...(r.responseCapability.reason ? { reason: clip(r.responseCapability.reason, 1000) } : {}) } })), runtimeRequestsTruncated: detail.runtimeRequestsTruncated, runtimeRequestsSnapshotSequence: detail.runtimeRequestsSnapshotSequence } : {}),
        ...threadAttention(summary), statusSnapshotSequence: summary ? snapshot.snapshotSequence : null,
        messages: t.messages.slice(-20).map(m => ({ ...m, text: clip(m.text, 3000) })),
        activities: t.activities.slice(-12).map(a => ({ ...a, summary: clip(a.summary, 500), payload: clip(JSON.stringify(a.payload) ?? "null", 1500) })),
        outputTruncated: Boolean(detail.payloadBudgetExceeded || detail.runtimeRequestsTruncated) || t.messages.length > 20 || t.messages.some(m => m.text.length > 3000) || t.activities.length > 12 || t.activities.some(a => (JSON.stringify(a.payload)?.length ?? 0) > 1500 || a.summary.length > 500),
        page: detail.page ?? null, snapshotSequence: detail.snapshotSequence,
      };
    });
  }

  startThread(input: z.infer<typeof startInput>) {
    return this.mutate("start_thread", input, async api => {
      const project = (await api.shell()).projects.find(p => p.id === input.projectId);
      if (!project) throw new BridgeError("project_not_found", "This project does not exist on the selected environment.");
      const modelSelection = input.modelSelection ?? project.defaultModelSelection;
      if (!modelSelection) throw new BridgeError("model_required", "This project has no default model. Supply a configured provider instanceId and model.");
      if (project.defaultThreadEnvMode === "worktree") throw new BridgeError("worktree_required", "This project defaults to worktrees. Worktree creation is not supported by this bridge.");
      return api.prepareStart({ ...input, modelSelection });
    });
  }

  sendMessage(input: z.infer<typeof messageInput>) {
    return this.mutate("send_message", input, api => api.prepareMessage(input));
  }

  interruptThread(input: z.infer<typeof interruptInput>) {
    return this.mutate("interrupt_thread", input, api => api.prepareInterrupt(input));
  }

  private mutate(kind: string, input: { operationId: string; environmentId: string }, prepare: (api: Orchestration) => Promise<PreparedOperation>) {
    return this.run(async (api, state, save) => {
      if (!state.auth?.accountId) await new ClerkAuth(this.config, this.http, state, save).token();
      const key = hash(stable([state.auth!.accountId, input.environmentId, input.operationId]));
      const fingerprint = hash(stable([kind, input]));
      let operation: Operation | undefined = state.operations[key];
      if (operation && operation.fingerprint !== fingerprint) throw new BridgeError("operation_conflict", "This operationId has already been used with different arguments. Restore the original arguments for a retry.");
      let adapter: Orchestration | undefined;
      if (!operation || operation.accepted < operation.commands.length) adapter = await api.orchestration(input.environmentId);
      if (operation && operation.accepted < operation.commands.length && (operation.protocolVersion ?? 1) !== adapter!.version) {
        throw new BridgeError("operation_protocol_changed", "The environment changed orchestration protocols during this operation. Inspect the thread and reconcile the original operation; old commands will not be translated or replayed.", { operationId: input.operationId, threadId: operation.threadId, recordedProtocolVersion: operation.protocolVersion ?? 1, currentProtocolVersion: adapter!.version });
      }
      if (!operation) {
        if (Object.keys(state.operations).length >= 10_000) throw new BridgeError("journal_full", "The operation journal is full. Archive the state directory only after resolving all outstanding operations.");
        const prepared = await prepare(adapter!);
        operation = { fingerprint, environmentId: input.environmentId, ...prepared, protocolVersion: adapter!.version, accepted: 0, sequences: [], results: [] };
        if (adapter!.version === 2) state.version = 2; // Older bridge versions must not replay v2 payloads.
        state.operations[key] = operation;
        await save(); // Durable command IDs and payloads BEFORE any side effect.
      }
      const ids = { operationId: input.operationId, environmentId: input.environmentId, threadId: operation.threadId,
        commandIds: operation.commands.map(command => command.commandId) };
      while (operation.accepted < operation.commands.length) {
        const command = operation.commands[operation.accepted]!;
        try {
          const result = await adapter!.execute(command);
          if (result.sequence !== undefined) operation.sequences.push(result.sequence);
          (operation.results ??= []).push(result);
          operation.accepted++;
          await save();
        } catch (error) {
          throw new BridgeError("operation_incomplete", "The operation did not finish confirming acceptance. Inspect get_thread, then retry the exact arguments with the same operationId.", {
            ...ids, confirmedCommands: operation.accepted, stage: command.type, cause: errorResult(error),
          });
        }
      }
      return { ...ids, status: "accepted", protocolVersion: operation.protocolVersion ?? 1, sequences: operation.sequences,
        ...(operation.protocolVersion === 2 ? { results: operation.results ?? [] } : {}),
        next: "Use get_thread to check provider startup, progress, errors, and requests for input. Acceptance does not mean the task completed." };
    });
  }
}
