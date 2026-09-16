import type { z } from "zod";
import type * as c from "./contracts.js";

export type ProtocolVersion = 1 | 2;
export type Command = Record<string, unknown>;
export interface PreparedOperation { threadId: string; commands: Command[] }
export interface CommandResult { sequence?: number; runId?: string; resumed?: boolean }
export interface RuntimeSummary {
  status: string;
  activeRunId: string | null;
  latestRunId: string | null;
  activityRunStatus: string | null;
  lastError: string | null;
  pendingRequest: { id: string; kind: string; createdAt: string } | null;
  pendingBackgroundTaskCount: number;
  historyOrigin: string | null;
}
export type ThreadSummary = z.infer<typeof c.threadSummary> & { runtime?: RuntimeSummary };
export type ThreadDetail = Omit<z.infer<typeof c.threadDetail>, "thread"> & {
  thread: z.infer<typeof c.threadDetail>["thread"] & { runtime?: RuntimeSummary };
  runtimeRequests?: Array<{ id: string; kind: string; status: string; responseCapability: { type: string; reason?: string } }>;
  runtimeRequestsTruncated?: boolean;
  runtimeRequestsSnapshotSequence?: number;
  payloadBudgetExceeded?: boolean;
};
export interface Shell { projects: z.infer<typeof c.project>[]; threads: ThreadSummary[]; snapshotSequence: number }
export interface StartOptions {
  projectId: string; title: string; instructions: string;
  modelSelection: z.infer<typeof c.modelSelection>;
  runtimeMode: z.infer<typeof c.runtimeMode>; interactionMode: z.infer<typeof c.interactionMode>;
}
export interface MessageOptions { threadId: string; instructions: string; mode?: "auto" | "queue" | "steer" | "restart" }
export interface InterruptOptions { threadId: string; turnId?: string; runId?: string }
export interface Orchestration {
  readonly version: ProtocolVersion;
  shell(): Promise<Shell>;
  thread(threadId: string, turnLimit: number, beforeCursor?: string): Promise<ThreadDetail>;
  prepareStart(input: StartOptions): PreparedOperation;
  prepareMessage(input: MessageOptions): Promise<PreparedOperation>;
  prepareInterrupt(input: InterruptOptions): Promise<PreparedOperation>;
  execute(command: Command): Promise<CommandResult>;
}
export interface EnvironmentTransport {
  request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T>;
  rpc<T>(method: string, payload: Command, schema: z.ZodType<T>): Promise<T>;
}
