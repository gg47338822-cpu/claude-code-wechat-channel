---
name: service
description: Install or uninstall wechat-channel as a macOS LaunchDaemon for auto-start on boot
user_invocable: true
arguments:
  - name: action
    description: "install or uninstall"
    required: true
---

# /service — LaunchDaemon Management

## /service install

Install wechat-channel launcher as a macOS LaunchDaemon so it starts automatically on boot.

Steps:

1. Find the absolute path to the launcher binary:
   - Check if `dist/launcher.js` exists in the current plugin directory
   - If installed via npm: use `which wechat-channel` to find the bin path
   - Fall back to the current working directory

2. Find the node binary path: run `which node`

3. Find the claude binary path: run `which claude`

4. Generate the plist file content. The launcher needs node to run, and it spawns claude processes internally. Use this template:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.wechat-channel.launcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>{NODE_PATH}</string>
        <string>{LAUNCHER_JS_PATH}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:{CLAUDE_BIN_DIR}</string>
        <key>HOME</key>
        <string>{USER_HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{USER_HOME}/.claude/channels/wechat/launcher.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{USER_HOME}/.claude/channels/wechat/launcher.stderr.log</string>
</dict>
</plist>
```

Replace the placeholders:
- `{NODE_PATH}` — absolute path to node binary
- `{LAUNCHER_JS_PATH}` — absolute path to dist/launcher.js
- `{CLAUDE_BIN_DIR}` — directory containing the claude binary
- `{USER_HOME}` — user's home directory ($HOME)

5. Write the plist to `~/Library/LaunchAgents/com.wechat-channel.launcher.plist`

6. Load the service: `launchctl load ~/Library/LaunchAgents/com.wechat-channel.launcher.plist`

7. Verify: `launchctl list | grep wechat-channel`

8. Tell the user:
   - Service installed and running
   - Logs at `~/.claude/channels/wechat/launcher.stderr.log`
   - Use `/service uninstall` to remove

## /service uninstall

Remove the LaunchDaemon:

1. Unload: `launchctl unload ~/Library/LaunchAgents/com.wechat-channel.launcher.plist`
2. Delete plist: `rm ~/Library/LaunchAgents/com.wechat-channel.launcher.plist`
3. Confirm removal to user

## Notes
- Uses LaunchAgent (user-level, no sudo required)
- The launcher auto-discovers all profiles in `~/.claude/channels/wechat/profiles/`
- Logs rotate automatically — check stderr log for errors
