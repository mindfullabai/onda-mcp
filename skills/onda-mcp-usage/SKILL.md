---
name: onda-mcp-usage
description: Best practices for driving Onda (terminal emulator) from Claude Code via the `onda` MCP server (`mcp__onda__*`). Covers workspaces/windows/panes/terminals + buffer reading (read/subscribe/poll/wait_for/send_keys) + spatial awareness (layout/screenshot). Use whenever you call any `mcp__onda__*` tool or the user mentions Onda, pane, workspace, terminal listener, presence badge, inception loop (Claude controlling Onda from inside Onda). Triggers — onda mcp, drive onda, control onda terminal, show pane, workspace layout, onda screenshot, kai watcher, terminal listener.
metadata:
  version: 0.9.0
  source: '@mindfullabai/onda-mcp'
---

# Onda MCP usage skill

## ⛔ STOP — read this before sending anything to a TUI

**A trailing `\n` in `terminal_send` does NOT submit in a TUI textbox. It inserts a newline.**
The text appears on screen, nothing runs, and the session *looks* started when it is not. Silent failure.

| You want to… | ❌ Never | ✅ Always |
|---|---|---|
| Give a task to a TUI agent (claude, codex, qwen) | `terminal_send(text + "\n")` | `onda_agent_prompt(terminalId, prompt)` — writes **and** submits, atomically |
| Press Enter on its own | `terminal_send("\n")` | `send_keys(["Enter"])` |
| Run a command in a **plain shell** | — | `terminal_run` (text + \n) — fine here, a shell *does* execute on newline |

The distinction is **shell vs TUI**, not which tool feels handier. A shell executes on newline; a TUI textbox does not.

### If `agent_spawn` times out: `terminal_list`, never a second spawn

The MCP JSON-RPC client times out at ~60s, but **the backend usually completed anyway** — the workspace, the pane and often the agent itself are already there. The spawn is not lost. On 23 Oct 2026 a blind retry opened a fifth Kai next to four, with the same bus slug.

```
1. terminal_list(workspaceId)            → find what actually got created (live_reason says "agent" if claude runs)
2. agent there:                 agent_prompt(terminalId, prompt)   ← reuse it, no second spawn
3. no agent, idle shell there:  agent_spawn again — it reuses the shell; with Onda ≥ ON18-F4 a spawn
                                that finds the same agent returns reusedAgent: true instead of a duplicate
4. wait:                        wait_for(readyPattern) / agent_wait
5. THE PROMPT:                  agent_prompt(terminalId, prompt)   ← never terminal_send
```

Dropping to `terminal_send` after a spawn timeout is exactly how the 21 Sep 2026 failure happened: workspace right, agent booted, prompt typed into the box — and never submitted. Cost: a silent stall plus a round of debugging, on a task that was otherwise complete.

**Rule of thumb: if the target is a TUI, the prompt goes through `agent_prompt`. No exceptions.**

---

## The mosaic rules (24 Oct 2026 — ON18-F4; rules 3-4 ON24-F4, 25 Oct 2026)

Same rules in the app, the CLI, the MCP and this skill.

1. **Live = an agent or a process.** A workspace is live only when one of its terminals runs an agent session (claude, codex, qwen…) or a foreground program that is not the shell (build, dev server, script). A shell at its prompt is not live, and neither is a pane you are merely subscribed to. `onda_workspace_list`, `onda_pane_list`, `onda_terminal_list` (and `onda workspace list` / `onda list` / `onda pane list` in the CLI) report `live_reason: "agent" | "process" | "none"` plus `live_process` (the program). Detaching a workspace from the mosaic **closes its idle shells** (it leaves Background · live); with an agent or a process running nothing is touched and the row shows the program.
2. **A workspace is born empty.** `workspace_create`, the app and the CLI open no terminal: the tile shows the welcome screen (recent sessions, "New session as …", "Open Terminal"). Whoever wants a terminal opens one: `agent_spawn` (creates the pane), or `workspace_add_terminal` for a plain shell. Never assume a pane exists.
3. **The orchestrator keeps the space (ON24-F4).** The session that orchestrates is where the user reads and writes; the agents it starts work mostly for it, and stay visible but small. After **every** spawn that puts a workspace on screen, call `onda_workspace_tile(layout="main", anchorWorkspaceId=<your workspace, from onda_context>)`: your workspace large on the left (62% of the width by default, `mainPercent` to change it), the delegated agents stacked in a column on the right, two narrow columns past 4 of them. The user should never have to drag tiles around (⇧⌘M does the same from the keyboard, with the focused workspace as the main one). `layout: "grid" | "columns" | "rows"` or `order: [...]` only if asked for another arrangement. It never mounts or detaches anything.
4. **Trial sessions run in the background.** A session you start only to try something (a smoke test of a CLI, a check of a fix, a throwaway agent) and a delegate nobody needs to watch go with `agent_spawn(placement="background")`: the session runs unseen, is listed as live (`onda_workspace_list`: `live_reason` set, `mountedIn: null`; in the app under "Background · live", where a click mounts it), and prompt / wait / close work as usual. Do not put it on screen just to close it a minute later.

`agent_spawn` picks its pane by the same logic: none → creates one; an idle shell → reuses it; **the same agent already in the workspace → no second session**, you get that terminal back with `reusedAgent: true` (`state` "ready" or "busy"). `allowDuplicate: true` only when a second session in the same folder is really wanted (and then give it its own `AB_SESSION_SLUG`).

---

This skill tells you **how to correctly use the `mcp__onda__*` tools** exposed by the `onda-mcp` server (~42 tools as of 0.4.0). It is installed alongside the MCP server. Without this guide you miss non-obvious patterns (subscribe vs read, direction semantics, multi-window orchestration, agent delegation atomic macro, inception loop).

## Compatibility note

New in `@mindfullabai/onda-mcp@0.6.0` (needs an Onda build from 14 Oct 2026 or later, branch `feat/mcp-worktree`; an older host answers `Unknown method` for `workspace.remove` and ignores `worktree` / `removeWorktree`):
- **Worktrees as disposable workspaces**: `onda_agent_spawn(worktree={repoRoot, branch, from?})` creates or reuses the branch's git worktree next to the repo, trusts it for Claude Code and mounts it. `onda_agent_close(removeWorktree=true)` removes it only when clean and merged. See "Worktrees and disposable workspaces" below.
- **`onda_workspace_remove`**: archive (default) or delete a workspace nobody is using.
- **`onda_workspace_list` / `onda_workspace_locate`** now return `archivedAt`, `rootExists`, `hostId` and `worktree`; `workspace_list` hides archived workspaces unless `includeArchived: true`.
- `onda_workspace_prune` and `unmountWhenEmpty` on spawn/close (see "Empty workspaces").
- Fix: a spawn into a workspace it just created/mounted reuses that workspace's fresh shell even while the shell is still loading its profile. Before, the shell read as "busy", a second pane was added, and the orphan shell kept the workspace alive after the agent was gone.

