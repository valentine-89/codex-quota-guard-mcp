import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedFile } from "../dist/managed.js";
import { profileKey } from "../dist/store.js";

export const installationRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
export const dataRoot = join(installationRoot, "data");

// Validate before creating files, changing ACLs, or purging a profile.
export function installationSettingsPath(codexHome, registeredPath) {
  const expected = managedFile(dataRoot, profileKey(codexHome));
  if (registeredPath !== undefined && (typeof registeredPath !== "string" || resolve(registeredPath) !== expected)) {
    throw Error("Storage path changed: uninstall the previous installation with --purge before installing here. No migration or fallback is supported.");
  }
  for (const path of [dataRoot, dirname(expected), expected]) {
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || realpathSync(path) !== path
        || (path === expected ? !info.isFile() : !info.isDirectory())) {
        throw Error("Refusing redirected or invalid installation data");
      }
    } else {
      // lstat also detects dangling symlinks, which existsSync follows.
      try { lstatSync(path); throw Error("Refusing redirected installation data"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return expected;
}
