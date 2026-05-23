---
name: onda-mcp-usage
description: Best practices for driving Onda (terminal emulator) from Claude Code via the `onda` MCP server (`mcp__onda__*`). Covers workspaces/windows/panes/terminals + buffer reading (read/subscribe/poll/wait_for/send_keys) + spatial awareness (layout/screenshot). Use whenever you call any `mcp__onda__*` tool or the user mentions Onda, pane, workspace, terminal listener, presence badge, inception loop (Claude controlling Onda from inside Onda). Triggers — onda mcp, drive onda, control onda terminal, show pane, workspace layout, onda screenshot, kai watcher, terminal listener.
metadata:
  version: 0.5.0
  source: '@mindfullabai/onda-mcp'
---

# Onda MCP usage skill

This skill tells you **how to correctly use the `mcp__onda__*` tools** exposed by the `onda-mcp` server (~42 tools as of 0.4.0). It is installed alongside the MCP server. Without this guide you miss non-obvious patterns (subscribe vs read, direction semantics, multi-window orchestration, agent delegation atomic macro, inception loop).

## Compatibility note

Breaking change in `@mindfullabai/onda-mcp@0.5.0`:
- `onda_agent_spawn` no longer accepts a `prompt` argument. Prompt delivery is now a separate call, `onda_agent_prompt`, gated on a `readyPattern` sync. See "Pattern: agent delegation" below for the new four-tool flow. The split makes the pipeline resilient against TUI cold-start race conditions (trust dialog, splash screen, model picker) that previously caused the Enter keystroke to land on the wrong control.
- `submitDelay` is removed from `onda_agent_spawn` (the spawn never auto-submits anymore). Use `agent_prompt` with `preWriteDelay` if you really need a beat between ready-sync and the write.
- The legacy `onda_launch_session` is unchanged and still accepts the v2 `prompt` argv + auto-submit semantics; use it if you have existing callers you don't want to touch.

New in `@mindfullabai/onda-mcp@0.4.0`:
- **Agent delegation tools**: `onda_agent_spawn` + `onda_agent_wait` + `onda_agent_close` (0.5.0 added `onda_agent_prompt`). Replaces the 6-step manual dance. Three placement modes (workspace / pane-split / same-workspace).

Bug fixes shipped in `@mindfullabai/onda-mcp@0.3.1` + Onda 1.9.1+:
- `terminal_read` now returns the full buffer even on first call (eager tap attach at PTY spawn). Pre-0.3.1 a fresh terminal returned an empty buffer until `subscribe` was active.
- `workspace_add_terminal` now respects `direction='down'` (was silently rewritten to `'row'` whenever the anchor was already in a row split).
- `window_mount_workspace` now actually splices the workspace into the tiled mosaic (pre-fix the registry was updated but the UI tab/tile never appeared). Accepts `direction` ('down'|'right', default 'down') and `anchorWorkspaceId` mirroring the Cmd+P picker.

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
| "Read what the terminal has printed so far" | `onda_terminal_read` (no subscribe needed) |
| "I want to receive every new output chunk" | `subscribe` + `poll` loop |
| "Wait until the build finishes" | `onda_terminal_wait_for` with regex |
| "Press Ctrl+C / Up / Esc" | `onda_terminal_send_keys` (NOT `terminal_send` with `"\x03"`!) |
| "Type a command and run it" | `onda_terminal_run` (text + \n) |
| "Detach listener when done" | `onda_terminal_unsubscribe` (ALWAYS) |
| "Spawn Claude Code in a new pane with a prompt" | `onda_terminal_spawn` with `bin=claude`, `args=[prompt]` |

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

`direction` mirrors the Cmd+P picker semantics: `down` = stack below the anchor workspace (Enter), `right` = side-by-side (Cmd+Enter). `anchorWorkspaceId` lets you pick which existing tile to split next to; default is the target window's current active workspace.

To drop a workspace from its window without destroying it:
```
workspace_unmount(workspaceId=X)
# registry slot freed, workspace still exists in global list
# PTYs inside it stay alive (orphaned terminals) until kill or app restart
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
# → {sessionId, terminalId, paneId, workspaceId, windowId, ready: True, firstChunk, completedSteps:[...,'ready_sync']}

if not spawn.ready:
    # readyPattern didn't match — TUI is in an unexpected state.
    # Inspect spawn.firstChunk to see where it got stuck (trust dialog?
    # model picker? bin not found?). Decide whether to retry, send keystrokes
    # to navigate the dialog, or give up and call agent_close.
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
  doneRegex="^# DONE|^# BLOCKED",
  timeoutMs=600000,                            # 10 min budget
)
# → {matched: True, match: "# DONE", tailContent: "...last 4KB..."}

# 4. Clean up. SOFT (default): unsubscribe only, leave the PTY alive so the
#    user can inspect. MEDIUM (+killPty + terminalId): terminate the agent.
#    HARD (+unmountWorkspace + workspaceId): drop the workspace tile.
agent_close(sessionId=spawn.sessionId)
```

### Why split spawn + prompt?

Concretely: the alternative (single `agent_spawn` call that also submits the prompt) was tried — `claude --prompt` as argv mostly works for short prompts, but a multi-line / long prompt can land in the textbox while the trust dialog is still active, and the Enter goes to the dialog instead of submitting. The split flow has two side benefits:

1. **Retry-on-failure is cheap**: if `agent_prompt` reports `errorCode: "not_ready"`, you re-call `agent_prompt` (potentially after `terminal_read` to see what's blocking) without ever touching the PTY-spawn cost.
2. **TUI navigation between phases**: occasionally claude shows a model picker or "select profile" screen before the textbox. Between `agent_spawn` (which can target `readyPattern="select profile"`) and `agent_prompt`, the caller can send `send_keys(["Enter"])` to dismiss it, then proceed.

### Placement modes

| Mode | When to use |
|------|-------------|
| `workspace` (default) | Long isolated delegation. New tile alongside yours in the same window. Survives across delegations. |
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
terminal_spawn(pane.paneId, bin="claude", args=["--dangerously-skip-permissions", "prompt..."])
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

- Pane header listener badge: blinks blue, click opens popover with "kick" to terminate the session
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
- `onda_workspace_tile` — set layout (split-h, split-v, quad)
- `onda_workspace_setLayout` — set custom layout

Pane:
- `onda_pane_list` — panes in window/workspace
- `onda_pane_focus` — focus pane
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
- `onda_agent_close` — escalation cleanup: unsubscribe → kill PTY → unmount workspace → close window. Each step opt-in via boolean flags.

## Versioning

Skill version: see `metadata.version` in frontmatter. Bump when you add/remove patterns or tools. To reinstall the latest version, run `npx @mindfullabai/onda-mcp install-skill` (TODO) or copy manually from `<onda-mcp-repo>/skills/onda-mcp-usage/`.