New with Onda ON24-F4 (25 Oct 2026; skill 0.9.0): `onda_workspace_tile(layout="main", mainPercent?)` and `onda_agent_spawn(placement="background")`. An older host answers `invalid_layout` for "main" and treats "background" as a plain "workspace" spawn (the session stays on screen, and the result has no `background` field).

New with Onda ON18-F4 (24 Oct 2026; skill 0.8.0): `live_reason` / `live_process` in the list tools, workspaces born empty, `agent_spawn` with `reusedAgent` / `allowDuplicate` / `addTerminalIfNeeded`, and `onda_workspace_tile` that actually arranges a grid (before it answered success and did nothing). An older host returns no `live_reason`, still opens a terminal on create, and ignores tile.

Also in 0.6.0:
- The server now ships MCP `instructions` (injected into the client system prompt): the agent_* flow is declared canonical there, `onda_launch_session` is marked deprecated in its own description. This skill is the long-form companion; the two must agree.
- **Golden rule promoted to the tool layer**: `onda_agent_prompt` is the ONLY place for the task prompt. Never as argv (see "Never pass the prompt as argv" below — the 14 Jun 2026 failure).
- Merged the hand-maintained additions that lived only in the installed 0.1.0 copy (argv/apostrophe rule, existing-terminal check).

Breaking change in `@mindfullabai/onda-mcp@0.5.0`:
- `onda_agent_spawn` no longer accepts a `prompt` argument. Prompt delivery is now a separate call, `onda_agent_prompt`, gated on a `readyPattern` sync. See "Pattern: agent delegation" below for the new four-tool flow. The split makes the pipeline resilient against TUI cold-start race conditions (trust dialog, splash screen, model picker) that previously caused the Enter keystroke to land on the wrong control.
- `submitDelay` is removed from `onda_agent_spawn` (the spawn never auto-submits anymore). Use `agent_prompt` with `preWriteDelay` if you really need a beat between ready-sync and the write.
- The legacy `onda_launch_session` is unchanged but **deprecated** (0.6.0 marks it so in the tool description). Its `prompt` argv path is exactly the apostrophe trap described below — migrate callers to `agent_spawn` + `agent_prompt`.

New in `@mindfullabai/onda-mcp@0.4.0`:
- **Agent delegation tools**: `onda_agent_spawn` + `onda_agent_wait` + `onda_agent_close` (0.5.0 added `onda_agent_prompt`). Replaces the 6-step manual dance. Three placement modes (workspace / pane-split / same-workspace).

Bug fixes shipped in `@mindfullabai/onda-mcp@0.3.1` + Onda 1.9.1+:
- `terminal_read` now returns the full buffer even on first call (eager tap attach at PTY spawn). Pre-0.3.1 a fresh terminal returned an empty buffer until `subscribe` was active.
- `workspace_add_terminal` now respects `direction='down'` (was silently rewritten to `'row'` whenever the anchor was already in a row split).
- `window_mount_workspace` now actually splices the workspace into the tiled mosaic (pre-fix the registry was updated but the UI tab/tile never appeared). Accepts `direction` ('down'|'right', default 'down') and `anchorWorkspaceId` mirroring the Cmd+P picker. It does not move the user's focus (blue border) unless `focus: true`: the master session keeps the keyboard.

If you are talking to an older host (Onda < 1.9.1), fall back to the legacy patterns: subscribe before run, avoid direction='down' on add_terminal, click-mount via the user. The `agent_spawn` tool will respond with `{error: "Unknown method"}` if the host pre-dates 0.4.0 — fall back to `onda_launch_session` in that case.

## Mental model

You (Claude Code) run inside **a terminal inside Onda**. The `onda-mcp` server talks to the Onda host app via JSON-RPC over UDS at `~/.config/onda/onda.sock`. **Inception loop**: every action through `mcp__onda__*` mutates the app you're running inside. Treat pane/workspace state as **shared mutable** with the user — do not assume it stays the same.

Onda has three layout primitives:
- **Window**: Electron BrowserWindow. N workspaces can coexist in one Window in tiled mode.
- **Workspace**: root folder + collection of panes. Mounted into a Window.
- **Pane**: container with `contentType: terminal | editor | diff`. Terminals have a stable `terminalId` (survives split/merge).

Internal workspace layout = mosaic-component tree. Read it via `onda_workspace_layout`.

## When to use what — cheat sheet

| Goal | Tool |
|---|---|
| "Which workspaces exist" | `onda_workspace_list` |
| "Which Windows are open" | `onda_window_list` |
| "How is workspace X laid out" | `onda_workspace_layout` |
| "I want to see what the user sees" | `onda_window_screenshot` |
| "Open a new terminal right/below pane X" | `onda_workspace_add_terminal` with `direction` + `relativeToPaneId` |
| "Mount workspace W in window X as a new tile" | `onda_window_mount_workspace` with `windowId` + `direction` ('down' or 'right') |
| "Move workspace W from one window to another" | `onda_window_mount_workspace` with target `windowId` (atomic transfer, returns `transferred: true`) |
| "Drop workspace from its window without deleting it" | `onda_workspace_unmount` (registry slot released, PTYs survive) |
| "Bring a window to front" | `onda_window_focus` (omit `windowId` to focus primary) |
| "Boot an agent in a workspace" | `onda_agent_spawn` (mount + add terminal + exec bin + readyPattern sync) |
| "Submit a task prompt to a TUI agent" | `onda_agent_prompt` (after spawn returned ready:true) |
| "Wait until the delegated agent reports done" | `onda_agent_wait` with `doneRegex` |
| "Clean up after a delegation" | `onda_agent_close` (escalation: soft → kill → unmount → close window) |
| "Remove the [Process exited] panes" | `onda_workspace_prune` |
| "Read what the terminal has printed so far" | `onda_terminal_read` (no subscribe needed) |
| "I want to receive every new output chunk" | `subscribe` + `poll` loop |
| "Wait until the build finishes" | `onda_terminal_wait_for` with regex |
| "Press Ctrl+C / Up / Esc" | `onda_terminal_send_keys` (NOT `terminal_send` with `"\x03"`!) |
| "Type a command and run it" | `onda_terminal_run` (text + \n) |
| "Detach listener when done" | `onda_terminal_unsubscribe` (ALWAYS) |
| "Open a workspace and start a Claude session with a task" | `onda_agent_spawn` (boot, flags only) → `onda_agent_prompt` (task text) — see "agent delegation" |
| "Spawn a non-TUI command in a pane" | `onda_agent_spawn` with `execMode="run"`, full command in `agentArgs` |

