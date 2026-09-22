---
title: Timeline view for sessions
---

## App

### New
- **Session timeline:** the sidebar gets a Timeline view with a Grouped/Timeline switch, so recent sessions read as one chronological list.
- **Extensions as the agent's browser:** an installed extension can stand in for the agent's browser, with a Browser provider dropdown in Settings and a live picture in the rail that you can click to take over and hand back to the agent.
- **File previews:** play audio and video, browse CSV tables, inspect fonts, and view diagrams directly in the files panel.
- Files: the agent can open a generated file in the app for you to inspect.

### Improvements
- Mobile: selected-text comments use the composer, with a quote preview and attachment controls; rejected comments keep their draft (thanks to @ChangeHow).
- Sessions: optional animated activity indicators show running sessions across lists, Timeline, tabs, and switchers (thanks to @mattv8).
- Sessions: the session list opens faster and scrolls smoothly through long lists.
- Sessions: idle chats and the work status panel use less memory.
- Reviews: new review sessions inherit the current session's permission auto-accept setting.
- Desktop: the app opens faster, the window shows up right away.
- Mobile: start a new chat directly from the Chats section of the session list.
- Mobile: opening the branch picker keeps the keyboard closed until you search.

### Fixes
- Mobile: Enter adds a new line; buttons and external-keyboard Ctrl/Cmd+Enter send the message (thanks to @ChangeHow).
- Mobile: selecting chat text no longer opens the sessions or workspace drawer by accident (thanks to @ChangeHow).
- Web: switching sessions with two browser tabs open no longer stalls when live updates fall back to HTTP streaming (thanks to @TheUnlimited64).
- Sessions: renaming, sharing, and archiving worktree sessions use the correct folder, and failed actions show the reason.
- Sessions: restored sessions from deleted worktrees remain visible in their project and move to the top after restoration (thanks to @mattv8).
- Dictation: long recovered transcripts scroll within the composer, keeping Retry, Discard, and Insert visible (thanks to @karimodm and @Tobias-Conrad).
- Settings: opening a model picker reveals the selected model, including when its provider was collapsed (thanks to @bashrusakh).
- Mobile: the searchable Settings project picker keeps every project reachable, even in long lists (thanks to @tomzx).
- Git: collapsed unchanged lines expand in pull request comparisons, including files from forks.
- Git: reusing a branch name no longer shows an unrelated old pull request as merged.
- Small Model: ChatGPT sign-in resolves the available Codex Luna model for background tasks.
- Files: previews of files outside the open folder load in browser and remote sessions.
- Files: relative images and links work in Markdown previews, and heading links scroll within the document.
- Chat: an explicit Steer stays a steer after dismissing blockers (thanks to @JustinKeltner).
- Chat: approval cards show file changes that were missing from the preview.
- Chat: comment quote previews fill the available width, and comment highlighting is translucent again.
- Chat: message image export works when a message links to an external page (thanks to @ChangeHow).
- Chat: the timeline popup scrollbar stays clickable while messages load.
- Mobile: Settings help icons respond to taps.
- Mobile: session rows keep their order and branch labels while the sessions drawer closes.
- Startup: when OpenCode fails to start, the app shows what went wrong.
- Desktop: pairing import failures say what actually went wrong, and SSH forms keep focus after confirmations.

### SDK
- Services can declare `service.provides: ["browser"]` to answer the agent's browser actions and `service.surface: true` to show a live picture users can take over and hand back.

## VS Code

### Improvements
- Sessions: optional animated activity indicators show running sessions in the sidebar and switcher (thanks to @mattv8).
- Reviews: new review sessions inherit the current session's permission auto-accept setting.

### Fixes
- Settings: opening a model picker reveals the selected model, including when its provider was collapsed (thanks to @bashrusakh).
- Chat: approval cards show file changes that were missing from the preview.
- Chat: an explicit Steer stays a steer after dismissing blockers (thanks to @JustinKeltner).
- Chat: comment quote previews fill the available width, and comment highlighting is translucent again.
- Chat: message image export works when a message links to an external page (thanks to @ChangeHow).
