import { mkdir, readFile, writeFile, rename, rm, chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "./errors.js";

const pendingLoginSchema = z.object({
  loginId: z.uuid(), signInId: z.string(), expiresAt: z.number(),
  factor: z.enum(["preparing", "email_code", "totp"]),
});
const authSchema = z.object({
  binding: z.string(), clientJwt: z.string(), sessionId: z.string().optional(), accountId: z.string().optional(),
  pendingLogin: pendingLoginSchema.optional(),
});
const operationSchema = z.object({
  fingerprint: z.string(), environmentId: z.string(), threadId: z.string(),
  commands: z.array(z.record(z.string(), z.unknown())),
  accepted: z.number().int().nonnegative(), sequences: z.array(z.number()),
  protocolVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  results: z.array(z.object({ sequence: z.number().optional(), runId: z.string().optional(), resumed: z.boolean().optional() })).optional(),
});
const stateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), auth: authSchema.optional(),
  privateJwk: z.record(z.string(), z.string()).optional(),
  operations: z.record(z.string(), operationSchema),
});
export type State = z.infer<typeof stateSchema>;
export type Operation = z.infer<typeof operationSchema>;

export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(public dir: string) {}

  async locked<T>(run: (state: State, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const lock = join(this.dir, "lock");
    let acquired = false;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      if ((await lstat(this.dir)).isSymbolicLink()) throw new BridgeError("unsafe_state", "The state directory must not be a symbolic link.");
      await chmod(this.dir, 0o700);
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new BridgeError("state_busy", "Another bridge operation owns the state lock. If a process crashed, stop it and remove the lock directory before retrying.");
      }
      const path = join(this.dir, "state.json");
      let state: State = { version: 1, operations: {} };
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
          throw new BridgeError("unsafe_state", "Credential state must be a regular file readable only by its owner (mode 0600).");
        }
        const decoded = stateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        if (!decoded.success) throw new BridgeError("invalid_state", "The bridge state file has an unsupported format.");
        state = decoded.data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const save = async () => {
        const temp = join(this.dir, `.state-${randomUUID()}.tmp`);
        try {
          await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
          const handle = await open(temp, "r");
          try { await handle.sync(); } finally { await handle.close(); }
          await rename(temp, path);
        } finally { await rm(temp, { force: true }); }
      };
      return await run(state, save);
    } finally {
      try { if (acquired) await rm(lock, { recursive: true, force: true }); }
      finally { release(); }
    }
  }
}