## Pattern: working with terminal buffer (reads)

Onda 1.9.1+ attaches the MCP tap **eagerly at PTY spawn**, so `terminal_read` and `subscribe.bufferSnapshot` return the full history regardless of when you first ask. The pre-0.3.1 anti-pattern (subscribe-before-run) is no longer required for correctness.

```
✓ run → read                       (run + check, works post-fix)
✓ subscribe → run → poll loop      (live streaming + history snapshot)
✓ wait_for(pattern)                (synchronize on a substring)
```

Ring buffer size:
- **200 KB** when no listener is attached (`read`-only mode)
- **1 MB** when at least one `subscribe` is active (auto-promoted)
- Shrinks back to 200 KB after the last `unsubscribe`, without losing the tap

For high-throughput output (`find /`, `tail -F` on logs) the ring saturates. Use `wait_for` with a precise pattern instead of subscribe + scan.

## Pattern: subscribe + poll loop

```
sub = subscribe(id, listener="kai-watcher")
loop {
  res = poll(sub.sessionId, timeoutMs=15000)
  for chunk in res.chunks: process(chunk.data)
}
unsubscribe(sub.sessionId)
```

`poll` is **long-poll**: unblocks on first `data` event or on timeout. Immediate wake-up on new output. Cursor advances only on successful poll — no replay.

**Mandatory cleanup**: call `unsubscribe` when done. Automatic TTL is 30 min but don't rely on it.

## Pattern: scriptable terminal automation (tmux-style)

```
sub = subscribe(id, "kai-script")           # optional, for log
send_keys(id, ["echo BUILD_START", "Enter"])
wait_for(id, /BUILD_START/)                  # sync barrier
send_keys(id, ["npm test", "Enter"])
wait_for(id, /PASS|FAIL|error/, timeoutMs=120000)
send_keys(id, ["Ctrl+C"])                    # cleanup
unsubscribe(sub.sessionId)
```

Keysyms supported by `send_keys`: `Enter`, `Tab`, `Escape`, `Space`, `Backspace`, `Delete`, `Up/Down/Left/Right`, `Home/End/PageUp/PageDown`, `Insert`, `Ctrl+<letter>`, `F1`-`F12`. Anything else is sent as literal text (useful for `["echo hello", "Enter"]`).

`send_keys` ≠ `terminal_send`: the first maps semantic keysyms → ANSI bytes. The second sends raw text. For `Ctrl+C` ALWAYS use `send_keys(["Ctrl+C"])`.

## Pattern: spatial-aware placement

**Anti-pattern**: spawning panes via `add_terminal` blindly and letting them land randomly. The window grows rightward forever.

**Correct pattern**:
```
layout = workspace_layout(workspaceId)
# layout.paneIds: [...]; layout.activePaneId; layout.viewport
# Decide: stack down for continuous output, split right for parallel-watch
new = workspace_add_terminal(workspaceId,
                              direction="down",
                              relativeToPaneId=layout.activePaneId)
```

`direction` mapping:
- `right` / `left` → side-by-side (left-right pair)
- `down` / `up` → stacked (top-bottom pair)
- `horizontal` = stacked (synonym of `down`)
- `vertical` = side-by-side (synonym of `right`)

Use `down` when the new pane will emit continuous output (logs, build). Use `right` for parallel work terminals.

## Pattern: multi-window mosaic orchestration

A workspace lives in **at most one window at a time**. `window_mount_workspace` is idempotent and handles three cases:

```
1. Workspace unmounted  → direct claim into target window (transferred: false)
2. Already in target     → no-op (transferred: false)
3. Mounted elsewhere     → atomic transfer via unmount-request/ack (transferred: true)
```

```
# Setup: workspace X visible as a tile under the current window
window_mount_workspace(workspaceId=X, windowId=current, direction="down")

# Move workspace X to a fresh window
new_id = window_new().windowId
window_mount_workspace(workspaceId=X, windowId=new_id, direction="down")
# returns { transferred: true }
window_focus(new_id)  # bring the new window to front
```

**A fresh window is not ready at once.** Builds with the fix-workspace-window change wait for it and report success only when the window itself shows the tile; if it never appears the call fails with the reason (and the mount is released). On older builds a mount sent right after `window_new` could be dropped while still answering `success: true` — and `window_list` / `workspace_layout` then agreed, because they read the same registry. There: wait ~3s after `window_new`, and confirm with `window_screenshot` or the window title.

`direction` mirrors the Cmd+P picker semantics: `down` = stack below the anchor workspace (Enter), `right` = side-by-side (Cmd+Enter). `anchorWorkspaceId` lets you pick which existing tile to split next to; default is the target window's current active workspace.

To drop a workspace from its window without destroying it:
```
workspace_unmount(workspaceId=X)
# registry slot freed, workspace still exists in global list
# idle shells inside it are closed (ON18-F4); an agent or a running process keeps it live in the background
```

## Pattern: visual verification

When you need to visually confirm an action succeeded (layout changed, badge appeared, modal opened) use `window_screenshot`:

```
screenshot = window_screenshot(windowId, format="jpeg", quality=72, dataUrl=false)
# returns path; use Read on the image
```

Default `dataUrl=true` returns inline base64 (~1-2 MB), `dataUrl=false` writes a tempfile that `Read` mounts as multimodal image — preferred to avoid wasting context.

## Pattern: agent delegation (PREFERRED, two-call for TUIs)

When you need to delegate work to another Claude session (or any TUI agent) — e.g. Alita @ work-hub asks Kai to refactor something in Orbit — use the four-tool flow: `onda_agent_spawn` → `onda_agent_prompt` → `onda_agent_wait` → `onda_agent_close`. The first two are the meat; `wait` and `close` are observation + cleanup.

### Never pass the prompt as argv (GOLDEN RULE, 14 Jun 2026)

