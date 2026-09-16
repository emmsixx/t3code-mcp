import { readFileSync } from "node:fs";

// Resolves from both src/ during development and dist/ in an installed package.
const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
export const VERSION = metadata.version;
