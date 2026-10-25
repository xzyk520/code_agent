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
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, createWriteStream } from "node:fs";
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
  const proxy = (process.env.BEE_GITHUB_PROXY || "").replace(/\/$/, "");
  const source = proxy ? `${proxy}/${url}` : url;
  const response = await fetch(source, { redirect: "follow" });
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

const EXTRACT_UNIX_ARCHIVE = String.raw`
import os, shutil, sys, tarfile
archive, dest = sys.argv[1], sys.argv[2]
links = []
with tarfile.open(archive, "r:gz") as tar:
    for member in tar:
        if member.name.startswith("python/"):
            member.name = member.name[len("python/"):]
        if not member.name or member.name.startswith("share/terminfo"):
            continue
        if member.issym() or member.islnk():
            links.append((member.name, member.linkname))
            continue
        tar.extract(member, dest)
for name, target in links:
    if target.startswith("/"):
        continue
    src = os.path.normpath(os.path.join(dest, os.path.dirname(name), target))
    dst = os.path.normpath(os.path.join(dest, name))
    if not src.startswith(os.path.normpath(dest) + os.sep):
        continue
    if os.path.isfile(src):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
print("extracted", len(links), "links as copies")
`;

function hostPython() {
  const candidates = [
    join(root, "runtime", "win32-x64", "python.exe"),
    "python",
    "python.exe",
    "py",
  ];
  for (const candidate of candidates) {
    if (candidate.includes("\\") && !existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ["-c", "import sys; print(sys.version)"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("No host Python found to download target wheels");
}

function wheelPlatformFor(platform) {
  if (platform === "darwin-arm64") return "macosx_11_0_arm64";
  if (platform === "darwin-x64") return "macosx_10_9_x86_64";
  if (platform === "linux-x64") return "manylinux2014_x86_64";
  if (platform === "linux-arm64") return "manylinux2014_aarch64";
  throw new Error(`No wheel platform for ${platform}`);
}

/** Cross-build a Unix runtime on Windows: download target wheels and unpack them. */
function installCrossWheels(runtimeDir, platform) {
  const python = hostPython();
  const wheels = join(tmpdir(), `bee-wheels-${Date.now()}`);
  mkdirSync(wheels, { recursive: true });
  try {
    const args = [
      "-m",
      "pip",
      "download",
      "--dest",
      wheels,
      "--only-binary=:all:",
      "--platform",
      wheelPlatformFor(platform),
      "--python-version",
      "3.11",
      "--implementation",
      "cp",
      "--abi",
      "cp311",
      "--no-cache-dir",
      "httpx>=0.27",
      "pydantic>=2.7",
    ];
    run(python, args);
    const site = join(runtimeDir, "lib", "python3.11", "site-packages");
    mkdirSync(site, { recursive: true });
    for (const entry of readdirSync(wheels)) {
      if (!entry.endsWith(".whl")) continue;
      run(python, ["-m", "zipfile", "-e", join(wheels, entry), site]);
    }
    console.log(`Cross-installed target wheels for ${platform}`);
  } finally {
    rmSync(wheels, { recursive: true, force: true });
  }
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

    const localArchive = process.env.BEE_PYTHON_ARCHIVE;
    let archive;
    if (localArchive && existsSync(localArchive)) {
      archive = localArchive;
      console.log(`Using local Python archive: ${archive}`);
    } else {
      const release = await latestStandalone();
      const asset = release.assets.find((item) =>
        /^cpython-3\.11\..*-install_only\.tar\.gz$/.test(item.name) && item.name.includes(target.target),
      );
      if (!asset) throw new Error(`No Python 3.11 asset for ${target.target}`);
      archive = join(temp, asset.name);
      console.log(`Downloading ${asset.name}...`);
      await download(asset.browser_download_url, archive);
    }
    rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(runtimeDir, { recursive: true });
    if (process.platform === "win32") {
      // Windows tar cannot create the Unix symlinks in the standalone archive.
      // Extract regular files with Python and copy symlink targets as real files.
      run(hostPython(), ["-c", EXTRACT_UNIX_ARCHIVE, archive, runtimeDir]);
    } else {
      run("tar", [
        "-xzf",
        archive,
        "-C",
        runtimeDir,
        "--strip-components=1",
        "--exclude=share/terminfo",
        "--exclude=share/terminfo/*",
      ]);
    }

    // VSIX/ZIP paths are case-insensitive, but the Unix terminfo database ships
    // entries such as 2621A/2621a and Eterm/eterm. The Python core does not need
    // terminfo, so drop the whole directory instead of failing the package step.
    const terminfo = join(runtimeDir, "share", "terminfo");
    if (existsSync(terminfo)) {
      rmSync(terminfo, { recursive: true, force: true });
      console.log("Removed runtime/share/terminfo (case-insensitive VSIX paths).");
    }

    const python = join(runtimeDir, "bin", "python3");
    if (!existsSync(python)) {
      const versioned = readdirSync(join(runtimeDir, "bin")).find((name) => /^python3\.\d+$/.test(name));
      if (versioned) copyFileSync(join(runtimeDir, "bin", versioned), python);
    }
    if (!existsSync(python)) throw new Error(`Python not found after extract: ${python}`);

    if (process.platform === "win32") {
      // We cannot execute a macOS/Linux interpreter on Windows. Download wheels for the
      // target ABI/platform and unpack them into site-packages instead.
      installCrossWheels(runtimeDir, platform);
    } else {
      run(python, ["-m", "pip", "install", "--no-warn-script-location", "httpx>=0.27", "pydantic>=2.7"]);
      run(python, ["-c", "import httpx, pydantic, sys; print('bundled runtime ok:', sys.version)"]);
    }
    console.log(`Bundled runtime ready: ${runtimeDir}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});