`agentArgs`, `terminal_spawn.args`, `launch_session.prompt` all travel through the pane's **shell** before reaching the agent. A prompt containing an apostrophe (`quest'ordine`, `più'`, `don't`) breaks the zsh parser: the shell drops into `quote>` continuation and the agent never starts — and nothing tells you, the spawn just looks stuck. Italian prose makes this a near-certainty.

`onda_agent_prompt` writes straight into the TUI textbox: **no shell, so apostrophes, quotes and newlines are safe**. Therefore: `agentArgs` = flags only (`["--dangerously-skip-permissions"]`, `["--model","opus"]`), the task always via `agent_prompt`. The only exception is `execMode="run"` for non-TUI binaries (bash, scripts), where the command line *is* the argv — keep those free of unbalanced quotes.

### Check for an existing agent before spawning

`onda_terminal_list(workspaceId)` → an entry with `live_reason: "agent"` and the agent you want means a session is already there: `terminal_read` its tail to see whether it sits at its prompt or is mid-task, and reuse it with `agent_prompt`. Since ON18-F4 `agent_spawn` does this check itself and returns `reusedAgent: true` rather than a duplicate (older hosts opened a NEW pane every time — check by hand there). Avoids orphan panes and duplicate sessions competing on the same repo.

### Reuse the workspace: one folder, one workspace (16 Oct 2026)

**The priority is to reuse a workspace that exists, never to create a second one for the same folder.**

1. **Look the workspace up by `rootPath` first**: `onda_workspace_locate(rootPath=<folder>)`. Onda matches by real path, so `~/work-hub/Projects/X` (symlink) and `~/Projects/X` are the same workspace, and so are `onda` and `Onda` on APFS. With `placement="workspace"` Onda reuses it by itself (`reusedWorkspace: true`), mounted or not: an idle shell in it is reused, the same agent is not started twice, otherwise a new pane is added. Locating first tells you what is already running there.
2. **A second copy of an agent** (e.g. Kai B next to Kai) opens in **that agent's workspace**, with its own bus slug in the command: `agentArgs: ["-lc", "export AB_SESSION_SLUG=<name>; exec claude --model opus --dangerously-skip-permissions"]` (`agentBin: "zsh"`). **Never** in a subfolder created for the purpose: a subfolder is a different workspace, a different Claude project and a different bus identity.
3. Older Onda builds compared the path as text and created duplicates. If `onda_workspace_list` shows two workspaces for one folder, do not create a third: use the mounted / live one. Cleaning duplicates up is the user's (or Alita's) call, not the spawning agent's.

The flow is **split into spawn + prompt** intentionally. Booting a TUI like Claude costs 5-10s and runs through several transient states (trust dialog → splash → welcome → textbox). Submitting the prompt while the TUI is still in trust dialog state means the Enter goes to the dialog, not your prompt. Splitting the two phases gives you a sync point (`readyPattern`) and lets you retry just the prompt if delivery fails, without re-paying the cold start.

```
# 1. Spawn (boot only — no prompt yet)
spawn = agent_spawn(
  placement="workspace",                       # create-or-locate workspace + mount + add terminal
  workspaceRootPath="~/Projects/04-Production/Orbit",
  mountDirection="right",                      # splice the new tile to the right
  agentName="kai-2026-05-23",                  # listener label in pane header
  agentBin="claude",
  agentArgs=["--dangerously-skip-permissions"], # flags only, NOT the task prompt
  readyPattern="❯|Welcome back|Try \"",        # block until Claude TUI textbox is up
  readyTimeoutMs=20000,                        # generous: Claude cold-start
  subscribe=True,                              # default; returns sessionId for agent_wait
)
# → {sessionId, terminalId, paneId, workspaceId, windowId, ready, state, cwd, reusedPane, firstChunk, completedSteps}

# Read `state`, not just `ready` (Onda builds before the fix-agent-spawn change
# return no `state`: then fall back to `ready` + firstChunk as before).
if spawn.state == "trust_prompt":
    # First launch of Claude Code in that folder. Ask the user, or — for a
    # folder you created yourself — spawn again with trust="accept".
    ...
elif spawn.state in ("not_logged_in", "onboarding"):
    # The account needs /login or its first-run setup. Tell the user; do NOT
    # send a prompt, it would be wasted. spawn.hint says what to do.
    ...
elif not spawn.ready:
    # state "timeout": readyPattern never matched. terminal_read the pane to see
    # where it got stuck (bin not found? model picker?), then decide.
    ...

# 2. Submit the task prompt
agent_prompt(
  terminalId=spawn.terminalId,
  prompt="/send kai brief: refactor Authenticator.swift; target test file Tests/AuthTests.swift; report '# DONE' on its own line when green",
  submitWith="enter",                          # default; press Enter to submit
)
# → {success: True, bytesWritten, completedSteps:['write','submit']}

# 3. Wait for the agent to signal completion
result = agent_wait(
  sessionId=spawn.sessionId,
  doneRegex="DONE|BLOCKED",                    # see "doneRegex pattern" below
  timeoutMs=15000,                              # short window, loop if needed
  timeoutMs=600000,                            # 10 min budget
)
# → {matched: True, match: "# DONE", tailContent: "...last 4KB..."}

# 4. Clean up. SOFT (default): unsubscribe only, leave the PTY alive so the
#    user can inspect. MEDIUM (+killPty + terminalId): terminate the agent;
#    the pane agent_spawn created goes with it (closePane removes any other
#    pane, the workspace's last one included).
#    HARD (+unmountWorkspace + workspaceId): drop the workspace tile.
agent_close(sessionId=spawn.sessionId)
agent_close(sessionId=spawn.sessionId, terminalId=spawn.terminalId, killPty=True)
# → {killed: True, workspaceEmpty: True, unmounted: True, removedPaneIds: [...]}
```

### Empty workspaces: when the tile goes away

When no live terminal is left in a workspace after an agent's pane closes (agent_close with killPty/closePane, or the agent exiting on its own), Onda decides whether the workspace leaves the mosaic. Unmount is not delete: it stays in the list.

| Workspace | Agent pane dies, nothing alive left | Override |
|-----------|-------------------------------------|----------|
| Mounted by `agent_spawn` | pane goes, workspace unmounted | `unmountWhenEmpty: false` (on spawn or close) keeps it |
| Already mounted (by the user) | pane goes, workspace stays, empty | `unmountWhenEmpty: true` unmounts it |

- Editor and diff panes count as alive: a workspace holding an open file never unmounts by itself.
- A user's shell that exits stays as "[Process exited]", as always: only agent panes clean up after themselves.
- `"[Process exited]"` panes left next to live ones (exited while the workspace was not on screen, or before a new pane was added): `workspace_prune(workspaceId)` removes every dead terminal pane, whoever opened it, and applies the same unmount rule if nothing is left.

### Worktrees and disposable workspaces

Two or three agents on the same repo: one git worktree per branch, one agent per worktree. **Never two agents in the same folder.**

```python
# Spawn: creates <repoRoot>-<branch> (slashes → dashes) if the branch has no worktree yet,
# with `git worktree add -b <branch> <path> <from>` (no -b if the branch exists);
# marks it trusted in ~/.claude/.claude.json and ~/.claude-a/.claude.json (trust defaults to "accept");
# names the workspace "<agentName or repo> · <branch>", mounts it, boots the agent.
spawn = agent_spawn(placement="workspace", agentBin="claude", agentArgs=["--dangerously-skip-permissions"],
                    agentName="kai-A",
                    worktree={"repoRoot": "/Users/m/Projects/onda", "branch": "feat/login"},  # from= default master|main|develop
                    readyPattern="❯|Welcome back|Try \"")
