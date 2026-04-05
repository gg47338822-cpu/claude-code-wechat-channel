#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === "start") {
  import("./server.js");
} else if (cmd === "new") {
  process.env.WECHAT_SETUP_NEW = process.argv[3] || "";
  import("./launcher.js");
} else if (cmd === "run") {
  process.env.WECHAT_RUN_PROFILE = process.argv[3] || "";
  import("./launcher.js");
} else if (cmd === "upgrade") {
  process.env.WECHAT_UPGRADE_ONLY = "1";
  import("./launcher.js");
} else {
  import("./dashboard.js");
}
