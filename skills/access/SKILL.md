---
name: access
description: Manage WeChat account connection — login, status, setup new profile, edit config
user_invocable: true
arguments:
  - name: action
    description: "login (default), status, setup, or config"
    required: false
---

# /access — WeChat Account Management

## /access or /access login

Connect or reconnect a WeChat account:

1. Call the `wechat_login` tool (no arguments needed)
2. Tell the user a QR code page has been opened in their browser
3. Wait for them to confirm they've scanned and approved
4. Report the result

Notes:
- The QR code expires after 8 minutes
- If login fails, suggest the user try again

## /access status

Check current connection:

1. Call the `wechat_status` tool
2. Display the connection status in a readable format

## /access setup

Create a new WeChat profile from scratch. Guide the user through these steps:

1. Ask for a profile name (e.g., "home", "work", "legal"). Must be a simple alphanumeric string.
2. Ask for the working directory where this Claude instance should operate (e.g., ~/Documents/my-project)
3. Ask for an identity description — who should Claude be when replying via this profile? (e.g., "You are Jason's personal assistant. Speak Chinese. Be warm and concise.")
4. Ask for behavior rules (optional) — any rules Claude must follow (e.g., "Never share private info")
5. Ask for a whitelist of WeChat IDs (optional) — who can send messages to this profile

Then create the profile:

```
~/.claude/channels/wechat/profiles/<name>/profile.json
```

Write the profile.json with the collected information:
```json
{
  "identity": "<identity from step 3>",
  "rules": "<rules from step 4, or empty string>",
  "workdir": "<workdir from step 2>",
  "allow_from": ["<id1>", "<id2>"]
}
```

Also create the directories:
```
~/.claude/channels/wechat/profiles/<name>/memory/
~/.claude/channels/wechat/profiles/<name>/media/
```

After creating the profile, tell the user to run `/access login` to connect the WeChat account.

## /access config

Edit an existing profile's configuration:

1. Call `wechat_status` to identify the current profile
2. Read the profile.json file from the profile directory shown in status
3. Ask the user what they want to change (identity, rules, allow_from, workdir)
4. Update the profile.json file with the changes
5. Tell the user the changes take effect on the next incoming message (hot-reload)

## General Notes
- Profile name is determined by the working directory or WECHAT_CHANNEL_PROFILE env var
- Profile data is stored in `~/.claude/channels/wechat/profiles/<name>/`
- Changes to profile.json are hot-reloaded — no restart needed
