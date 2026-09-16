import { randomUUID } from "node:crypto";
import * as c from "./contracts.js";
import { BridgeError } from "./errors.js";
import type { Command, EnvironmentTransport, InterruptOptions, MessageOptions, Orchestration, StartOptions } from "./orchestration.js";

export class V1Orchestration implements Orchestration {
  readonly version = 1;
  constructor(private transport: EnvironmentTransport) {}
  shell() { return this.transport.request("/api/orchestration/shell", c.shell); }
  thread(threadId: string, turnLimit = 5, beforeCursor?: string) {
    const query = new URLSearchParams({ turnLimit: String(turnLimit), ...(beforeCursor ? { beforeCursor } : {}) });
    return this.transport.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}?${query}`, c.threadDetail);
  }
  prepareStart(input: StartOptions) {
    const threadId = randomUUID(), createdAt = new Date().toISOString();
    return { threadId, commands: [
      { type: "thread.create", commandId: randomUUID(), threadId, projectId: input.projectId, title: input.title,
        modelSelection: input.modelSelection, runtimeMode: input.runtimeMode, interactionMode: input.interactionMode, branch: null, worktreePath: null, createdAt },
      { type: "thread.turn.start", commandId: randomUUID(), threadId,
        message: { messageId: randomUUID(), role: "user", text: input.instructions, attachments: [] },
        modelSelection: input.modelSelection, runtimeMode: input.runtimeMode, interactionMode: input.interactionMode, createdAt },
    ] };
  }
  async prepareMessage(input: MessageOptions) {
    if (input.mode !== undefined) throw new BridgeError("unsupported_feature", "Explicit message delivery modes require orchestration v2.");
    const { thread } = await this.thread(input.threadId, 1);
    if (thread.id !== input.threadId) throw new BridgeError("identity_mismatch", "The response names another thread.");
    return { threadId: input.threadId, commands: [{ type: "thread.turn.start", commandId: randomUUID(), threadId: input.threadId,
      message: { messageId: randomUUID(), role: "user", text: input.instructions, attachments: [] },
      modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode, createdAt: new Date().toISOString() }] };
  }
  async prepareInterrupt(input: InterruptOptions) {
    if (input.runId !== undefined) throw new BridgeError("unsupported_feature", "Use turnId on orchestration v1; runId requires v2.");
    const { thread } = await this.thread(input.threadId, 1);
    if (thread.id !== input.threadId) throw new BridgeError("identity_mismatch", "The response names another thread.");
    const turnId = input.turnId ?? thread.session?.activeTurnId ?? (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : undefined);
    if (!turnId) throw new BridgeError("no_active_turn", "There is no active turn to interrupt.");
    return { threadId: input.threadId, commands: [{ type: "thread.turn.interrupt", commandId: randomUUID(), threadId: input.threadId, turnId, createdAt: new Date().toISOString() }] };
  }
  execute(command: Command) { return this.transport.request("/api/orchestration/dispatch", c.dispatchResult, command); }
}
