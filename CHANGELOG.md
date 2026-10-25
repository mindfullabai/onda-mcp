# Changelog

## 0.7.0 (unreleased)

Needs an Onda build with ON24-F4 (branch `feat/on24-f4-layout`, 25 Oct 2026). An older host answers `invalid_layout` for "main" and runs "background" as a plain "workspace" spawn.

### Features

- **`onda_workspace_tile` `layout: "main"`** (+ `mainPercent`, default 62, 30-85): the anchor takes that share of the width for the whole height, the other mounted workspaces stack in a column on its right with equal heights, two narrow columns past 4 of them. The result adds `main: { percent, side, sideColumns }`. Same arrangement in the app (⇧⌘M, command palette) and the CLI (`onda workspace tile main --anchor <ws> --main <percent>`).
- **`onda_agent_spawn` `placement: "background"`**: as "workspace", but a workspace that was not on screen leaves the mosaic once its terminal runs. The session lives on unseen, is listed as live (`mountedIn: null`) and mounts with a click under "Background · live". The result carries `background: true`, or `false` + `backgroundNote` when the workspace was already on screen.
- Skill `onda-mcp-usage` 0.9.0: after each spawn, `workspace_tile(layout="main")` with the orchestrator as anchor; trial sessions always in the background.

## 0.6.0 (unreleased)

Needs an Onda build from 14 Oct 2026 or later (`onda-electron` branch `feat/mcp-worktree`). Older hosts answer `Unknown method` for `workspace.remove` and ignore the new parameters.

### Features

- **`onda_agent_spawn` `worktree: { repoRoot, branch, from? }`**: runs the agent in its own git worktree. Creates `<repoRoot>-<branch>` (slashes become dashes) with `git worktree add` if the branch has none, or reuses the existing one; marks the folder trusted in `~/.claude/.claude.json` and `~/.claude-a/.claude.json`; names the workspace `<agentName or repo> · <branch>`. The result reports `worktree: { path, branch, created, branchCreated, from? }`.
- **`onda_agent_close` `removeWorktree: true`**: after the kill, unmounts the workspace once empty and, only when the worktree is clean and its branch is already in master/main/develop, runs `git worktree remove` + `prune` and archives the workspace. Otherwise touches nothing and returns `worktreeKept: { reason }`. The branch is never deleted.
- **`onda_workspace_remove`**: archives (default) or deletes (`permanent`) a workspace that is not mounted and holds no live terminal or unsaved editor; otherwise refuses with `errorCode` `mounted` / `live_panes`.
- **`onda_workspace_list`** takes `includeArchived` (default false) and every entry carries `archivedAt`, `hostId`, `rootExists` and `worktree: { repoRoot, branch, isMain, clean, mergedInto }`. `onda_workspace_locate` returns the same fields.
- **`onda_workspace_prune`** and `unmountWhenEmpty` on `onda_agent_spawn` / `onda_agent_close`: dead "[Process exited]" panes go, and a workspace the agent mounted leaves the mosaic once nothing alive is left.
- **`onda_agent_sessions`** answers WHO IS STUCK: every entry carries `state` (`working | idle | waiting_permission | waiting_answer | pending_input | exited`), `stateSince`, `mounted`, `windowId` and `host`. `pending_input` is text left in the prompt box without Enter for 60 s. `status` stays for compatibility. Needs an Onda build from `feat/agent-pending-input`.
- The server ships MCP `instructions`; `onda_launch_session` is marked deprecated.

### Fixes (host side)

- A spawn into a workspace it just created or mounted reuses that workspace's fresh shell even while the shell is still loading its profile. Before, the shell read as busy, a second pane was added, and the orphan shell kept the workspace alive after the agent was gone.
- An archived workspace no longer stays the active one.
- Free plan: the workspace cap counts active workspaces only (archiving frees a slot); restoring an archived workspace checks the cap again, from the UI, from `createWorkspace` on an archived folder and from `agent_spawn` (`errorCode: workspace_limit_reached`, and a worktree the spawn had just created is removed again).

### Docs

- Skill `onda-mcp-usage` 0.7.1: "Watching an agent through the bus" — check the terminal at least every 15 minutes even when the agent reports on the bus, and what the presence badge says (solid ring = reading, dashed ring = attached but not reading).

## 0.5.1

Last published version.
