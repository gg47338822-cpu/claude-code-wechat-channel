import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  external: ["@modelcontextprotocol/sdk"],
  banner: { js: "#!/usr/bin/env node" },
};

const entries = [
  { entryPoints: ["server.ts"], outfile: "dist/server.js" },
];

// Only build launcher if it exists
try {
  const fs = await import("node:fs");
  if (fs.existsSync("launcher.ts")) {
    entries.push({ entryPoints: ["launcher.ts"], outfile: "dist/launcher.js" });
  }
} catch {}

await Promise.all(entries.map(e => build({ ...shared, ...e })));

console.log("Build complete: dist/server.js, dist/launcher.js");