# → {..., worktree: {path: "/Users/m/Projects/onda-feat-login", branch, created, branchCreated, from}}
agent_prompt(spawn.terminalId, "...")
# ... agent works and commits; you (or the user) merge the branch into master/main/develop ...

# Close: kill, unmount once empty, then — only if the worktree is clean AND its HEAD is already in
# master/main/develop — `git worktree remove` + `git worktree prune`, and the workspace is archived.
agent_close(sessionId=spawn.sessionId, terminalId=spawn.terminalId, killPty=True,
            workspaceId=spawn.workspaceId, removeWorktree=True)
# → {worktreeRemoved: {path, branch, mergedInto}, workspaceArchived: True, ...}
# → or {worktreeKept: {reason: "not_merged" | "dirty" | "mounted" | "live_panes" | ...}}: nothing touched.
```

- The branch is **never** deleted, merged or not.
- Not merged yet? The worktree and the (unmounted) workspace stay. Spawn again with the same `worktree` to resume: the existing worktree is reused and the workspace remounted (restored if archived).
- `worktree` needs `placement="workspace"`; it replaces `workspaceRootPath`. Errors come back as `errorCode: "worktree_failed"` (branch checked out in the main tree, path taken by another folder, not a repo).
- `workspace_list` / `workspace_locate` show `worktree: {repoRoot, branch, isMain, clean, mergedInto}` for any workspace whose folder is a worktree root (null otherwise, and for remote workspaces).

**Cleaning up dead workspaces.** `workspace_list()` → entries with `rootExists: false` (folder gone) and `mountedIn: null` → `workspace_remove(workspaceId)` archives them (reversible from the app; `permanent=True` deletes them from Onda, never the folder). It refuses a mounted workspace (`errorCode: "mounted"`: `workspace_unmount` first) and one with live terminals or unsaved editors (`errorCode: "live_panes"`, with the list). On the Free plan the workspace cap counts **active** workspaces only: archiving frees a slot. Restoring checks the cap again, so `agent_spawn` on the folder of an archived workspace fails with `workspace_limit_reached` when the active ones are at the cap (a worktree that spawn had just created is removed again, `worktree.removedAgain: true`): archive another one first.

### Boot states: what `state` means

`readyPattern` alone used to lie: the trust menu, the login notice and the first-run wizard all draw the `❯` the pattern looks for, so they came back `ready: True`. Now `agent_spawn` names the screen (only the output printed after its command counts, so a reused pane's old screens are ignored):

| `state` | Screen | What to do |
|---------|--------|------------|
| `ready` | Prompt box up | `agent_prompt` |
| `trust_prompt` | "Quick safety check… trust this folder?" (first launch in a folder) | Ask the user, or spawn with `trust="accept"` for a folder you created. `trust="reject"` answers no (Claude exits). Default `trust="report"` touches nothing. |
| `not_logged_in` | "Not logged in · Please run /login", or the login-method picker | Tell the user to log in that account. Don't prompt. |
| `onboarding` | First-run wizard of a fresh account/config dir (theme picker) | Tell the user to finish setup once. Don't prompt. |
| `timeout` | Nothing recognisable within `readyTimeoutMs` | `terminal_read` the pane. |
| `spawned` | No `readyPattern` given: nothing awaited | Only for non-TUI bins. |

Non-ready states come with `needsUserAction: true` and a `hint`. Note: newer Claude Code preselects **"No, exit"** on the trust menu — never answer it with a blind `send_keys(["Enter"])`; use `trust="accept"`, which moves to "Yes" first.

### Where the session starts (placement="workspace")

- The workspace is found **by folder** (`workspaceRootPath`); `workspaceName` is only the label of a newly created one. Two workspaces may share a name — passing a name never picks a different folder.
- No pane at all (a workspace is born empty) → a pane is created.
- A pane idle at a shell prompt (the active one first) → reused, `cd`'d into the root before the agent starts. Busy panes are left alone.
- The same agent already running there → nothing is started: `reusedAgent: true`, prompt that terminal.
- The response says `cwd` (the root the session started in), `reusedPane` and `reusedAgent`.

### doneRegex pattern: match across renderers

Don't be too literal with `# DONE`. TUI agents re-render markdown: Claude turns `# DONE` into a styled bullet `⏺ DONE` (with bold + italic + underline ANSI), qwen prefixes timestamps, codex may emit `[DONE]`. Pick a pattern that survives the visual layer.

Recommended generic patterns for delegated agents:

```
# Most resilient — matches DONE/BLOCKED regardless of bullet, prefix, or styling
doneRegex = "(DONE|BLOCKED|FAILED|ERROR)\\b"

# Conservative — matches the literal sentinel words preceded by whitespace, bullet, or markdown header
doneRegex = "(^|\\s|[#⏺\\-\\*•])\\s*(DONE|BLOCKED|FAILED)\\b"

# Strict — your team enforces "# DONE" / "# BLOCKED" exactly (works when the agent runs in a non-TUI shell, e.g. bash one-shot)
doneRegex = "^# (DONE|BLOCKED)"
```

For Claude TUI specifically, the markdown `# DONE` in the agent's reply becomes `⏺ DONE` on screen. The bullet glyph `⏺` (U+23FA) is the most reliable marker because Claude always renders it before H1 sentinels. Combined patterns work well: `"(⏺|^|^#)\\s*DONE"`.

