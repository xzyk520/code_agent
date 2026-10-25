#!/usr/bin/env node
/**
 * Package one platform-specific VSIX. Only the matching runtime directory is shipped.
 *
 * Usage: node scripts/package-platform.mjs win32-x64
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const target = process.argv[2] || `${process.platform}-${process.arch}`;
const allowed = new Set(["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);
if (!allowed.has(target)) throw new Error(`Unsupported VSIX target: ${target}`);

const runtimeRoot = join(root, "runtime");
const targetRuntime = join(runtimeRoot, target);
if (!existsSync(targetRuntime)) {
  throw new Error(`No runtime for ${target}. Run: node scripts/bundle-python.mjs`);
}

// Keep only the target runtime in the tree while packaging; restore afterwards.
const moved = [];
// Rename must stay on the same volume (runtime/ may be on another drive than TEMP).
const hold = mkdtempSync(join(root, ".runtime-hold-"));
try {
  for (const entry of readdirSync(runtimeRoot)) {
    if (entry === target) continue;
    renameSync(join(runtimeRoot, entry), join(hold, entry));
    moved.push(entry);
  }

  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const outDir = join(root, "dist-vsix");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `bee-code-${version}-${target}.vsix`);
  const vsce = join(root, "node_modules", "@vscode", "vsce", "vsce");
  execFileSync(process.execPath, [vsce, "package", "--no-dependencies", "--target", target, "--out", out], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(`Packaged: ${out}`);
} finally {
  for (const entry of moved) {
    renameSync(join(hold, entry), join(runtimeRoot, entry));
  }
  rmSync(hold, { recursive: true, force: true });
}