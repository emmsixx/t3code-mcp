import { z } from "zod";

export const id = z.string().trim().min(1).max(200);
export const endpoint = z.object({ httpBaseUrl: z.string(), wsBaseUrl: z.string(), providerKind: z.string() });
export const environment = z.object({ environmentId: id, label: z.string(), endpoint, linkedAt: z.string() });
export const environmentList = z.object({ environments: z.array(environment) });
export const tokenResponse = z.object({ access_token: z.string().min(1), token_type: z.literal("DPoP"), expires_in: z.number().positive(), scope: z.string() });
