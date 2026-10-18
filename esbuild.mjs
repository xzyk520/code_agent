// esbuild 构建脚本：只擦类型、不检查类型（类型检查靠 `npm run typecheck`）
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",           // VS Code 用 require() 加载 main → 必须是 CJS
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],    // 由扩展宿主注入，绝不能打包进来
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] watching src/ ...");
} else {
  await esbuild.build(options);
  console.log(`[esbuild] build done → dist/extension.js (${production ? "production" : "development"})`);
}
