import { homedir } from "node:os";
import { resolve } from "node:path";
import { BridgeError } from "./errors.js";

export function secureOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new BridgeError("invalid_origin", "Use an HTTPS origin, or HTTP on loopback, without credentials, a path, query, or fragment.");
  }
}

export interface Config { clerkOrigin: string; relayOrigin: string; jwtTemplate: string; stateDir: string }

// Public deployment settings from app.t3.codes, verified 2026-09-15. No app secrets.
export function readConfig(env = process.env): Config {
  return {
    clerkOrigin: secureOrigin(env.T3_MCP_CLERK_ORIGIN ?? "https://clerk.t3.codes"),
    relayOrigin: secureOrigin(env.T3_MCP_RELAY_ORIGIN ?? "https://relay.t3.codes"),
    jwtTemplate: env.T3_MCP_JWT_TEMPLATE ?? "t3-relay",
    stateDir: resolve(env.T3_MCP_STATE_DIR ?? resolve(homedir(), ".t3code-mcp")),
  };
}

export function authBinding(config: Config): string {
  return JSON.stringify([config.clerkOrigin, config.relayOrigin, config.jwtTemplate]);
}
