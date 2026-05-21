#!/usr/bin/env node
/**
 * Onda MCP Server
 *
 * Exposes Onda terminal emulator controls as MCP tools.
 * Connects to Onda's Unix domain socket (JSON-RPC 2.0).
 *
 * AI agents (Claude Code, Cursor, etc.) can use these tools to:
 * - Split panes and create tabs
 * - Run commands in terminals
 * - Orchestrate multi-agent workflows
 * - Query terminal and workspace state
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Socket } from 'net';
import { join } from 'path';
import { homedir } from 'os';

// ─── JSON-RPC Client ─────────────────────────────────────────

const DEFAULT_SOCKET = join(homedir(), '.config', 'onda', 'onda.sock');

function getSocketPath(): string {
  return process.env.ONDA_SOCKET || DEFAULT_SOCKET;
}

// Context from the terminal where this MCP server was launched
const ONDA_CONTEXT = {
  paneId: process.env.ONDA_PANE_ID || null,
  tabId: process.env.ONDA_TAB_ID || null,
  workspaceId: process.env.ONDA_WORKSPACE_ID || null,
  isOnda: process.env.ONDA_TERMINAL === '1',
};

let requestId = 0;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

async function callOnda(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = '';
    let settled = false;
    const id = ++requestId;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      socket.destroy();
    };

    const request = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          if (response.id !== id) continue; // Skip mismatched responses
          settle(() => {
            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result);
            }
          });
          return;
        } catch {
          // Incomplete JSON, wait for more data
        }
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new Error('Onda is not running. Start Onda terminal first.'));
        } else {
          reject(err);
        }
      });
    });

    socket.on('timeout', () => {
      settle(() => reject(new Error('Connection timeout')));
    });

    socket.connect(getSocketPath());
    socket.setTimeout(5000);
  });
}

// ─── Tool Definitions ────────────────────────────────────────

const TOOLS = [
  // --- Pane ---
  {
    name: 'onda_pane_split',
    description:
      'Split the active pane in Onda terminal. Creates a new terminal beside or below the current one. Use this to set up parallel workspaces for multi-agent workflows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: {
          type: 'string',
          enum: ['right', 'down'],
          description: 'Where to place the new pane. "right" = side-by-side columns. "down" = stacked rows.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the new pane. Defaults to current directory.',
        },
        shell: {
          type: 'string',
          description: 'Shell to use (e.g., /bin/zsh, /bin/bash). Defaults to user default.',
        },
      },
    },
  },
  {
    name: 'onda_pane_list',
    description:
      'List all panes in the active tab. Returns pane IDs, terminal IDs, and content types. Use this to discover available terminals before sending commands.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'onda_pane_close',
    description: 'Close a specific pane by ID. If no ID given, closes the active pane.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Pane ID to close. Omit to close active pane.' },
      },
    },
  },
  {
    name: 'onda_pane_focus',
    description: 'Focus (activate) a specific pane by its ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Pane ID to focus.' },
      },
      required: ['id'],
    },
  },

  // --- Terminal ---
  {
    name: 'onda_terminal_run',
    description:
      'Run a command in a specific terminal (sends command + newline). Use this to execute shell commands, launch processes, or start other AI agents in separate terminals.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Terminal ID to run the command in.' },
        command: { type: 'string', description: 'Shell command to execute.' },
      },
      required: ['id', 'command'],
    },
  },
  {
    name: 'onda_terminal_send',
    description:
      'Send raw text to a terminal without appending a newline. Use for interactive input, partial commands, or key sequences.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Terminal ID to send text to.' },
        text: { type: 'string', description: 'Text to send (no trailing newline added).' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'onda_terminal_list',
    description:
      'List active terminals. Each entry: { id, pid, cwd, alive, workspaceId, paneId, tabId, windowId }. Use the optional filters to scope the list. Essential to disambiguate which terminal belongs to which workspace/window when many are alive — no more cwd reverse-lookup.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Filter: only terminals in this workspace.' },
        windowId: { type: 'string', description: 'Filter: only terminals in this window.' },
      },
    },
  },
  {
    name: 'onda_terminal_kill',
    description: 'Kill a terminal process by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Terminal ID to kill.' },
      },
      required: ['id'],
    },
  },

  // --- Terminal Tap (read + subscribe + sendKeys + waitFor) ---
  {
    name: 'onda_terminal_read',
    description:
      'Read recent output of a terminal (ring buffer ~200 KB / ~1 MB if a listener is attached). Returns the current buffer content plus byte total and timestamps. Use to see what a terminal has printed without subscribing to a live stream. Lazily attaches a passive tap on first call — no impact on the terminal itself.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Terminal ID to read from.' },
        lines: {
          type: 'number',
          description: 'Optional: cap returned content to the last N lines.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'onda_terminal_subscribe',
    description:
      'Attach a long-lived listener to a terminal\'s output stream. Returns a sessionId for use with onda_terminal_poll. Also returns the current buffer snapshot so the listener has full context. Cap of 4 concurrent listeners per terminal. The listener\'s name is shown in the Onda UI as a presence indicator.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Terminal ID to subscribe to.' },
        listener: {
          type: 'string',
          description: 'Display name for this listener (shown in Onda UI presence badge). e.g. "alita", "kai", "ci-watch".',
        },
      },
      required: ['id', 'listener'],
    },
  },
  {
    name: 'onda_terminal_poll',
    description:
      'Long-poll a subscribed terminal session for new output. Blocks up to timeoutMs (default 15000) waiting for new chunks. Returns immediately if data is already pending. Each call advances the cursor; only data emitted after the last poll is returned. Use in a loop: subscribe -> poll -> poll -> ... -> unsubscribe.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID returned by onda_terminal_subscribe.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Max wait in ms before returning empty. Default 15000.',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'onda_terminal_unsubscribe',
    description:
      'Detach a listener session. Idempotent. Always call this when done to free the ring buffer (drops back to idle size after the last subscriber leaves).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID to detach.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'onda_terminal_listeners',
    description:
      'List currently attached listeners for a terminal. Returns name + sessionId + timestamps. Used to inspect who is observing a terminal (introspection / debugging).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Terminal ID to inspect.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'onda_terminal_wait_for',
    description:
      'Block until a regex pattern matches new terminal output, or timeout. Useful to synchronize scripted command sequences: run command -> wait for prompt -> run next command. Pattern is a JavaScript regex string; flags default to "m" (multiline). Returns { matched: bool, match?: string }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Terminal ID to watch.' },
        pattern: { type: 'string', description: 'Regex pattern (string form).' },
        flags: { type: 'string', description: 'Regex flags. Default "m".' },
        timeoutMs: { type: 'number', description: 'Max wait in ms. Default 30000.' },
      },
      required: ['id', 'pattern'],
    },
  },
  // --- Spatial awareness (M+1 follow-up) ---
  {
    name: 'onda_workspace_layout',
    description:
      'Read the current layout of a workspace: mosaic tree, list of pane IDs, active pane, viewport dimensions, and per-pane cwd. Use this BEFORE spawning a new terminal to decide where to place it (right/down/replace) and whether the viewport has room. Returns null for `workspace` if the id is unknown. Omit workspaceId to use the active workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID. Omit for active workspace.' },
      },
    },
  },
  {
    name: 'onda_window_screenshot',
    description:
      'Capture a PNG/JPEG snapshot of an Onda main window for visual debugging. Returns either a base64 dataUrl or a tempfile path. Use this when you (the agent) need to SEE what the user sees — verifying a layout change, confirming a feature renders correctly, or investigating UI glitches. Returns { dataUrl | path, width, height, windowId, capturedAt }. Defaults: focused window, PNG format, dataUrl=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        windowId: {
          type: 'string',
          description: 'Window ID to capture. Omit for the focused window.',
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg'],
          description: 'Output format. PNG is lossless (default), JPEG is smaller.',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 0..100 (default 80). Ignored for PNG.',
        },
        dataUrl: {
          type: 'boolean',
          description: 'When true (default), returns base64 dataUrl. When false, writes a tempfile and returns its path — useful for large captures.',
        },
      },
    },
  },
  {
    name: 'onda_terminal_send_keys',
    description:
      'Send semantic key sequences to a terminal (Ctrl+C, Up, Enter, Esc, F5, Tab, ...). Each entry in `keys` is mapped to the appropriate stdin bytes. Supports Ctrl+<letter>, Arrow keys, Function keys F1-F12, Enter/Tab/Esc/Backspace/Delete/Home/End/PageUp/PageDown/Insert/Space, and raw literal text as fallback. Use this for tmux-like control instead of onda_terminal_send when you need to type special keys.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Terminal ID to send to.' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of key names. Example: ["Ctrl+C"], ["Up", "Up", "Enter"], ["Esc", ":wq", "Enter"].',
        },
      },
      required: ['id', 'keys'],
    },
  },

  // --- Tab ---
  {
    name: 'onda_tab_new',
    description:
      'Create a new tab in Onda. Each tab has its own layout of panes. Use this to isolate different workstreams.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cwd: { type: 'string', description: 'Working directory for the new tab.' },
        shell: { type: 'string', description: 'Shell to use.' },
      },
    },
  },
  {
    name: 'onda_tab_list',
    description: 'List all tabs with their IDs, titles, active state, and workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'onda_tab_close',
    description: 'Close a tab by ID. If no ID given, closes the active tab.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Tab ID to close. Omit to close active tab.' },
      },
    },
  },
  {
    name: 'onda_tab_focus',
    description: 'Switch to (focus) a specific tab by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Tab ID to focus.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'onda_tab_exec',
    description:
      'Open a new tab and spawn a process directly with exact argv (bypasses shell parsing). Use this when you need to pass multi-line strings or special characters as a single argument — e.g. launching `claude` with a structured preamble. The process replaces the shell in the tab\'s PTY: argv is passed to execve() as-is, so embedded newlines, quotes, and dollar signs are preserved verbatim.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        bin: { type: 'string', description: 'Absolute path or PATH-resolvable binary to spawn (e.g., "claude", "/usr/local/bin/aider").' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments passed verbatim to the binary. Each element is one argv entry; no shell parsing happens.',
        },
        cwd: { type: 'string', description: 'Working directory for the spawned process.' },
        workspaceId: { type: 'string', description: 'Workspace ID to host the new tab. Omit to use active workspace.' },
      },
      required: ['bin'],
    },
  },

  // --- Workspace ---
  {
    name: 'onda_workspace_list',
    description:
      'List all workspaces. Each entry: { id, name, rootPath, mountedIn }. `mountedIn` is the windowId hosting that workspace, or null if not currently mounted. Use this with onda_window_list to map workspaces ↔ windows.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'onda_workspace_create',
    description: 'Create a new workspace. Workspaces group tabs by project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Workspace name.' },
        rootPath: { type: 'string', description: 'Root directory path for the workspace.' },
        color: { type: 'string', description: 'Color hex code (e.g., #a78bfa).' },
      },
      required: ['name', 'rootPath'],
    },
  },
  {
    name: 'onda_workspace_focus',
    description: 'Switch to a workspace by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace ID to switch to.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'onda_workspace_add_terminal',
    description:
      'Add a new terminal pane to a workspace and wait for its PTY to be ready. Returns { success, terminalId, paneId, workspaceId, windowId, ready }. \n\nPlacement: by default the new pane is appended via react-mosaic\'s built-in logic (typically "split right"). For deterministic placement, pass `direction` and (optionally) `relativeToPaneId` — this routes through splitPane and gives you explicit control.\n\nCALL onda_workspace_layout FIRST when you care about placement: it returns the current mosaic tree + active pane + viewport, so you can decide whether to stack "down" (output-heavy panes) or split "right" (parallel-watch panes).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID. Omit to use active workspace.' },
        cwd: { type: 'string', description: 'Working directory for the new terminal.' },
        shell: { type: 'string', description: 'Shell to use (e.g., /bin/zsh).' },
        waitForReady: { type: 'boolean', description: 'Default true. When false, returns as soon as the pane object is created (PTY may still be spawning).' },
        direction: {
          type: 'string',
          enum: ['right', 'down', 'up', 'left', 'horizontal', 'vertical'],
          description: 'Optional. When set, the pane is created by splitting an existing one in this direction. "horizontal"/"down"/"up" produce a top/bottom pair; "vertical"/"right"/"left" produce a left/right pair.',
        },
        relativeToPaneId: {
          type: 'string',
          description: 'Optional pane ID to split. When omitted with `direction` set, the active pane is used.',
        },
      },
    },
  },
  {
    name: 'onda_workspace_tile',
    description: 'Set the workspace-level tiling layout. Controls how workspaces are arranged in the main window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID. Omit to use active workspace.' },
        layout: {
          type: 'string',
          enum: ['single', 'split-h', 'split-v', 'quad'],
          description: 'Layout mode: single (one workspace), split-h (horizontal split), split-v (vertical split), quad (four quadrants).',
        },
      },
      required: ['layout'],
    },
  },
  {
    name: 'onda_workspace_locate',
    description:
      'Find a workspace by name, id, or rootPath without listing them all. Returns { workspace: { id, name, rootPath, mountedIn } } or { workspace: null }. mountedIn is the windowId currently hosting the workspace, or null if not mounted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace ID to look up.' },
        name: { type: 'string', description: 'Workspace name to look up.' },
        rootPath: { type: 'string', description: 'Workspace rootPath to look up.' },
      },
    },
  },

  // --- Window (multi-window aware) ---
  {
    name: 'onda_window_list',
    description:
      'List all Onda main windows. Returns { windows: [{ windowId, isFocused, title, workspaceIds[], activeWorkspaceId, uiMode }] }. Use this before placing a new workspace/terminal to know what windows exist and which workspace lives in which window.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'onda_window_new',
    description:
      'Open a fresh empty main window (analogue of File > New Window). Returns { windowId }. Useful when an agent needs to host a workspace in a brand new window without contaminating existing ones.',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // --- Advanced terminal spawn ---
  {
    name: 'onda_terminal_spawn',
    description:
      'Spawn a binary inside an EXISTING pane by writing `exec bin args...` into its PTY. Preserves multi-line/quoted argv elements verbatim (each one becomes a single execve argv entry after shell quoting). Use this to launch `claude` (or any agent) with a structured prompt inside a workspace pane created via onda_workspace_add_terminal. Either paneId or workspaceId is required; if workspaceId, the first terminal pane in that workspace is used.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        paneId: { type: 'string', description: 'Target pane ID (preferred).' },
        workspaceId: { type: 'string', description: 'Workspace ID — use when paneId is not known.' },
        bin: { type: 'string', description: 'PATH-resolvable or absolute binary (e.g., "claude").' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments passed verbatim. Each element is one argv entry; embedded newlines/quotes are preserved.',
        },
      },
      required: ['bin'],
    },
  },

  // --- High-level macro ---
  {
    name: 'onda_launch_session',
    description:
      'High-level macro: ensure workspace exists → mount it in target window → add a terminal pane → spawn `bin` with `args` (or `prompt` as single argv). Atomic from the agent\'s point of view. Supports placement modes: "auto" (default), "current-window", "window:<windowId>", "new-window", "ask-user" (interactive — see below).\n\n**Placement "ask-user"**: the tool does NOT proceed. Instead returns { needsDecision: true, options: [{placement, label}], workspace }. The host agent must surface the choice to the human user and re-invoke this tool with placement set to a concrete value (e.g. "window:w-abc").\n\nOn success returns { windowId, workspaceId, terminalId, paneId, pid }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: {
          type: 'object',
          description: 'Workspace reference. Provide id | name | rootPath. Set createIfMissing:true (with name+rootPath) to auto-create.',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            rootPath: { type: 'string' },
            createIfMissing: { type: 'boolean' },
          },
        },
        bin: { type: 'string', description: 'Binary to spawn (e.g., "claude").' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argv entries (preserved verbatim).' },
        prompt: { type: 'string', description: 'Shortcut: passed as a single argv entry. Ignored if args is set.' },
        placement: {
          type: 'string',
          description: 'auto | current-window | window:<id> | new-window | ask-user',
        },
        addTerminalIfNeeded: { type: 'boolean', description: 'Default true. When false, expects a pane to already exist in the workspace.' },
      },
      required: ['workspace', 'bin'],
    },
  },

  // --- System ---
  {
    name: 'onda_context',
    description:
      'Get the Onda context for the terminal where this AI agent is running. Returns paneId, tabId, workspaceId. Use this FIRST to know which pane/tab you are in before splitting or sending commands.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'onda_status',
    description:
      'Get current Onda session state: active workspace, active tab, active pane, and their details. Use this to understand the current context before taking actions.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'onda_app_info',
    description: 'Get Onda app info: version, process ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'onda_ping',
    description: 'Health check - verify Onda is running and responsive.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ─── Tool → Method mapping ───────────────────────────────────

const TOOL_MAP: Record<string, { method: string; mapParams?: (args: Record<string, unknown>) => Record<string, unknown> }> = {
  // Pane
  onda_pane_split: {
    method: 'pane.split',
    mapParams: (args) => ({
      // Onda IPC uses inverted naming: "vertical" = stacked (down), "horizontal" = side-by-side (right)
      direction: args.direction === 'down' ? 'vertical' : 'horizontal',
      cwd: args.cwd,
      shell: args.shell,
    }),
  },
  onda_pane_list: { method: 'pane.list' },
  onda_pane_close: { method: 'pane.close' },
  onda_pane_focus: { method: 'pane.focus' },

  // Terminal
  // Spatial awareness
  onda_workspace_layout: { method: 'workspace.layout' },
  onda_window_screenshot: { method: 'window.screenshot' },

  onda_terminal_run: { method: 'terminal.run' },
  onda_terminal_send: { method: 'terminal.send' },
  onda_terminal_list: { method: 'terminal.list' },
  onda_terminal_kill: { method: 'terminal.kill' },
  onda_terminal_read: { method: 'terminal.read' },
  onda_terminal_subscribe: { method: 'terminal.subscribe' },
  onda_terminal_poll: { method: 'terminal.poll' },
  onda_terminal_unsubscribe: { method: 'terminal.unsubscribe' },
  onda_terminal_listeners: { method: 'terminal.listeners' },
  onda_terminal_wait_for: { method: 'terminal.waitFor' },
  onda_terminal_send_keys: { method: 'terminal.sendKeys' },

  // Tab
  onda_tab_new: {
    method: 'tab.new',
    mapParams: (args) => ({
      ...args,
      // Auto-inject workspaceId from agent context so tab is created
      // in the agent's workspace, not the currently active one
      workspaceId: args.workspaceId || ONDA_CONTEXT.workspaceId || undefined,
    }),
  },
  onda_tab_list: { method: 'tab.list' },
  onda_tab_close: { method: 'tab.close' },
  onda_tab_focus: { method: 'tab.focus' },
  onda_tab_exec: {
    method: 'tab.exec',
    mapParams: (args) => ({
      ...args,
      workspaceId: args.workspaceId || ONDA_CONTEXT.workspaceId || undefined,
    }),
  },

  // Workspace
  onda_workspace_list: { method: 'workspace.list' },
  onda_workspace_create: { method: 'workspace.create' },
  onda_workspace_focus: { method: 'workspace.focus' },
  onda_workspace_add_terminal: {
    method: 'workspace.addTerminal',
    mapParams: (args) => ({
      workspaceId: args.workspaceId || ONDA_CONTEXT.workspaceId || undefined,
      cwd: args.cwd,
      shell: args.shell,
    }),
  },
  onda_workspace_tile: { method: 'workspace.setLayout' },
  onda_workspace_locate: { method: 'workspace.locate' },

  // Window
  onda_window_list: { method: 'window.list' },
  onda_window_new: { method: 'window.new' },

  // Advanced spawn + macro
  onda_terminal_spawn: {
    method: 'terminal.spawnInPane',
    mapParams: (args) => ({
      paneId: args.paneId || ONDA_CONTEXT.paneId || undefined,
      workspaceId: args.workspaceId || ONDA_CONTEXT.workspaceId || undefined,
      bin: args.bin,
      args: args.args,
    }),
  },
  onda_launch_session: { method: 'launchSession' },

  // System (onda_context handled separately - it's local, not RPC)
  onda_status: { method: 'session.current' },
  onda_app_info: { method: 'app.info' },
  onda_ping: { method: 'app.ping' },
};

// ─── MCP Server ──────────────────────────────────────────────

const server = new Server(
  {
    name: 'onda',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // onda_context: local env vars + live session info from app
  if (name === 'onda_context') {
    let sessionInfo: any = null;
    try {
      sessionInfo = await callOnda('session.current');
    } catch {
      // App may not be reachable, return env-only context
    }
    const context = {
      ...ONDA_CONTEXT,
      uiMode: sessionInfo?.uiMode || process.env.ONDA_UI_MODE || null,
    };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(context, null, 2),
      }],
    };
  }

  const mapping = TOOL_MAP[name];

  if (!mapping) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    // Auto-focus our pane before split so it splits in the right place
    if (name === 'onda_pane_split' && ONDA_CONTEXT.paneId) {
      await callOnda('pane.focus', { id: ONDA_CONTEXT.paneId });
    }

    const params = mapping.mapParams
      ? mapping.mapParams((args || {}) as Record<string, unknown>)
      : (args || {}) as Record<string, unknown>;

    const result = await callOnda(mapping.method, params);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[onda-mcp] Server started, socket: ${getSocketPath()}`);
}

main().catch((error) => {
  console.error('[onda-mcp] Fatal error:', error);
  process.exit(1);
});
