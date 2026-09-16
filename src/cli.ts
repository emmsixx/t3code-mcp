#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClerkAuth, loginStartInput, loginVerifyInput } from "./auth.js";
import { Bridge } from "./bridge.js";
import { readConfig } from "./config.js";
import { BridgeError, errorResult } from "./errors.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

function inputValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BridgeError("invalid_input", "Invalid login input. Run --help for the JSON fields; verification codes must contain six digits.");
  return parsed.data;
}

async function readInput<T>(schema: z.ZodType<T>): Promise<T> {
  if (process.stdin.isTTY) throw new BridgeError("stdin_required", "Pass a JSON object through stdin, or use login for interactive prompts.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8192) throw new BridgeError("invalid_input", "Login input exceeds 8 KB.");
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new BridgeError("invalid_input", "Pass one JSON object through stdin. Run --help for its fields."); }
  return inputValue(schema, value);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "serve";
  if (args.length > 1) throw new BridgeError("usage", "No positional credentials or extra arguments are accepted. Run --help.");
  if (["--version", "-v"].includes(command)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (["--help", "-h", "help"].includes(command)) {
    process.stdout.write(`t3code-mcp ${VERSION} — experimental standalone T3 Connect client\n\nCommands:\n  login         Sign in with an email code in this terminal\n  login-start   Send an email code; read {"email":"..."} from stdin\n  login-verify  Submit {"loginId":"...","factor":"email_code|totp","code":"..."} from stdin\n  login-status  Check the saved session or resume a pending login\n  logout        End this bridge's session or discard a pending login\n  environments  List machines linked to the signed-in account\n  serve         Run the MCP server over stdio (default)\n  --version     Print the installed version\n  --help        Show this help\n\nAgent login commands return JSON status; they never print session tokens.\nRequires Node 22+ on Linux or macOS. State: ~/.t3code-mcp (override T3_MCP_STATE_DIR).\nUses T3's existing t3-web public-client profile for relay compatibility.\nNo live coding jobs are launched by login or environments.\n`);
    return;
  }
  const bridge = new Bridge(readConfig());
  const auth = <T>(run: (client: ClerkAuth) => Promise<T>) => bridge.store.locked((state, save) => run(new ClerkAuth(bridge.config, bridge.http, state, save)));
  if (command === "serve") {
    const server = createServer(bridge);
    await server.connect(new StdioServerTransport());
    return;
  }
  if (command === "login") {
    if (!process.stdin.isTTY) throw new BridgeError("terminal_required", "Use login in an interactive terminal, or login-start and login-verify with JSON stdin for agent-guided setup.");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write("Sign in to your T3 account for this bridge. Experimental native-client compatibility flow.\n");
    try {
      let status = await auth(client => client.loginStatus());
      if (status.status === "signed_out") {
        const input = inputValue(loginStartInput, { email: await rl.question("T3 account email: ") });
        status = await auth(client => client.loginStart(input));
      }
      while (status.status === "code_required") {
        const code = await rl.question(status.factor === "email_code" ? "Email verification code: " : "Authenticator code: ");
        const input = inputValue(loginVerifyInput, { loginId: status.loginId, factor: status.factor, code });
        status = await auth(client => client.loginVerify(input));
      }
      if (status.status !== "signed_in") throw new BridgeError("login_restart_required", "The pending login expired or was not prepared. Run logout, then login again.");
    } finally { rl.close(); }
    process.stderr.write("Account session saved. Checking account discovery…\n");
    const result = await bridge.listEnvironments({ offset: 0, limit: 20, checkAvailability: false });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (command === "login-start" || command === "login-verify" || command === "login-status") {
    let result;
    if (command === "login-start") {
      const input = await readInput(loginStartInput);
      result = await auth(client => client.loginStart(input));
    } else if (command === "login-verify") {
      const input = await readInput(loginVerifyInput);
      result = await auth(client => client.loginVerify(input));
    } else result = await auth(client => client.loginStatus());
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "logout") {
    await auth(client => client.logout());
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
