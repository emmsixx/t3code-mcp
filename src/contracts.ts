import { z } from "zod";

export const id = z.string().trim().min(1).max(200);
const optionValue = z.union([z.string().trim().min(1).max(500), z.boolean()]);
export const modelSelection = z.object({ instanceId: id, model: id, options: z.union([
  z.array(z.object({ id, value: optionValue })), z.record(z.string(), optionValue),
]).optional() });
export const runtimeMode = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
export const interactionMode = z.enum(["default", "plan"]);
export const endpoint = z.object({ httpBaseUrl: z.string(), wsBaseUrl: z.string(), providerKind: z.string() });
export const environment = z.object({ environmentId: id, label: z.string(), endpoint, linkedAt: z.string() });
export const environmentList = z.object({ environments: z.array(environment) });
export const tokenResponse = z.object({ access_token: z.string().min(1), token_type: z.literal("DPoP"), expires_in: z.number().positive(), scope: z.string() });
export const connection = z.object({ environmentId: id, endpoint, credential: z.string().min(1), expiresAt: z.string() });
export const project = z.object({ id, title: z.string(), workspaceRoot: z.string(), defaultModelSelection: modelSelection.nullable(), defaultThreadEnvMode: z.string().nullable().optional() });
export const session = z.object({ status: z.string(), activeTurnId: z.string().nullable(), lastError: z.string().nullable(), updatedAt: z.string().optional() });
export const latestTurn = z.object({ turnId: id, state: z.string(), requestedAt: z.string(), startedAt: z.string().nullable(), completedAt: z.string().nullable() });
export const threadSummary = z.object({
  id, projectId: id, title: z.string(), modelSelection, runtimeMode, interactionMode,
  session: session.nullable(), latestTurn: latestTurn.nullable(),
  hasPendingApprovals: z.boolean(), hasPendingUserInput: z.boolean(),
  hasActionableProposedPlan: z.boolean().optional(), backgroundLiveness: z.string().nullable().optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(), latestUserMessageAt: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
});
export const shell = z.object({ projects: z.array(project), threads: z.array(threadSummary), snapshotSequence: z.number() });
export const threadDetail = z.object({
  snapshotSequence: z.number(),
  thread: z.object({
    id, projectId: id, title: z.string(), modelSelection, runtimeMode, interactionMode,
    session: session.nullable(), latestTurn: latestTurn.nullable(),
    messages: z.array(z.object({ id, role: z.enum(["user", "assistant", "system"]), text: z.string(), streaming: z.boolean(), createdAt: z.string() })),
    activities: z.array(z.object({ id, kind: z.string(), tone: z.string(), summary: z.string(), payload: z.unknown(), createdAt: z.string() })),
  }),
  page: z.object({ beforeCursor: z.string().nullable(), hasMore: z.boolean() }).optional(),
});
export const dispatchResult = z.object({ sequence: z.number().int().nonnegative() });