### Long-running tasks: chunked polling

`agent_wait` blocks server-side until the regex matches or `timeoutMs` elapses. **But the MCP JSON-RPC client has its own timeout (~60s)**: a single `agent_wait(timeoutMs=300000)` call will fail client-side with "Connection timeout" long before the backend would have returned, even if the agent eventually completes in time.

For any task likely to take >30s, do **chunked polling**: loop with a short timeout, check `matched`, repeat until done or your budget is spent.

```
budget = 600  # 10 minutes
elapsed = 0
while elapsed < budget:
    r = agent_wait(sessionId, doneRegex=..., timeoutMs=15000)
    if r.matched:
        break
    elapsed += 15
else:
    # timed out
    ...
```

The session cursor advances on each poll, so you don't re-scan bytes from the previous loop iteration; only new emissions are evaluated.

### Watching an agent through the bus (and what the badge says)

When the agent reports on the agent-bus (its `# DONE` arrives as a bus message), you do not need to loop on `agent_wait`. Two rules:

1. **Check the terminal at least every 15 minutes**, whatever the bus says. Never wait longer (not 90 minutes) between two looks: an agent stuck on a permission prompt, a trust question, a crashed tool or a question to the user sends nothing on the bus, and 15 minutes is the most work you can afford to lose. A look = one `agent_wait(sessionId, doneRegex, timeoutMs=15000)` or `terminal_read(terminalId, lines=40)`. If the screen shows the agent waiting on input, act or tell the user.
2. **Be honest about the subscription.** The pane header shows who is attached to a terminal:
   - solid ring with a halo, solid wire → **reading**: polled in the last 90 s;
   - dashed ring, dashed wire → **attached, not reading**: subscribed, but no poll for over 90 s (you are waiting on the bus between two looks);
   - nothing → nobody attached.

   "Attached, not reading" is the right state while you wait on the bus: do not fake activity with tight polls just to keep it solid. If you stop following the agent altogether, detach (`agent_close(sessionId)`, soft): a subscription nobody reads keeps buffering until the 30-minute idle eviction.

Name the subscription after yourself and the job (`alita-nico-otto`), so the badge and its tooltip say who is attached.

### Chi è fermo: check `state` before you say "Kai works"

`onda_agent_sessions` returns a `state` for every session. Read it BEFORE telling Mario that an agent is working, and before deciding to keep waiting on the bus:

| `state` | What it means | What you do |
|---|---|---|
| `working` | A tool is running or the screen shows the activity line. | Wait. |
| `idle` | At the prompt, empty box (or text typed less than 60 s ago). | Fine if it just reported; if you expected work, look. |
| `pending_input` | **Text sits in the box and nobody pressed Enter, for 60 s+.** The agent is not working. | `terminal_read` to see the text, then `terminal_send_keys(["Enter"])` if it is yours to send; otherwise tell Mario. This is the stuck state that looks like `idle` in `status`. |
| `waiting_permission` / `waiting_answer` | A permission prompt or a question is on screen. | Read the screen; answer it or tell Mario. |
| `exited` | The session ended; the pane may still be alive. | Close or respawn. |

`stateSince` is an ISO timestamp: "stuck for N min" is `now - stateSince`. `mounted: false` means the agent is alive but its workspace is not in any window (Mario cannot see it): the pane is reachable with `onda_window_mount_workspace(workspaceId, windowId)`, or Mario can use the band's "Rimetti nel mosaico". `host` is always `laptop` today.

The 15-minute rule above still holds: `state` is a faster signal, not a replacement. A stuck agent that Onda cannot classify (a custom TUI, a screen it does not recognise) still reads `idle`.

On Mario's screen the same states are badges with their own SHAPE (text cursor = text left in the box, shield = permission, speech bubble = question) and a tooltip like "Testo fermo da 12 min"; after 60 s a `pending_input` also raises one toast per episode.

### Why split spawn + prompt?

Concretely: the alternative (single `agent_spawn` call that also submits the prompt) was tried — `claude --prompt` as argv mostly works for short prompts, but a multi-line / long prompt can land in the textbox while the trust dialog is still active, and the Enter goes to the dialog instead of submitting. The split flow has two side benefits:

