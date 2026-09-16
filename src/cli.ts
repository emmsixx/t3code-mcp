#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClerkAuth } from "./auth.js";
import { Bridge } from "./bridge.js";
import { readConfig } from "./config.js";
import { BridgeError, errorResult } from "./errors.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "serve";
  if (args.length > 1) throw new BridgeError("usage", "No positional credentials or extra arguments are accepted. Run --help.");
  if (["--version", "-v"].includes(command)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (["--help", "-h", "help"].includes(command)) {
    process.stdout.write(`t3code-mcp ${VERSION} — experimental standalone T3 Connect client\n\nCommands:\n  login         Sign in with an email code in this terminal\n  logout        End this bridge's Clerk session and remove local credentials\n  environments  List machines linked to the signed-in account\n  serve         Run the MCP server over stdio (default)\n  --version     Print the installed version\n  --help        Show this help\n\nRequires Node 22+ on Linux or macOS. State: ~/.t3code-mcp (override T3_MCP_STATE_DIR).\nUses T3's existing t3-web public-client profile for relay compatibility.\nNo live coding jobs are launched by login or environments.\n`);
    return;
  }
  const bridge = new Bridge(readConfig());
  if (command === "serve") {
    const server = createServer(bridge);
    await server.connect(new StdioServerTransport());
    return;
  }
  if (command === "login") {
    if (!process.stdin.isTTY) throw new BridgeError("terminal_required", "Run login directly in an interactive terminal. Do not send login codes through MCP or chat.");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write("Sign in to your T3 account for this bridge. Experimental native-client compatibility flow.\n");
    try {
      await bridge.store.locked((state, save) => new ClerkAuth(bridge.config, bridge.http, state, save).login(label => rl.question(label)));
    } finally { rl.close(); }
    process.stderr.write("Account session saved. Checking account discovery…\n");
    const result = await bridge.listEnvironments({ offset: 0, limit: 20, checkAvailability: false });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (command === "logout") {
    await bridge.store.locked((state, save) => new ClerkAuth(bridge.config, bridge.http, state, save).logout());
    process.stderr.write("This bridge's account session has been cleared.\n");
    return;
  }
  if (command === "environments") {
    process.stdout.write(JSON.stringify(await bridge.listEnvironments({ offset: 0, limit: 20, checkAvailability: true }), null, 2) + "\n");
    return;
  }
  throw new BridgeError("usage", "Unknown command. Run t3code-mcp --help.");
}

main().catch(error => {
  process.stderr.write(JSON.stringify(errorResult(error)) + "\n");
  process.exitCode = 1;
});
