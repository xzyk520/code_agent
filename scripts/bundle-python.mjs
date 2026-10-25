#!/usr/bin/env node
/**
 * Build a self-contained Python runtime for the current platform.
 *
 * Windows: official embeddable distribution (small, isolated ._pth).
 * macOS/Linux: python-build-standalone install_only tarball (portable, relocatable).
 *
 * Usage:
 *   node scripts/bundle-python.mjs
 *   BEE_RUNTIME_TARGET=darwin-arm64 node scripts/bundle-python.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const platform = process.env.BEE_RUNTIME_TARGET || `${process.platform}-${process.arch}`;
const version = process.env.BEE_PYTHON_VERSION || "3.11.9";

function run(file, args) {
  execFileSync(file, args, { stdio: "inherit", cwd: root });
}

function findTarget(platform) {
  const map = {
    "win32-x64": { target: "x86_64-pc-windows-msvc", windows: true },
    "darwin-arm64": { target: "aarch64-apple-darwin", windows: false },
    "darwin-x64": { target: "x86_64-apple-darwin", windows: false },
    "linux-x64": { target: "x86_64-unknown-linux-gnu", windows: false },
    "linux-arm64": { target: "aarch64-unknown-linux-gnu", windows: false },
  };
  const found = map[platform];
  if (!found) throw new Error(`Unsupported runtime target: ${platform}`);
  return found;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function latestStandalone() {
  const response = await fetch("https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest", {
    headers: { "user-agent": "bee-code-build" },
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
  return response.json();
}

async function main() {
  const target = findTarget(platform);
  const runtimeDir = join(root, "runtime", platform);
  const temp = join(tmpdir(), `bee-python-${Date.now()}`);
  mkdirSync(temp, { recursive: true });
  try {
    if (target.windows) {
      run("powershell", ["-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "bundle-python.ps1")]);
      return;
    }

    const release = await latestStandalone();
    const asset = release.assets.find((item) =>
      /^cpython-3\.11\..*-install_only\.tar\.gz$/.test(item.name) && item.name.includes(target.target),
    );
    if (!asset) throw new Error(`No Python 3.11 asset for ${target.target}`);
    const archive = join(temp, asset.name);
    console.log(`Downloading ${asset.name}...`);
    await download(asset.browser_download_url, archive);
    rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(runtimeDir, { recursive: true });
    run("tar", ["-xzf", archive, "-C", runtimeDir, "--strip-components=1"]);

    // VSIX/ZIP paths are case-insensitive, but the Unix terminfo database ships
    // entries such as 2621A/2621a and Eterm/eterm. The Python core does not need
    // terminfo, so drop the whole directory instead of failing the package step.
    const terminfo = join(runtimeDir, "share", "terminfo");
    if (existsSync(terminfo)) {
      rmSync(terminfo, { recursive: true, force: true });
      console.log("Removed runtime/share/terminfo (case-insensitive VSIX paths).");
    }

    const python = join(runtimeDir, "bin", "python3");
    if (!existsSync(python)) throw new Error(`Python not found after extract: ${python}`);
    run(python, ["-m", "pip", "install", "--no-warn-script-location", "httpx>=0.27", "pydantic>=2.7"]);
    run(python, ["-c", "import httpx, pydantic, sys; print('bundled runtime ok:', sys.version)"]);
    console.log(`Bundled runtime ready: ${runtimeDir}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});