1. **Retry-on-failure is cheap**: if `agent_prompt` reports `errorCode: "not_ready"`, you re-call `agent_prompt` (potentially after `terminal_read` to see what's blocking) without ever touching the PTY-spawn cost.
2. **TUI navigation between phases**: occasionally claude shows a model picker or "select profile" screen before the textbox. Between `agent_spawn` (which can target `readyPattern="select profile"`) and `agent_prompt`, the caller can send keys to dismiss it, then proceed. The trust menu is the exception: use `trust="accept"` (see Boot states), not a blind Enter.

### Placement modes

| Mode | When to use |
|------|-------------|
| `workspace` (default) | Long isolated delegation you (or the user) want to watch. New tile alongside yours in the same window; then `workspace_tile(layout="main")`. Survives across delegations. |
| `background` | Trial sessions and delegates nobody needs to watch. Same as `workspace`, but the workspace leaves the mosaic as soon as the terminal runs: live, unseen, one click in "Background · live" mounts it. A workspace already on screen stays there (`background: false` + `backgroundNote`). |
| `pane-split` | Quick parallel work in the SAME workspace you're already in. The agent's cwd is `splitCwd`. Nothing to clean up at the workspace level. |
| `same-workspace` | The target workspace is already mounted (`workspaceId`). Just add another terminal pane to it — useful when several agents share one repo. |

### What `agent.spawn` does NOT do

- **Protocol preamble**: the `prompt` field is sent verbatim (modulo shell-quote). If your team has agent-bus conventions like `# STATUS:`, `/send`, `# DONE` markers — compose them into the prompt yourself before calling. This is intentional: Onda stays opinion-free about agent communication semantics, the agent-bus skill is the source of truth for that vocabulary.
- **Result aggregation**: `agent_wait` returns raw `tailContent`. Parsing structured output (extracting commit hashes, PR URLs, etc.) lives in the caller.
- **Workspace limit handling**: in free/dev builds Onda caps at 2 workspaces. When the cap is reached `agent_spawn` returns `{success: false, errorCode: "workspace_limit_reached", needsUserAction: true, hint: "..."}` — surface that to the user, do not retry blindly.

## Pattern: launching Claude Code in a pane (legacy, manual)

Pre-`agent_spawn` (0.3.x and earlier) pattern. Still works, but verbose. New code should prefer the section above.

```
pane = workspace_add_terminal(workspaceId="...", direction="right")
subscribe(pane.terminalId, "kai-watcher")     # BEFORE launch
terminal_spawn(pane.paneId, bin="claude", args=["--dangerously-skip-permissions"])   # flags ONLY — never the prompt (see golden rule)
# ...wait for the textbox, then terminal_send(text) + send_keys(["Enter"]) to deliver the task
# Claude TUI shows "Trust this folder?" prompt
send_keys(pane.terminalId, ["Enter"])         # confirm default highlighted (1. Yes)
# From here Claude works — use wait_for with expected completion pattern
wait_for(pane.terminalId, /===KAI_CHECK_DONE===/, timeoutMs=120000)
unsubscribe(...)
```

**Claude TUI gotcha**: the stream is VERY noisy (100+ chunks/sec of ANSI spinners). Prefer `wait_for(pattern)` over continuous `poll`. For visual debugging use `screenshot` every 30s, NOT text buffer reads.

## Pattern: drive a remote Claude Code session (auto-pilot)

Use case: Alita just spawned Kai in an adjacent Onda tab and wants to **guide it autonomously** without Mario clicking anything. Pattern validated 21 May 2026.

```
# 1. Spawn (tab_exec or terminal_spawn)
tab_exec(bin="claude", args=["--model","sonnet"], cwd="~/Projects/...")

# 2. Find the terminal ID (filter by workspaceId)
terms = terminal_list(workspaceId="...")
kai_id = terms[-1].id   # last spawned

# 3. Handle trust prompt if first time in that folder
wait_for(kai_id, "trust this folder", timeoutMs=10000)
send_keys(kai_id, ["1", "Enter"])

# 4. Wait for boot completion (welcome screen / inbox banner)
wait_for(kai_id, "Welcome back|Inbox|MVD\\?", timeoutMs=15000)

# 5. Type the prompt in the textbox
terminal_run(kai_id, "You are Kai. Proceed like this: /read msg-... then ...")

# 6. CRITICAL: submit the prompt — terminal_run adds \n but Claude TUI treats \n as newline buffer, NOT submit
send_keys(kai_id, ["Enter"])

# 7. Wait for actual work to start
wait_for(kai_id, "tokens|reading|esc to interrupt", timeoutMs=30000)
```

**Critical submit gotcha**: `terminal_run "msg"` writes `msg\n` but Claude's TUI **interprets `\n` as newline in the multi-line buffer**, not as Submit. ALWAYS follow with `send_keys(["Enter"])` to actually submit. Without it, the prompt stays in editing mode forever.

**Empty buffer gotcha**: `terminal_read` on a freshly spawned terminal returns `content:""` because the passive tap attaches lazily on first call. Use `wait_for` with regex on known output patterns (e.g. "tokens", "Welcome", "Tips") instead of assuming `read` shows everything immediately.

## Pattern: observe remote session completion

After `drive remote session` you need to know WHEN the remote task finishes or hits a milestone, without blocking the current session with a multi-hour `wait_for`.

Decision rule for choosing the pattern:

| Case | Pattern |
|------|---------|
| Task <5 min, can wait blocked | `terminal_wait_for` direct, single-shot |
| Long task (>15 min) with bus available | B. Bus inbox check (target uses `/reply`) |
| Long task, want intermediate milestones | A. Marker pattern + `ScheduleWakeup` |
| Multi-hour task, automatic polling | D. `/loop <interval> /inbox` |
| System-wide background daemon | C. fswatch + osascript (roadmap, not implemented) |

### A. Marker pattern + ScheduleWakeup

Instruct the target session to print explicit markers at milestones:

```
terminal_run(kai_id, "Print markers: ===KAI_PHASE1_DONE===, ===KAI_PHASE2_DONE===, ===KAI_ALL_DONE===")
send_keys(kai_id, ["Enter"])
```

Then periodically:
```
ScheduleWakeup(delaySeconds=900, prompt="check Kai status")
# on wakeup:
out = terminal_read(kai_id, lines=200)
if "===KAI_ALL_DONE===" in out: close coordination
elif "===KAI_PHASE2_DONE===" in out: log progress, wakeup again
```

Pro: granular, intermediate milestones, no extra infra.
Con: depends on target actually printing them; markers may fall out of the 200KB ring buffer.

### B. Bus inbox check (canonical for agent-bus)

Leverage the bus. Target ends task with `/reply <msg-id> response`. Lead receives in `~/.agent-bus/inboxes/<lead>/`. Lead sees the response on next `/inbox` or via SessionStart hook.

```
terminal_run(kai_id, "When done, run /reply <msg-id> response with summary + artifact_refs")

# Passive check:
# - automatic via SessionStart hook agent-bus-load.sh
# - manual: ls ~/.agent-bus/inboxes/alita/ | grep msg-
```

Pro: native, zero infra, audit trail in thread, independent of terminal PID/buffer.
Con: on/off only (done or not), no intermediate milestones.

Combinable with A: markers in terminal for milestones + final `/reply` via bus. Best of both. (Pattern used 21 May 2026 with Kai on Vera's todoist sdk migration brief.)

### D. Recurring /loop

For multi-hour tasks with automatic check:

```
/loop 15m /inbox
```

The loop checks my inbox every 15 min. Combine with B.

Pro: automatic, lightweight, non-blocking.
Con: prompt cache miss every 15 min (cache threshold 5 min), non-zero token cost. For tasks <2h prefer A or passive B.

### Observer anti-patterns

- `terminal_wait_for` with multi-hour `timeoutMs`: blocks current session, you lose useful context.
- Live subscribe to Claude TUI: 100 chunks/sec, saturates listener, burns budget.
- `terminal_read` polling with sleep <60s: cache miss + noise.
- Relying on marker pattern WITHOUT explicitly instructing the target to print them. The target doesn't produce them on its own.

**Dirty ANSI buffer gotcha**: read output contains escape sequences (`[?6n`, `[H`, etc). Don't parse the buffer — only use `wait_for` with regex on known tokens, or `screenshot` if you need visual verification.

## Cleanup discipline

**Always**:
- `unsubscribe(sessionId)` when done reading
- `pane_close(id)` for panes you created as test/scratch (NOT existing user panes — assume they're Mario's)
- Prefix listener names with your identifier (`kai-`, `alita-`, `ci-`) for UI badge legibility

**Never close**:
- The user's original panes
- The user's workspaces (`workspace_focus` to switch is OK, but no `workspace_delete`)
- The user's windows (`window_new` is OK, never close existing ones)

## Anti-pattern catalog

1. **Subscribe to Claude TUI**: nope. Generates 100 chunks/sec of spinner. Use `read` at intervals + `wait_for` for known patterns.
2. **`terminal_send` with raw bytes** (`"\x03"` for Ctrl+C): nope. Use `send_keys(["Ctrl+C"])`.
3. **`workspace_add_terminal` without prior `workspace_layout`**: blind placement. Append-right quickly becomes unreadable.
4. **Listener without unsubscribe**: leak for 30 min TTL. UI badge stays. Clean up.
5. **`window_new`** when the user just wants "one more workspace on the right": NO. Use `window_mount_workspace(workspaceId, windowId=current, direction='right')` to splice it into the existing window as a side-by-side tile. Open a new window only when the user actually wants two separate windows.
9. **Manual 6-step delegation dance** (`workspace_locate` → `workspace_create` → `window_mount_workspace` → `workspace_add_terminal` → `terminal_spawn` → `send_keys Enter` → `terminal_subscribe`): NO. Use `onda_agent_spawn` — it composes all of these atomically and avoids the race conditions where a fail mid-sequence leaves orphaned state.
6. **Assuming `app_info.name === "Onda-dev"`** distinguishes dev vs prod: NO. Use `app_info.path` or an explicit flag.
7. **`terminal_run` alone to submit a prompt to Claude TUI**: NO. The TUI treats `\n` as newline buffer. You must always follow with `send_keys(["Enter"])` to actually submit. (Validated 21 May 2026 spawning a dedicated Kai.)
8. **Spawning Kai and then waiting for Mario to click and type**: anti-pattern. If you spawned the session, you drive it to "Kai is working" (pattern "drive a remote Claude Code session"). Mario shouldn't be a human postman in your agent team.

## Useful knowledge

- Pane header listener badge: who is attached to the terminal. Solid ring + halo = reading, dashed ring = attached but not reading (see "Watching an agent through the bus"); hover for name and last read. A packet runs on the wire each time a poll delivers output.
- Onda-dev runs with bundle id `com.mariomosca.onda.dev` (sandboxed, no collision with prod)
- Onda uses a **single UDS socket**, `~/.config/onda/onda.sock`. Only one Onda instance answers MCP at a time (the first to bind). If `app_info` shows odd data, you may be talking to a different instance.
- The MCP server holds the socket binding until the master Onda app exits — restarting Onda via Cmd+Q + relaunch is how you "promote" another instance to master.

## Tool reference (~42 total)

Application:
- `onda_app_info` — version, pid, paths
- `onda_app_ping` — health check

Window (Electron BrowserWindow):
- `onda_window_list` — N windows + workspaces[] per window
- `onda_window_new` — opens a new empty Window (use with caution, the user prefers same window)
- `onda_window_screenshot` — PNG/JPEG compositor snapshot (see what the user sees)

Workspace:
- `onda_workspace_list` — all workspaces + `mountedIn`
- `onda_workspace_locate` — find by name/id/rootPath
- `onda_workspace_create` — create new (rootPath required)
- `onda_workspace_focus` — switch in focused window
- `onda_workspace_layout` — mosaic tree + paneIds + activePaneId + viewport
- `onda_workspace_add_terminal` — spawn pane with optional direction
- `onda_workspace_tile` — arrange the workspaces mounted in a window: main (anchor large on the left, the others in a column), grid (default, anchor top left, others in order of opening), columns, rows
- `onda_workspace_setLayout` — set custom layout

Pane:
- `onda_pane_list` — panes in window/workspace
- `onda_pane_focus` — focus pane
- `onda_pane_attach` — re-attach a live orphan terminal (alive in `onda_terminal_list`, in no workspace layout) to a new pane of a mounted workspace
- `onda_pane_split` / `vsplit` / `hsplit` — low-level split (prefer `workspace_add_terminal` with `direction`)
- `onda_pane_close` — close pane

Tab (legacy, before tiled-mode-first model):
- `onda_tab_new` / `list` / `close` / `focus` / `exec`

Terminal (control plane):
- `onda_terminal_list` — active terminals
- `onda_terminal_spawn` — exec binary (e.g. `claude`) inside existing pane
- `onda_terminal_send` — write raw text (NO newline)
- `onda_terminal_run` — send + newline
- `onda_terminal_resize` — cols/rows
- `onda_terminal_kill` — terminate PTY
- `onda_terminal_focus` — UI focus

Terminal (read/listen plane, M+1 2026-05-21):
- `onda_terminal_read` — snapshot ring buffer
- `onda_terminal_subscribe` — attach listener, return sessionId
- `onda_terminal_poll` — long-poll new chunks
- `onda_terminal_unsubscribe` — detach
- `onda_terminal_listeners` — who is listening to this terminal
- `onda_terminal_wait_for` — block on regex match
- `onda_terminal_send_keys` — semantic keysym (Ctrl+C, Up, F5, ...)

Session:
- `onda_session_current` — current CLI consumer session
- `onda_launch_session` — atomic macro "open workspace + add terminal + spawn bin" (DEPRECATED, use `onda_agent_spawn`)

Agent delegation (preferred since 0.4.0, split into spawn+prompt in 0.5.0):
- `onda_agent_spawn` — boot an agent in a workspace+pane and return when `readyPattern` matches (or timeout). Returns `sessionId` + `firstChunk`. Does NOT submit a prompt.
- `onda_agent_prompt` — write a prompt into the spawned agent's TUI textbox and submit it. Has its own optional `readyPattern` defensive sync.
- `onda_agent_wait` — block on the spawned agent's sessionId until `doneRegex` matches; returns matched chunk + tail content.
- `onda_agent_close` — escalation cleanup: unsubscribe → kill PTY → close pane → unmount workspace → close window. Each step opt-in via boolean flags; a workspace agent_spawn mounted unmounts by itself once empty (`unmountWhenEmpty` overrides).
- `onda_workspace_prune` — remove the "[Process exited]" panes of a mounted workspace; unmount it if nothing alive is left and the rule above says so.

## Versioning

Skill version: see `metadata.version` in frontmatter. Bump when you add/remove patterns or tools. To reinstall the latest version, run `npx @mindfullabai/onda-mcp install-skill` (TODO) or copy manually from `<onda-mcp-repo>/skills/onda-mcp-usage/`.
