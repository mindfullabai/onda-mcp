# Changelog

## 0.7.0 (unreleased)

Needs an Onda build with WT30 (2.3 or later, `onda-electron` branch `feat/wt30-*`). The entries below the WT30 ones (formerly headed 0.6.0, 0.7.0 and 0.8.0, never published) ship in this same release. An older host answers `Unknown method` for the new tools, ignores `worktreePath` and answers spawn, close and retire with the old per-worktree workspace fields; a newer host with an older MCP still answers, but the tool descriptions are out of date.

### Features (WT30: one workspace per repo, worktrees as its children)

- **`onda_worktree_activate { workspaceId, path | branch | main }`** (WT30-F5.3): makes a worktree the active one of the repo's workspace (git panel, file panel, status bar, new terminals follow it; focus goes to its first pane). Method `worktree.activate`.
- **`onda_worktree_create { repoRoot | workspaceId, branch, from?, activate? }`**: creates or reuses a branch's worktree without starting an agent. Method `worktree.create`.
- **`onda_workspace_tidy { workspaceId, by: "worktree" }`**: groups the panes of a workspace by worktree. Method `workspace.tidy`.
- **`onda_agent_spawn` with `worktree`** runs the agent in a pane of the repo's workspace, never a workspace per branch. The result has `workspaceId` (the repo's), `paneId` and `worktree.activated`; `workspaceName` is ignored (`workspaceNameIgnored: true`); `labels` are kept per worktree; dedup is per worktree.
- **`onda_agent_close` and `onda_worktree_retire`** close the panes of the retired worktree and never delete or archive the workspace (`panesClosed`). `workspaceDeleted` and `workspaceArchived` are deprecated: always `false`, kept for one release. `onda_worktree_retire` takes `workspaceId` + `path`.
- **`onda_worktree_list`**: rows now carry `isMain`, `isActive`, `panes`, `labels`, `kept` and `hidden`; `workspaceId` is the repo's.
- **`onda_workspace_list` / `onda_workspace_locate`**: `repoRoot` and `worktrees: { count, active, live }`; `locate` on the folder of a linked worktree returns the repo's workspace with `worktree.matched`. The `worktree-retired` archive reason is no longer produced. `onda_workspace_create` on a linked worktree folder opens the repo's workspace.
- **`onda_workspace_focus` and `onda_window_mount_workspace`** take `worktreePath` to activate a worktree.
- **`onda_context`** adds `worktree` (the worktree of the calling pane, null elsewhere).
- Server `instructions` rewritten on the model `Window ⊃ Workspace (a folder; a git repo with its worktrees as children) ⊃ Pane`; skill `onda-mcp-usage` 0.11.0: compatibility note (new host with old MCP and the reverse) and the section "Worktrees inside the repo workspace" replacing "Worktrees and disposable workspaces".

### Earlier unreleased entries in this release

#### DC29 (formerly 0.8.0)

Needs an Onda build with DC29-F3 (`onda-electron` branch `feat/dc29-retire`). An older host answers `Unknown method` for `worktree.retire` / `worktree.list` and ignores `labels`.

### Features

- **`onda_workspace_remove` `mode: "archive" | "delete"`** (DC29-F7.1): the archive is for folders that still exist. Without `mode`, a workspace whose folder is gone is deleted and one whose folder exists is archived; archiving a missing folder is refused (`nothing_to_archive`). `permanent` stays as an alias. Needs an Onda build with DC29-F7 (`feat/dc29-f7-lifecycle`).
- **`onda_workspace_remove_dead`** (DC29-F7.1): deletes every local workspace whose folder is gone, archived ones included, skipping those in use with the reason; `dryRun` lists them.
- **`onda_agent_close`** (DC29-F7.7): an agent spawned with `worktree` is killed and its worktree retired by default (`closedViaRetire: true`); a kept worktree reports the reason and its workspace is archived. `removeWorktree: false` only stops watching. The workspace of a retired worktree is deleted (`workspaceDeleted`), here and in `onda_worktree_retire`.
- **`onda_worktree_retire`**: retires an agent's worktree behind closed-door checks (nothing in use, clean, origin reachable, work in origin's base by merge, squash or merged PR, pushed when only a PR vouches), archive tag pushed, `git worktree remove` without force, branch deleted, workspace deleted (folder gone). `reason` + `checks` when kept; `dryRun` changes nothing.
- **`onda_worktree_list`**: a repo's linked worktrees with `clean`, `integratedInto`, `live`, `workspaceId`, `labels`, `archived`.
- **`onda_agent_spawn` `labels`**: opaque pairs stored on the workspace, returned by spawn, workspace list/locate and worktree list. Spawns over the per-repo cap fail with `worktree_cap`.
- **`onda_agent_close` `removeWorktree`** now runs the retire checks (squash merges recognised, origin's base instead of the local one), branch kept.

#### ON24 (formerly 0.7.0)

Needs an Onda build with ON24-F4 (branch `feat/on24-f4-layout`, 25 Oct 2026). An older host answers `invalid_layout` for "main" and runs "background" as a plain "workspace" spawn.

### Features

- **`onda_workspace_tile` `layout: "main"`** (+ `mainPercent`, default 62, 30-85): the anchor takes that share of the width for the whole height, the other mounted workspaces stack in a column on its right with equal heights, two narrow columns past 4 of them. The result adds `main: { percent, side, sideColumns }`. Same arrangement in the app (⇧⌘M, command palette) and the CLI (`onda workspace tile main --anchor <ws> --main <percent>`).
- **`onda_agent_spawn` `placement: "background"`**: as "workspace", but a workspace that was not on screen leaves the mosaic once its terminal runs. The session lives on unseen, is listed as live (`mountedIn: null`) and mounts with a click under "Background · live". The result carries `background: true`, or `false` + `backgroundNote` when the workspace was already on screen.
- Skill `onda-mcp-usage` 0.9.0: after each spawn, `workspace_tile(layout="main")` with the orchestrator as anchor; trial sessions always in the background.

#### Worktrees and workspace lifecycle (formerly 0.6.0)

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
