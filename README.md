# @mindfullabai/onda-mcp

MCP server to control [Onda](https://onda.dev) terminal from AI agents (Claude Code, Cursor, Windsurf, etc.)

31 tools across 7 categories let AI agents split panes, run commands, manage tabs and workspaces, coordinate across multiple windows, and orchestrate multi-agent workflows -- all through the standard [Model Context Protocol](https://modelcontextprotocol.io/).

Since v0.2.0 Onda MCP is **multi-window aware**: agents can discover windows, locate workspaces, address terminals unambiguously (each entry carries `windowId` + `workspaceId` + `paneId`), and launch full Claude/agent sessions in one atomic call with the `onda_launch_session` macro.

## Requirements

- **Onda terminal** running with IPC server active (automatic since v1.6)
- Node.js 18+

## Quick Start

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "onda": {
      "command": "npx",
      "args": ["-y", "@mindfullabai/onda-mcp"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "onda": {
      "command": "npx",
      "args": ["-y", "@mindfullabai/onda-mcp"]
    }
  }
}
```

### Cursor / Windsurf

Same MCP config format as above.

## Available Tools

### Pane Management

| Tool | Description |
|------|-------------|
| `onda_pane_split` | Split the active pane. Creates a new terminal beside (`right`) or below (`down`) the current one. |
| `onda_pane_list` | List all panes in the active tab. Returns pane IDs, terminal IDs, and content types. |
| `onda_pane_close` | Close a specific pane by ID. If no ID given, closes the active pane. |
| `onda_pane_focus` | Focus (activate) a specific pane by its ID. |

### Terminal Control

| Tool | Description |
|------|-------------|
| `onda_terminal_run` | Run a command in a specific terminal (sends command + newline). |
| `onda_terminal_send` | Send raw text to a terminal without appending a newline. Use for interactive input or key sequences. |
| `onda_terminal_list` | List terminals with `{id, pid, cwd, alive, workspaceId, paneId, tabId, windowId}`. Optional input filters `workspaceId` / `windowId`. |
| `onda_terminal_spawn` | Spawn a binary inside an existing pane via `exec bin args...`, preserving multi-line/quoted argv. Use to start `claude` (or any agent) with a structured prompt in a pre-existing workspace pane. |
| `onda_terminal_kill` | Kill a terminal process by ID. |

### Tab Management

| Tool | Description |
|------|-------------|
| `onda_tab_new` | Create a new tab. Each tab has its own layout of panes. |
| `onda_tab_list` | List all tabs with their IDs, titles, active state, and workspace. |
| `onda_tab_close` | Close a tab by ID. If no ID given, closes the active tab. |
| `onda_tab_focus` | Switch to (focus) a specific tab by ID. |

### Workspace Management

| Tool | Description |
|------|-------------|
| `onda_workspace_list` | List workspaces with `{id, name, rootPath, mountedIn}` (mountedIn = windowId currently hosting that workspace, or null). |
| `onda_workspace_create` | Create a new workspace. Workspaces group tabs by project. |
| `onda_workspace_focus` | Switch to a workspace by ID. |
| `onda_workspace_add_terminal` | Add a new terminal pane to a workspace (tiled mode). Returns `{terminalId, paneId, workspaceId, windowId, ready}`. PTY-ready handshake is on by default — set `waitForReady:false` to skip. |
| `onda_workspace_tile` | Set the workspace tiling layout: `single`, `split-h`, `split-v`, or `quad`. |
| `onda_workspace_locate` | Resolve a workspace by `id` / `name` / `rootPath` without listing them all. Returns `{workspace: {id, name, rootPath, mountedIn} | null}`. |

### Window (multi-window)

| Tool | Description |
|------|-------------|
| `onda_window_list` | List Onda main windows. Each entry: `{windowId, isFocused, title, workspaceIds[], activeWorkspaceId, uiMode}`. |
| `onda_window_new` | Open a fresh empty main window. Returns `{windowId}`. |
| `onda_window_focus` | Bring a window to the foreground (restore + raise + focus). When `windowId` is omitted, focuses the primary window. |
| `onda_window_mount_workspace` | Mount a workspace in a specific window. Idempotent; orchestrates an atomic transfer if the workspace is currently owned by another window. Returns `{success, workspaceId, windowId, transferred}`. |
| `onda_workspace_unmount` | Remove a workspace from whichever window currently hosts it. The workspace continues to exist globally — only its on-screen mounting is dropped. Returns `{success, workspaceId, windowId, alreadyUnmounted}`. |

### Macro

| Tool | Description |
|------|-------------|
| `onda_launch_session` | Atomic "ensure workspace + mount in target window + add terminal + spawn `bin` with `args`/`prompt`". Supports `placement: 'auto'` / `'current-window'` / `'window:<id>'` / `'new-window'` / `'ask-user'`. When `ask-user`, returns `{needsDecision: true, options, workspace}` so the host agent can surface the choice to the user, then re-invokes the tool with a concrete `placement`. |

### System

| Tool | Description |
|------|-------------|
| `onda_context` | Get the Onda context for the current AI agent (paneId, tabId, workspaceId). Call this first. |
| `onda_status` | Get current session state: active workspace, tab, pane, and their details. |
| `onda_app_info` | Get Onda app info: version, process ID. |
| `onda_ping` | Health check -- verify Onda is running and responsive. |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ONDA_SOCKET` | Path to Onda IPC socket | `~/.config/onda/onda.sock` |
| `ONDA_PANE_ID` | Pane ID where agent is running | auto-detected |
| `ONDA_TAB_ID` | Tab ID where agent is running | auto-detected |
| `ONDA_WORKSPACE_ID` | Workspace ID | auto-detected |
| `ONDA_TERMINAL` | Set to `"1"` when inside Onda | auto-detected |

## Agent-bus pattern (since v0.2.0)

Typical flow when an agent in window A delegates a task to another agent in workspace X (which may or may not be already mounted somewhere):

```jsonc
// 1. Try a fully-automatic launch
onda_launch_session({
  workspace: { name: "brandart-agentic-platform" },
  bin: "claude",
  prompt: "Scaffold modulo memoria — segui il brief #BAP-2026-05-20 ...",
  placement: "ask-user"
})

// → If multiple windows exist, the tool returns without acting:
{
  "needsDecision": true,
  "reason": "placement: ask-user",
  "options": [
    { "placement": "window:w-abc12345", "label": "Window w-abc1234 (current, focused)" },
    { "placement": "window:w-def67890", "label": "Window w-def6789" },
    { "placement": "new-window",        "label": "Open in a new window" }
  ],
  "workspace": { "id": "ws-...", "name": "brandart-agentic-platform", "rootPath": "/Users/mario/Projects/06-Brandart/brandart-agentic-platform" }
}

// 2. Host agent shows options to the human, gets choice, re-invokes:
onda_launch_session({ /* same args */, placement: "window:w-abc12345" })
// → { windowId, workspaceId, terminalId, paneId, pid }
// Claude is now running in that pane with the brief as its initial prompt.
```

After launch, the caller can keep talking to the spawned agent via `onda_terminal_send` / `onda_terminal_run` using the returned `terminalId`, or use `onda_terminal_list` (now enriched with `workspaceId`/`windowId`) to disambiguate which terminal belongs to which session.

## Architecture

- Communicates with Onda via **Unix domain socket**
- Protocol: **JSON-RPC 2.0** over newline-delimited JSON
- Socket path: `~/.config/onda/onda.sock`
- Transport: **stdio** (standard MCP transport)

```
AI Agent  <--stdio-->  onda-mcp  <--Unix socket-->  Onda Terminal
```

## License

MIT
