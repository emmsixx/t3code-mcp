import { z } from "zod";
import type { threadSummary } from "./contracts.js";

export const threadStatus = z.enum([
  "working", "connecting", "awaiting_approval", "awaiting_input", "plan_ready", "monitoring",
  "finished", "failed", "interrupted", "stopped", "idle", "unknown",
]);
type Thread = z.infer<typeof threadSummary>;
const sessionStates = new Set(["idle", "starting", "running", "ready", "interrupted", "stopped", "error"]);
const turnStates = new Set(["running", "interrupted", "completed", "error"]);

// Derived from one shell snapshot. Never infer task success from an idle provider.
export function resolveThreadStatus(thread: Thread): z.infer<typeof threadStatus> {
  if (thread.hasPendingApprovals) return "awaiting_approval";
  if (thread.hasPendingUserInput) return "awaiting_input";
  const session = thread.session?.status;
  const turn = thread.latestTurn?.state;
  // A new active session can precede the latest-turn projection updating.
  if (session === "running") return "working";
  if (session === "starting") return "connecting";
  if (session === "error") return "failed";
  if ((session !== undefined && !sessionStates.has(session)) || (turn !== undefined && !turnStates.has(turn))) return "unknown";
  if (turn === "error") return "failed";
  if (turn === "running" && session !== "stopped" && session !== "interrupted") return "working";
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan && turn === "completed") return "plan_ready";
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  if (thread.backgroundLiveness != null) return "unknown";
  if (session === "interrupted" || turn === "interrupted") return "interrupted";
  if (turn === "completed") return "finished";
  if (session === "stopped") return "stopped";
  return "idle";
}

export function lastActivityAt(thread: Thread): string | null {
  const dates = [thread.createdAt, thread.updatedAt, thread.latestUserMessageAt, thread.session?.updatedAt,
    thread.latestTurn?.requestedAt, thread.latestTurn?.startedAt, thread.latestTurn?.completedAt];
  let latest: string | null = null;
  for (const date of dates) {
    if (date && Number.isFinite(Date.parse(date)) && (latest === null || Date.parse(date) > Date.parse(latest))) latest = date;
  }
  return latest;
}

export function threadAttention(thread: Thread | undefined) {
  const status = thread ? resolveThreadStatus(thread) : "unknown";
  return {
    status,
    waitingForApproval: thread?.hasPendingApprovals ?? null,
    waitingForInput: thread?.hasPendingUserInput ?? null,
    hasActionableProposedPlan: thread?.hasActionableProposedPlan ?? null,
    backgroundLiveness: thread?.backgroundLiveness ?? null,
    action: thread && (thread.hasPendingApprovals || thread.hasPendingUserInput || status === "plan_ready")
      ? "Respond in T3's existing client." : null,
  };
}
