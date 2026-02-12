# @mindfullabai/onda-mcp

MCP server to control [Onda](https://onda.dev) terminal from AI agents (Claude Code, Cursor, Windsurf, etc.)

21 tools across 5 categories let AI agents split panes, run commands, manage tabs and workspaces, and orchestrate multi-agent workflows -- all through the standard [Model Context Protocol](https://modelcontextprotocol.io/).

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
| `onda_terminal_list` | List all active terminals with their IDs, PIDs, working directories, and alive status. |
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
| `onda_workspace_list` | List all workspaces with their IDs, names, root paths, and which is active. |
| `onda_workspace_create` | Create a new workspace. Workspaces group tabs by project. |
| `onda_workspace_focus` | Switch to a workspace by ID. |
| `onda_workspace_add_terminal` | Add a new terminal pane to a workspace (tiled mode). |
| `onda_workspace_tile` | Set the workspace tiling layout: `single`, `split-h`, `split-v`, or `quad`. |

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
