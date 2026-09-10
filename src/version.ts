import { readFileSync } from "node:fs";

/** Shared by source tests and dist runtime; package metadata is the authority. */
export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
