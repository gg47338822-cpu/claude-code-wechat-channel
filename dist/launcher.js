// launcher.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
var HOME = process.env.HOME || os.homedir();
var PROFILES_DIR = path.join(HOME, ".claude", "channels", "wechat", "profiles");
var PLUGIN_ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), "..");
var SHUTDOWN_TIMEOUT_MS = 1e4;
var OLD_PACKAGE_NAMES = [
  "@xiaoyifu_0000/wechat-channel"
];
function log(msg) {
  process.stderr.write(`[launcher] ${msg}
`);
}
function logError(msg) {
  process.stderr.write(`[launcher] ERROR: ${msg}
`);
}
function preflight() {
  const errors = [];
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    errors.push(
      `\u274C Node.js \u7248\u672C\u592A\u4F4E\uFF08\u5F53\u524D v${process.versions.node}\uFF0C\u9700\u8981 v18 \u4EE5\u4E0A\uFF09`,
      `   \u{1F449} \u53BB https://nodejs.org \u4E0B\u8F7D\u6700\u65B0\u7248`
    );
  }
  let claudeFound = false;
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3e3 }).trim();
    if (p) claudeFound = true;
  } catch {
  }
  if (!claudeFound) {
    errors.push(
      `\u274C \u672A\u68C0\u6D4B\u5230 Claude Code`,
      `   \u{1F449} \u5B89\u88C5: npm install -g @anthropic-ai/claude-code`
    );
  }
  if (errors.length > 0) {
    process.stderr.write("\n\u73AF\u5883\u68C0\u67E5\u672A\u901A\u8FC7:\n\n");
    for (const line of errors) process.stderr.write(`${line}
`);
    process.stderr.write("\n");
    process.exit(1);
  }
}
function resolveClaudePath() {
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3e3 }).trim();
    if (p) return p;
  } catch {
  }
  logError("\u672A\u627E\u5230 claude \u547D\u4EE4");
  process.exit(1);
}
function discoverProfiles() {
  try {
    return fs.readdirSync(PROFILES_DIR).filter((name) => {
      const dir = path.join(PROFILES_DIR, name);
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "account.json"));
    });
  } catch {
    return [];
  }
}
function loadProfileConfig(profileName) {
  try {
    const f = path.join(PROFILES_DIR, profileName, "profile.json");
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return {};
  }
}
function migrateOldPackageNames(mcpFile) {
  try {
    if (!fs.existsSync(mcpFile)) return false;
    const raw = fs.readFileSync(mcpFile, "utf-8");
    const config = JSON.parse(raw);
    if (!config.mcpServers) return false;
    let migrated = false;
    const servers = config.mcpServers;
    for (const [key, value] of Object.entries(servers)) {
      if (!value?.args) continue;
      const argsStr = value.args.join(" ");
      for (const oldName of OLD_PACKAGE_NAMES) {
        if (argsStr.includes(oldName)) {
          delete servers[key];
          log(`\u8FC1\u79FB: ${mcpFile} \u4E2D\u79FB\u9664\u65E7\u5305\u540D "${oldName}" (key: ${key})`);
          migrated = true;
          break;
        }
      }
    }
    if (migrated) {
      fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2));
    }
    return migrated;
  } catch {
    return false;
  }
}
function migrateAllMcpConfigs() {
  const locations = /* @__PURE__ */ new Set();
  locations.add(path.join(HOME, ".mcp.json"));
  for (const name of discoverProfiles()) {
    const config = loadProfileConfig(name);
    if (config.workdir) {
      locations.add(path.join(config.workdir, ".mcp.json"));
    }
  }
  locations.add(path.join(HOME, ".claude", "channels", "wechat", ".mcp.json"));
  let total = 0;
  for (const loc of locations) {
    if (migrateOldPackageNames(loc)) total++;
  }
  if (total > 0) {
    log(`\u5DF2\u8FC1\u79FB ${total} \u4E2A .mcp.json \u6587\u4EF6\u4E2D\u7684\u65E7\u5305\u540D`);
  }
}
function ensureMcpConfig(dir) {
  const mcpFile = path.join(dir, ".mcp.json");
  let config = {};
  try {
    if (fs.existsSync(mcpFile)) {
      config = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
    }
  } catch {
    try {
      fs.copyFileSync(mcpFile, `${mcpFile}.bak`);
      log(`\u26A0\uFE0F ${mcpFile} \u683C\u5F0F\u635F\u574F\uFF0C\u5DF2\u5907\u4EFD\u4E3A .mcp.json.bak`);
    } catch {
    }
  }
  if (!config.mcpServers) config.mcpServers = {};
  const serverJsPath = path.join(PLUGIN_ROOT, "dist", "server.js");
  const wechatConfig = fs.existsSync(serverJsPath) ? { command: "node", args: [serverJsPath] } : { command: "npx", args: ["-y", "gg47338822-cpu/claude-code-wechat-channel", "start"] };
  const existing = JSON.stringify(config.mcpServers.wechat ?? null);
  const desired = JSON.stringify(wechatConfig);
  if (existing !== desired) {
    config.mcpServers.wechat = wechatConfig;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2));
    log(`.mcp.json \u5DF2\u66F4\u65B0: ${mcpFile}`);
  } else {
    log(`.mcp.json \u5DF2\u5C31\u7EEA: ${mcpFile}`);
  }
}
function launchClaude(claudePath, cwd, env, extraArgs = []) {
  ensureMcpConfig(cwd);
  return spawn(claudePath, [
    "--dangerously-load-development-channels",
    "server:wechat",
    ...extraArgs
  ], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit"
  });
}
async function main() {
  preflight();
  const args = process.argv.slice(2);
  const claudePath = resolveClaudePath();
  log(`Claude: ${claudePath}`);
  log(`Plugin: ${PLUGIN_ROOT}`);
  migrateAllMcpConfigs();
  if (process.env.WECHAT_UPGRADE_ONLY === "1") {
    log("\u5347\u7EA7\u68C0\u67E5\u5B8C\u6210");
    process.exit(0);
  }
  const allProfiles = discoverProfiles();
  const setupNew = process.env.WECHAT_SETUP_NEW;
  if (allProfiles.length === 0 || setupNew !== void 0) {
    const profileName = setupNew || "default";
    const autoName = profileName || `wechat-${allProfiles.length + 1}`;
    if (allProfiles.includes(autoName)) {
      logError(
        `profile "${autoName}" \u5DF2\u5B58\u5728\uFF0C\u4E0D\u80FD\u8986\u76D6\u3002
   \u{1F449} \u7528\u65B0\u540D\u5B57: wechat-channel new <\u5176\u4ED6\u540D\u5B57>
   \u{1F449} \u5982\u8981\u5220\u9664\u65E7\u7684: rm -rf ${path.join(PROFILES_DIR, autoName)}`
      );
      process.exit(1);
    }
    log(`\u8BBE\u7F6E\u65B0 profile: ${autoName}`);
    const profileDir = path.join(PROFILES_DIR, autoName);
    fs.mkdirSync(path.join(profileDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(profileDir, "media"), { recursive: true });
    log(`profile\u76EE\u5F55\u5DF2\u521B\u5EFA: ${profileDir}`);
    const serverJs = path.join(PLUGIN_ROOT, "dist", "server.js");
    log("\u542F\u52A8\u626B\u7801\u767B\u5F55...");
    const loginCode = await new Promise((resolve) => {
      const child = spawn("node", [serverJs], {
        cwd: path.join(HOME, ".claude", "channels", "wechat"),
        env: {
          ...process.env,
          WECHAT_CHANNEL_PROFILE: autoName,
          WECHAT_LOGIN_ONLY: "1"
        },
        stdio: "inherit"
      });
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (loginCode !== 0) {
      logError("\u767B\u5F55\u5931\u8D25\u6216\u8D85\u65F6\u3002\u8BF7\u91CD\u65B0\u8FD0\u884C wechat-channel new " + autoName);
      process.exit(1);
    }
    const credentialsFile = path.join(profileDir, "account.json");
    if (!fs.existsSync(credentialsFile)) {
      logError("\u626B\u7801\u6D41\u7A0B\u7ED3\u675F\u4F46\u672A\u4FDD\u5B58\u51ED\u636E\u3002\u8BF7\u91CD\u8BD5\u3002");
      process.exit(1);
    }
    log("\u767B\u5F55\u6210\u529F\uFF01");
    log("\u6B63\u5728\u542F\u52A8Claude...");
    const setupDir = path.join(HOME, ".claude", "channels", "wechat");
    const proc = launchClaude(claudePath, setupDir, {
      WECHAT_CHANNEL_PROFILE: autoName
    });
    proc.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  const runProfile = process.env.WECHAT_RUN_PROFILE;
  if (runProfile !== void 0) {
    const name = runProfile;
    if (!name) {
      logError(`\u7528\u6CD5: wechat-channel run <profile\u540D>
\u53EF\u7528: ${allProfiles.join(", ")}`);
      process.exit(1);
    }
    if (!allProfiles.includes(name)) {
      logError(`profile "${name}" \u4E0D\u5B58\u5728\u3002\u53EF\u7528: ${allProfiles.join(", ")}`);
      process.exit(1);
    }
    log(`\u542F\u52A8 profile: ${name}`);
    const config = loadProfileConfig(name);
    const workdir = config.workdir || process.cwd();
    const proc = launchClaude(claudePath, workdir, {
      WECHAT_CHANNEL_PROFILE: name,
      CLAUDE_ROLE: name
    });
    proc.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  const profilesToStart = allProfiles;
  if (profilesToStart.length === 0) {
    logError("\u6CA1\u6709\u53EF\u542F\u52A8\u7684 profile");
    process.exit(1);
  }
  log(`\u542F\u52A8 ${profilesToStart.length} \u4E2A profile: ${profilesToStart.join(", ")}`);
  const states = /* @__PURE__ */ new Map();
  for (const name of profilesToStart) {
    const config = loadProfileConfig(name);
    const workdir = config.workdir || process.cwd();
    const proc = launchClaude(claudePath, workdir, {
      WECHAT_CHANNEL_PROFILE: name,
      CLAUDE_ROLE: name
    });
    log(`${name} \u5DF2\u542F\u52A8 (pid: ${proc.pid}, cwd: ${workdir})`);
    states.set(name, proc);
    proc.on("exit", (code) => {
      log(`${name} \u5DF2\u9000\u51FA (code: ${code})`);
      states.delete(name);
      if (states.size === 0 && !shuttingDown) {
        log("\u6240\u6709 profile \u5DF2\u9000\u51FA");
        process.exit(0);
      }
    });
  }
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\u6B63\u5728\u505C\u6B62 ${states.size} \u4E2A profile...`);
    if (states.size === 0) process.exit(0);
    let remaining = states.size;
    for (const [name, proc] of states) {
      proc.kill("SIGTERM");
      proc.on("exit", () => {
        if (--remaining <= 0) process.exit(0);
      });
    }
    setTimeout(() => {
      logError("\u5F3A\u5236\u9000\u51FA");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
