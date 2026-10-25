import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",  
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"], 
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
