import { build } from "esbuild";

import fs from "node:fs";

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  external: ["@modelcontextprotocol/sdk"],
};

const entries = [
  { entryPoints: ["server.ts"], outfile: "dist/server.js" },
];

if (fs.existsSync("launcher.ts")) {
  entries.push({ entryPoints: ["launcher.ts"], outfile: "dist/launcher.js" });
}

await Promise.all(entries.map(e => build({ ...shared, ...e })));

// Write cli.js as a simple CJS wrapper (shebang + ESM import doesn't work on Node v24)
fs.writeFileSync("dist/cli.js", `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === "start") {
  import("./server.js");
} else if (cmd === "new") {
  process.env.WECHAT_SETUP_NEW = process.argv[3] || "";
  import("./launcher.js");
} else if (cmd === "run") {
  process.env.WECHAT_RUN_PROFILE = process.argv[3] || "";
  import("./launcher.js");
} else {
  import("./launcher.js");
}
`);
fs.chmodSync("dist/cli.js", 0o755);

console.log("Build complete: dist/cli.js, dist/server.js, dist/launcher.js");
