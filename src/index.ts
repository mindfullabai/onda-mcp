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
  terminalId: process.env.ONDA_TERMINAL_ID || null,
  paneId: process.env.ONDA_PANE_ID || null,
  tabId: process.env.ONDA_TAB_ID || null,
  workspaceId: process.env.ONDA_WORKSPACE_ID || null,
  // ONDA_SOCKET is exported for every terminal Onda spawns; ONDA_TERMINAL only
  // for zsh with a resolved ZDOTDIR, so it gave a false negative under
  // bash/fish. See agent-team-os/schema/CONTRACT.md §1.
  isOnda: Boolean(process.env.ONDA_SOCKET),
};

let requestId = 0;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

/**
 * How long a call may stay silent before it is given up. Most methods answer at
 * once; the ones that wait on git over the network or on an agent get longer,
 * otherwise the caller sees "Connection timeout" for a call that went through.
 */
function idleTimeoutFor(method: string, params?: Record<string, unknown>): number {
  if (method === 'worktree.retire') return 180_000;
  if (method === 'worktree.list') return 60_000;
  const waited = Number(params?.timeoutMs ?? params?.readyTimeoutMs ?? 0);
  return Number.isFinite(waited) && waited > 0 ? Math.max(5_000, waited + 10_000) : 5_000;
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
    socket.setTimeout(idleTimeoutFor(method, params));
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
      'List the panes of the focused window: { id, contentType, terminalId, cwd, tabId, workspaceId, live_reason, live_process }. `live_reason` says what keeps it live: "agent" (an agent session: claude, codex, qwen…), "process" (another foreground program: a build, a dev server, a script) or "none" (a shell at its prompt — not live), with the program in `live_process`. Use this to discover terminals before sending commands, and to find an agent already running before spawning one.',
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
    name: 'onda_pane_attach',
    description:
      'Re-attach a live terminal (PTY) that no pane shows any more to a new pane of a workspace, without spawning a new shell: the process, its history and its scrollback stay. Use it when onda_terminal_list shows a terminal alive whose paneId is in no workspace (e.g. after moving workspaces between windows a workspace lost its pane layout), or to bring a terminal into another workspace. The workspace must be mounted in a window (onda_window_mount_workspace first). Refuses with errorCode "already_shown" (with the workspaceId/paneId/windowId that shows it) when a pane of a mounted workspace already shows that terminal, "not_alive" for a dead or unknown terminal, "workspace_not_mounted" when the workspace is in no window. Returns { success, terminalId, paneId, workspaceId, windowId }. The new pane does not take the keyboard unless focus: true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        terminalId: { type: 'string', description: 'The live terminal to show (from onda_terminal_list).' },
        workspaceId: { type: 'string', description: 'Workspace that gets the new pane (from onda_workspace_list).' },
        focus: { type: 'boolean', description: 'Give the new pane the keyboard. Default false.' },
      },
      required: ['terminalId', 'workspaceId'],
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
      'List active terminals. Each entry: { id, pid, cwd, alive, workspaceId, paneId, tabId, windowId, live_reason, live_process }. `live_reason` says what keeps it live: "agent" (an agent session: claude, codex, qwen…), "process" (another foreground program: a build, a dev server, a script) or "none" (a shell at its prompt — not live), with the program in `live_process`. Use the optional filters to scope the list. Essential to disambiguate which terminal belongs to which workspace/window when many are alive — no more cwd reverse-lookup.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Filter: only terminals in this workspace.' },
        windowId: { type: 'string', description: 'Filter: only terminals in this window.' },
      },
    },
  },
  {
    name: 'onda_agent_sessions',
    description:
      'List live agent sessions (Claude Code and friends) known to Onda, as reported by the Agent Team OS hook and the screen. Each entry: { sessionId, terminalId, paneId, workspaceId, agent, status, state, stateSince, mounted, windowId, host, lastTool, lastTarget, ctxPct, inboxPending, since, lastSeen }. This is how an agent can see its own team: who is working, who is stuck, and where. `state` says WHO IS STUCK: working | idle | waiting_permission | waiting_answer | pending_input | exited. pending_input = text sits in the prompt box, never sent (no Enter), and nothing has moved for 60 s: the agent is NOT working. stateSince is an ISO timestamp (for pending_input, when the box went quiet). mounted = the workspace is in a window mosaic (windowId says which; false/null = alive but off screen). host is always \"laptop\" for now. Check `state` before saying an agent is working. `status` (busy | waiting | idle | error) is kept for compatibility and is coarser: a pending_input session shows status idle. Needs an Onda build from 14 Oct 2026 or later (older hosts return status only).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'onda_agent_events',
    description:
      'Recent lifecycle events for one agent session, newest last, from the main-process ring buffer. Tool names and cwd-relative paths only — never file contents or prompt text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session id, from onda_agent_sessions.' },
        limit: { type: 'number', description: 'How many events to return (default 50, max 200).' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'onda_agentic_open',
    description:
      'Open (or focus) the Agentic window: the team roster with one card per agent, live status, and one click to mount a workspace into the mosaic.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'onda_agentic_close',
    description: 'Close the Agentic window if open.',
    inputSchema: { type: 'object' as const, properties: {} },
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
      'List workspaces (archived ones only with includeArchived). Each entry: { id, name, rootPath, paneCount, hostId, archivedAt, mountedIn, rootExists, worktree, live_reason, live_process, live_processes }. A workspace is live only when one of its terminals runs an agent (`live_reason: "agent"`) or a non-shell process (`"process"`); idle shells do not count (`"none"`). `live_process` is the strongest program, `live_processes` all of them, agents first. `mountedIn` is the windowId hosting that workspace, or null if not currently mounted. `archivedAt` is a timestamp or null. `rootExists` is false when the folder is gone (a dead workspace: a removed worktree, a deleted checkout) and null for remote workspaces. `worktree` (null unless the folder is the root of a git worktree): { repoRoot, branch, isMain, clean, mergedInto } — isMain true for the repo\'s main tree; clean = no staged/unstaged/untracked changes; mergedInto = the first of master/main/develop that already contains HEAD (null if none, always null for the main tree). Use this with onda_window_list to map workspaces ↔ windows, and with onda_workspace_remove to clean up.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        includeArchived: { type: 'boolean', description: 'Default false. When true, archived workspaces are listed too (with their archivedAt).' },
      },
    },
  },
  {
    name: 'onda_workspace_create',
    description:
      'Create a new workspace. It is born EMPTY: no terminal is opened, its tile shows the welcome screen (recent sessions, new session, open terminal). To run an agent there use onda_agent_spawn (which creates the pane); for a plain shell, onda_workspace_add_terminal. Workspaces group panes by project folder. If a local workspace already has that folder (same real path, symlinks and letter case included) it is returned instead (`existing: true`, `workspaceId`), never duplicated. Pass hostId to create it on a remote host: rootPath is then a path ON THAT HOST, and every pane in the workspace runs there. The host must already be configured in Onda (Settings > Remotes) — use onda_remote_list to see which.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Workspace name.' },
        rootPath: { type: 'string', description: 'Root directory. On the remote host when hostId is set.' },
        color: { type: 'string', description: 'Color hex code (e.g., #a78bfa).' },
        hostId: {
          type: 'string',
          description: 'Remote host id (the ssh alias, e.g. "mini"). Omit for this Mac. The host belongs to the workspace, not to individual panes.',
        },
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
    description:
      'Arrange the workspaces mounted in one window so they are all visible. layout "main" is the one for an orchestrating session: the anchor (the workspace you work in, where the user reads and writes) takes `mainPercent` of the width (default 62) for the whole height, and the agents it started stack in a column on its right with equal heights — two narrow columns past 4 of them. Call it after each spawn, passing your own workspace as `anchorWorkspaceId` (from onda_context). Default layout "grid" (2 → side by side, 3-4 → 2×2, 5-6 → 3×2…) with the anchor top left and the others in order of opening. Only rearranges: it never mounts or detaches a workspace (sessions started with placement "background" stay out). Returns { success, windowId, layout, grid?: {rows, cols}, main?: {percent, side, sideColumns}, order: [{workspaceId, name}] }. The user gets the same "main" arrangement with ⇧⌘M (focused workspace as the main one).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        layout: {
          type: 'string',
          enum: ['main', 'grid', 'columns', 'rows', 'quad', 'split-v', 'split-h'],
          description: 'Default "grid". "main": the anchor large on the left, the others in a column on the right. "columns": all side by side. "rows": all stacked. Old names still accepted: quad = grid, split-v = columns, split-h = rows.',
        },
        mainPercent: {
          type: 'number',
          description: 'layout "main": share of the window width the anchor takes, in percent. Default 62, kept within 30-85.',
        },
        anchorWorkspaceId: {
          type: 'string',
          description: 'Workspace that goes top left, or that is the main one with layout "main" (usually yours). Default: the first one opened in that window. Also picks the window when windowId is omitted.',
        },
        order: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional workspace ids to place right after the anchor, in this order; the rest follow in order of opening.',
        },
        windowId: { type: 'string', description: 'Window to arrange. Default: the anchor\'s window, else the focused one.' },
        workspaceId: { type: 'string', description: 'Old name of anchorWorkspaceId.' },
      },
    },
  },
  {
    name: 'onda_workspace_locate',
    description:
      'Find a workspace by name, id, or rootPath without listing them all (archived ones included). rootPath is matched by real path: a symlinked spelling or a different letter case finds the same workspace; with duplicates, the mounted / live / most recent one is returned. Returns { workspace: { id, name, rootPath, hostId, archivedAt, mountedIn, rootExists, worktree } } or { workspace: null }. mountedIn is the windowId currently hosting the workspace, or null if not mounted. `worktree` (null unless the folder is the root of a git worktree): { repoRoot, branch, isMain, clean, mergedInto } — isMain true for the repo\'s main tree; clean = no staged/unstaged/untracked changes; mergedInto = the first of master/main/develop that already contains HEAD (null if none, always null for the main tree).',
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
  {
    name: 'onda_window_focus',
    description:
      'Bring a specific main window to the foreground (restore if minimized, raise, focus). When windowId is omitted, focuses the primary window. Returns { success, windowId }. Use after mounting a workspace remotely, or to wake Onda from a background CLI subagent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        windowId: { type: 'string', description: 'Target window id. Omit to focus the primary window.' },
      },
    },
  },
  {
    name: 'onda_window_mount_workspace',
    description:
      'Mount a workspace in a specific window. Idempotent when the workspace is already there. If the workspace is currently mounted in another window, orchestrates an atomic transfer via the unmount-request flow (same path the in-app "Move workspace here?" dialog uses). Returns { success, workspaceId, windowId, transferred } only once the window itself shows the tile (it waits for a just-created window to be ready); if the tile does not appear the call fails with the reason and the mount is released, instead of reporting a mount that is not on screen. Pass `direction` to control how the new tile is spliced into the mosaic (mirrors the Cmd+P picker: Enter = down, Cmd+Enter = right). The mount does NOT move the visible focus (the blue border) by default: the user keeps typing in the session they are in. Pass `focus: true` only when the user asked to be taken there.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace to mount.' },
        windowId: { type: 'string', description: 'Destination window id.' },
        direction: {
          type: 'string',
          enum: ['down', 'right'],
          description: 'Optional. Where to splice the new tile relative to the anchor workspace in the mosaic. Default: "down".',
        },
        anchorWorkspaceId: {
          type: 'string',
          description: 'Optional. Workspace id to anchor the split next to. Default: currently active workspace in the target window.',
        },
        focus: {
          type: 'boolean',
          description: 'Optional. Give the mounted workspace the focus. Default: false (an agent\'s mount never steals the user\'s focus).',
        },
      },
      required: ['workspaceId', 'windowId'],
    },
  },
  {
    name: 'onda_workspace_unmount',
    description:
      'Remove a workspace from whichever window currently hosts it (drops it from that window\'s tiled mosaic and releases the mount registry slot). The workspace continues to exist in the global list — only its on-screen mounting is dropped. Returns { success, workspaceId, windowId, alreadyUnmounted }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace to unmount.' },
      },
      required: ['workspaceId'],
    },
  },
  {
    name: 'onda_workspace_remove',
    description:
      'Archive or delete a workspace that nobody is using: it must not be mounted in any window, none of its terminals may have a live process, and no editor in it may have unsaved changes. The archive is for folders that still exist: by default (no `mode`) a workspace whose folder is gone is deleted (there is nothing to restore) and one whose folder exists is archived; `mode: "archive"` on a missing folder is refused (errorCode "nothing_to_archive"). The folder on disk is never touched. Otherwise nothing happens and the result says why: errorCode "mounted" (+ windowId: unmount it first with onda_workspace_unmount), "live_panes" (+ livePanes [{paneId, terminalId}] and dirtyEditors [{paneId, filePath}]), "workspace_not_found", "invalid_mode". Archived workspaces leave the rail and onda_workspace_list but can be restored from the app (and onda_agent_spawn on the same folder restores them). For every workspace whose folder is gone at once, use onda_workspace_remove_dead. Returns { success, workspaceId, action: "archived" | "deleted", rootExists }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace to archive or delete.' },
        mode: { type: 'string', enum: ['archive', 'delete'], description: 'Default: "delete" when the workspace folder no longer exists, "archive" when it does. "archive" hides it, reversible from the app; "delete" removes it from Onda. The folder on disk is never touched.' },
        permanent: { type: 'boolean', description: 'Older form of `mode`: true = "delete", false = "archive". Ignored when `mode` is set.' },
      },
      required: ['workspaceId'],
    },
  },
  {
    name: 'onda_workspace_remove_dead',
    description:
      'Delete, in one go, every local workspace whose folder no longer exists (rootExists false in onda_workspace_list: retired worktrees, deleted checkouts), archived ones included. A workspace still in use (mounted, live terminal, unsaved editor) is skipped with the reason; remote workspaces are never touched; folders on disk are never touched. Run it first with `dryRun: true` to see the list. Returns { success, dryRun, removed: [{ workspaceId, name, rootPath, archived }], skipped: [{ workspaceId, name, rootPath, archived, reason }] }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dryRun: { type: 'boolean', description: 'Default false. true: list what would be deleted and change nothing.' },
      },
    },
  },
  {
    name: 'onda_workspace_prune',
    description:
      'Remove the "[Process exited]" panes of a mounted workspace — any dead terminal pane, whoever opened it — and keep the live ones. If nothing alive is left (no live terminal, no editor/diff pane), the workspace leaves the mosaic when onda_agent_spawn mounted it or `unmountWhenEmpty` is true; a workspace the user mounted stays, in its empty state. Returns { success, workspaceId, removedPaneIds, livePaneIds, empty, unmounted }. Only terminals that exited during this Onda run count as dead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace to clean up (must be mounted).' },
        unmountWhenEmpty: { type: 'boolean', description: 'Override the default: true unmounts once empty, false keeps it mounted.' },
      },
      required: ['workspaceId'],
    },
  },

  {
    name: 'onda_worktree_retire',
    description:
      'End of life of an agent\'s git worktree, behind closed-door checks run in this order; the first that fails stops everything, changes nothing and is the `reason`: (1) a linked worktree, not the main tree ("not_a_worktree", "main_worktree"); (2) nothing in use: no live terminal or unsaved editor in its Onda workspace and no process anywhere with its cwd inside, e.g. a dev server or an agent started outside Onda ("in_use"; a workspace still mounted but with nothing alive is unmounted first); (3) no changes and no untracked files, ignored files do not count ("dirty", with the first 20 files); (4) an `origin` remote, reachable; the base is its first master/main/develop, fetched ("no_remote", "fetch_failed"); (5) the work is already in origin/<base>: ancestor (normal merge), else merging it changes nothing (squash merge, even after the base moved on), else a merged PR on exactly this HEAD via `gh` if installed and logged in ("not_integrated"; when in doubt the worktree stays); (6) integrated only through a PR: origin/<branch> must equal HEAD ("not_pushed"); (7) archive tag `<archiveTagPrefix><branch>` on HEAD pushed to origin, `-2`, `-3`… when the name is taken by another commit, never moved ("tag_push_failed"). Then `git worktree remove` (never --force) + prune; local branch deleted; remote branch deleted only with a merged PR or a normal merge (with squash it stays: a PR may still be open); the workspace is deleted (its folder is gone, nothing to restore). Returns { retired, path, repoRoot, branch, base, reason?, detail?, integratedBy: "ancestor"|"tree"|"pr", tag, branchDeleted, remoteBranchDeleted, branchKept?, workspaceId, workspaceDeleted, workspaceArchived (always false, kept for older callers), checks: [{ name, ok, detail }] }. `dryRun: true` runs every check and changes nothing (`wouldRetire: true` when it would go). Call it once the work is merged; on `retired: false`, report `reason`/`detail` to whoever owns the work instead of retrying.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace of the worktree (from onda_agent_spawn). Preferred: its terminals are checked too.' },
        path: { type: 'string', description: 'Worktree folder, when there is no workspace id at hand.' },
        archiveTagPrefix: { type: 'string', description: 'Prefix of the archive tag. Default "archive/".' },
        deleteBranch: { type: 'boolean', description: 'Default true. false: remove the worktree only; branch (local and remote) kept, no tag.' },
        dryRun: { type: 'boolean', description: 'Default false. true: run every check, change nothing.' },
      },
    },
  },
  {
    name: 'onda_worktree_list',
    description:
      'The linked worktrees of a repo (main tree excluded), to see which ones can be retired: { repoRoot, worktrees: [{ path, branch, clean, integratedInto: { base, by: "ancestor"|"tree" } | null, live, liveReason?: "pty"|"process", workspaceId?, labels?, archived? }] }. `integratedInto` is checked against origin/<base> as last fetched (no network unless `fetch: true`); merged PRs are not asked here (onda_worktree_retire does). `live`: a terminal in its Onda workspace or any process with its cwd inside.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repoRoot: { type: 'string', description: 'Root of the repo (a linked worktree of it also works).' },
        fetch: { type: 'boolean', description: 'Default false. true: fetch master/main/develop from origin first.' },
      },
      required: ['repoRoot'],
    },
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

  // --- Remote hosts ---
  // The terminal_*/workspace_* tools take an optional hostId rather than being
  // duplicated: an agent should not have to learn two APIs for the same thing.
  // These cover what has no local equivalent.
  {
    name: 'onda_remote_list',
    description:
      'List the remote hosts configured in Onda, with what the last preflight found (reachable, tmux version, whether it can hold persistent workspaces). Call this before creating a remote workspace to learn the valid hostId values.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'onda_remote_sessions',
    description:
      'List live tmux sessions on a remote host, with the command running in each. This is how to find work left behind by an earlier session — including your own after a disconnect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        hostId: { type: 'string', description: 'Remote host id, e.g. "mini".' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'onda_remote_readdir',
    description:
      'List a directory on a remote host. The local filesystem tools cannot see a remote path; use this to pick a rootPath before creating a remote workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        hostId: { type: 'string', description: 'Remote host id, e.g. "mini".' },
        path: { type: 'string', description: 'Absolute path on the host. Omit for the home directory.' },
      },
      required: ['hostId'],
    },
  },

  // --- High-level macro ---
  {
    name: 'onda_launch_session',
    description:
      '[DEPRECATED — use onda_agent_spawn + onda_agent_prompt; kept for backward compatibility only, same backend.] High-level macro: ensure workspace exists → mount it in target window → add a terminal pane → spawn `bin` with `args` (or `prompt` as single argv). Atomic from the agent\'s point of view. Supports placement modes: "auto" (default), "current-window", "window:<windowId>", "new-window", "ask-user" (interactive — see below).\n\n**Placement "ask-user"**: the tool does NOT proceed. Instead returns { needsDecision: true, options: [{placement, label}], workspace }. The host agent must surface the choice to the human user and re-invoke this tool with placement set to a concrete value (e.g. "window:w-abc").\n\nOn success returns { windowId, workspaceId, terminalId, paneId, pid }.',
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

  // --- Agent delegation (preferred over onda_launch_session) ---
  // These three tools (`spawn` / `wait` / `close`) are the canonical
  // entry points for "Claude session A delegates work to Claude session
  // B via Onda mosaic". They expose the same composer pipeline as the
  // legacy onda_launch_session but with three improvements:
  //   1. Three placement modes (workspace / pane-split / same-workspace)
  //      so the caller can decide whether to splice a new tile, split a
  //      pane in the current workspace, or just add a terminal to an
  //      already-mounted workspace.
  //   2. The mount path goes through the post-fix `mountWorkspaceInTile`
  //      flow, so the tile actually appears in the UI (the legacy
  //      launchSession path only set the active workspace, which after
  //      the B1 fix in Onda 1.9.1 was no longer enough on its own).
  //   3. Optional `subscribe + sessionId` so the caller can immediately
  //      hand the sessionId to `onda_agent_wait` without a separate
  //      `terminal_subscribe` round-trip.
  //
  // The legacy `onda_launch_session` tool still works (it maps to the
  // same backend handler) but is kept only for backward compatibility.
  // New code should prefer `onda_agent_spawn`.
  {
    name: 'onda_agent_spawn',
    description:
      'Boot an agent in a workspace+pane and return once the TUI is ready to accept a prompt. Does NOT submit a task — use `onda_agent_prompt` after spawn for that. Splitting bootstrap and prompt delivery makes the flow resilient: you can retry the prompt without re-paying the agent cold-start (5-10s for Claude), and you can intercept unexpected TUI states between the two steps.\n\n**Check `state`, not only `ready`.** With a `readyPattern`, the response says what the screen really is: "ready" (prompt box up), "trust_prompt" (Claude Code asks whether to trust the folder — happens the first time in a folder), "not_logged_in" ("Not logged in · Please run /login" or the login-method picker), "onboarding" (first-run setup of a fresh account/config dir), or "timeout". Those three screens also draw the `❯` a ready pattern looks for, so before this field they came back as ready. Only `state: "ready"` means `onda_agent_prompt` will land; the others come with `needsUserAction: true` and a `hint`. Output is judged from the moment the command is written, so a reused pane\'s old screens do not count. Use `trust: "accept"` to let the spawn answer the folder question itself.\n\n**Where the session starts.** placement="workspace" locates the workspace by `workspaceRootPath` (the folder is the identity; `workspaceName` is only a label for a new one). The folder is matched by its real path: through a symlink (`~/work-hub/Projects/x` = `~/Projects/x`) or another letter case it is the same workspace, never a new one; if duplicates already exist, the mounted one wins, then the live one, then the most recent. A workspace is born empty, so a pane is never assumed: no pane → one is created; a shell idle at its prompt → reused (`cd`ed into the root, `reusedPane: true`); **the same agent already running in that workspace → NO second session**: you get that terminal back with `reusedAgent: true` and `state` "ready" (waiting for a prompt) or "busy" — prompt it with onda_agent_prompt. `allowDuplicate: true` starts another one anyway; `addTerminalIfNeeded: true` forces a new pane instead of reusing an idle shell. The agent is recognised through an account wrapper too (agentBin "zsh", agentArgs ["-lc", "…exec claude…"]). **After a spawn timeout, do not spawn again blindly**: onda_terminal_list(workspaceId) first — a spawn that timed out often started anyway, and a retry now returns `reusedAgent` instead of a duplicate. The response reports `cwd`, `reusedPane`, `reusedAgent` and `reusedWorkspace`. A second copy of an agent goes in that agent\'s workspace with a distinct bus slug (`export AB_SESSION_SLUG=<name>` in the command), not in a subfolder. Placement modes: "workspace" (default — full create+mount+add), "background" (same, then the workspace leaves the mosaic: the session runs unseen, live in the lists, one click in the app mounts it), "pane-split" (split active pane of current workspace), "same-workspace" (add a terminal to an already-mounted workspace). For non-TUI binaries (bash, scripts), pass the full command in `agentArgs` and use `execMode: "run"`; `onda_agent_prompt` is then unnecessary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        placement: {
          type: 'string',
          enum: ['workspace', 'background', 'pane-split', 'same-workspace'],
          description: 'Where to host the new agent terminal. Default "workspace": create-or-locate workspace + mount + add terminal; the mount never moves the user\'s focus (the blue border stays where they are). "background": the same, but a workspace that was not on screen leaves the mosaic again as soon as its terminal runs — the session lives on unseen, listed as live in onda_workspace_list (mountedIn null) and under "Background · live" in the app, where a click mounts it; onda_agent_prompt / wait / close work as usual. Use it for trial sessions and for delegates nobody needs to watch. The result says `background: true`, or `background: false` + `backgroundNote` when the workspace was already on screen and stays there. Takes the placement=workspace fields (workspaceRootPath, worktree…). "pane-split": split the active pane of the focused workspace. "same-workspace": add a terminal pane to an existing mounted workspace (requires `workspaceId`).',
        },
        // --- placement=workspace ---
        workspaceRootPath: {
          type: 'string',
          description: 'placement=workspace: filesystem path used to locate (or create) the workspace. Matched by real path (symlinks resolved, letter case ignored on case-insensitive volumes), so any spelling of an existing folder reuses its workspace. Only if no workspace has that folder is one created (name = basename unless `workspaceName` is given), registered by its real path.',
        },
        workspaceName: {
          type: 'string',
          description: 'placement=workspace: optional override for the auto-created workspace name. Ignored if a workspace already matches `workspaceRootPath`.',
        },
        targetWindowId: {
          type: 'string',
          description: 'placement=workspace: window to mount the workspace in. Default: focused window.',
        },
        mountDirection: {
          type: 'string',
          enum: ['down', 'right'],
          description: 'placement=workspace: where to splice the new tile in the mosaic. Default "down" (matches the Cmd+P picker default).',
        },
        // --- placement=pane-split ---
        splitDirection: {
          type: 'string',
          enum: ['right', 'down', 'left', 'up', 'horizontal', 'vertical'],
          description: 'placement=pane-split: how to split the active pane. Default "down".',
        },
        splitCwd: {
          type: 'string',
          description: 'placement=pane-split: cwd of the new pane (typically the project root the delegated agent should work in).',
        },
        // --- placement=same-workspace ---
        workspaceId: {
          type: 'string',
          description: 'placement=same-workspace: id of an already-mounted workspace to add a terminal to.',
        },
        addDirection: {
          type: 'string',
          enum: ['right', 'down'],
          description: 'placement=same-workspace: split direction for the new pane. Default "down".',
        },
        // --- universal ---
        agentName: {
          type: 'string',
          description: 'Listener label shown in the pane header (e.g. "kai-2026-05-23"). Recommended: include a date or session identifier so the user can tell concurrent delegations apart.',
        },
        agentBin: {
          type: 'string',
          description: 'Binary to exec inside the pane. Default "claude". Any PATH-resolvable executable works (claude, qwen, codex, bash, etc.).',
        },
        agentArgs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra argv entries appended after the binary. For TUI agents (claude/qwen): use flags only (e.g. ["--dangerously-skip-permissions"]) — DO NOT include the task prompt here; submit it separately via onda_agent_prompt once readyPattern has matched. For non-TUI bins (bash/sh): include the full command line, e.g. ["-lc", "build.sh && echo DONE"].',
        },
        execMode: {
          type: 'string',
          enum: ['exec', 'run'],
          description: 'How to hand the binary to the pane\'s existing shell. Default "exec": writes `exec bin args` so the binary REPLACES the shell (right for long-lived TUI agents like claude/qwen — they own the pane, no shell prompt visible). Set to "run" for one-shot commands (build, script, quick check): writes `bin args` plainly, the shell runs it as a child and re-prompts when done, so the PTY stays alive and `agent.wait` subscribers survive even for short tasks. Wrong choice for short tasks under "exec" causes the PTY to exit the moment the command completes, wiping any pending wait subscriber.',
        },
        readyPattern: {
          type: 'string',
          description: 'JavaScript regex (string form). When set, agent.spawn blocks until the pattern matches new output before returning. Use it to synchronize on "TUI is ready for a prompt" — for Claude TUI a good default is "❯|Welcome back|Try \\"|bypass permissions"; for qwen "qwen>|Ready"; for bash this is unnecessary. The response includes `ready` and `state` (see the tool description): `ready` is true only when `state` is "ready".',
        },
        readyTimeoutMs: {
          type: 'number',
          description: 'Max wait for readyPattern in ms. Default 15000 (15s — enough for Claude cold-start on a busy machine).',
        },
        trust: {
          type: 'string',
          enum: ['report', 'accept', 'reject'],
          description: 'What to do if Claude Code asks "trust this folder?" (first launch in a folder; needs `readyPattern`). Default "report": touch nothing, return `state: "trust_prompt"` so you (or the user) decide. "accept": select "Yes, I trust this folder" (the spawn reads which option is preselected — newer versions preselect "No, exit") and keep waiting for ready; the response has `trust: "accepted"`. "reject": answer no; Claude Code exits. Accept only folders you or the user created or explicitly trust.',
        },
        unmountWhenEmpty: {
          type: 'boolean',
          description: 'What happens when this agent\'s process ends and nothing alive is left in the workspace. The agent\'s pane always goes (no "[Process exited]" left behind). Default: the workspace leaves the mosaic if THIS spawn mounted it, and stays (empty) if it was already mounted. true: always unmount once empty. false: never. Unmount is not delete — the workspace stays in the list.',
        },
        worktree: {
          type: 'object',
          description: 'Run the agent in its own git worktree (placement="workspace" only; replaces workspaceRootPath). If no linked worktree has `branch` checked out, one is created next to the repo at `<repoRoot>-<branch>` (slashes in the branch become dashes: repo `~/P/onda` + branch `feat/x` → `~/P/onda-feat-x`), with `git worktree add -b <branch> <path> <from>` for a new branch, or without -b if the branch exists. An existing worktree for that branch is reused. The folder is marked trusted in ~/.claude/.claude.json and ~/.claude-a/.claude.json, and `trust` defaults to "accept". The workspace is named "<agentName or repo> · <branch>" unless workspaceName is given. The result has `worktree: { path, branch, created, branchCreated, from? }`. Fails with errorCode "worktree_failed" (e.g. branch checked out in the main tree, path taken by another folder). With a cap set (agents.maxWorktreesPerRepo > 0), a spawn that would create a new worktree in a repo already at the cap fails with errorCode "worktree_cap" + `worktrees` (same shape as onda_worktree_list): retire some with onda_worktree_retire first; reusing an existing worktree does not count. One agent per worktree: never spawn two in the same folder.',
          properties: {
            repoRoot: { type: 'string', description: 'Root of the repo (its main tree; a linked worktree of it also works).' },
            branch: { type: 'string', description: 'Branch to work on, e.g. "feat/login".' },
            from: { type: 'string', description: 'Start point for a new branch. Default: the first of master, main, develop that exists.' },
          },
          required: ['repoRoot', 'branch'],
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Opaque string pairs stored on the workspace (max 16 keys, values up to 200 characters), e.g. { "task": "T-12", "owner": "orchestrator-a" }. Onda never interprets them: they survive a restart and come back in the spawn result, onda_workspace_list, onda_workspace_locate and onda_worktree_list, so whoever spawned an agent can find its workspace and worktree again. Given again on a later spawn in the same workspace, keys are merged (a key given again is overwritten). Invalid labels: errorCode "labels_invalid", nothing started.',
        },
        subscribe: {
          type: 'boolean',
          description: 'Attach a listener and return a `sessionId` ready for `onda_agent_wait`. Default true. Also lights up the presence badge in the pane header.',
        },
        allowDuplicate: {
          type: 'boolean',
          description: 'Default false: if the same agent (e.g. claude) already runs in the workspace, no second session is started and its terminal is returned with reusedAgent: true. true: start another session anyway.',
        },
        addTerminalIfNeeded: {
          type: 'boolean',
          description: 'placement=workspace: true forces a new pane even when an idle shell could be reused. Never overrides the no-duplicate rule (see allowDuplicate).',
        },
        snapshotDelay: {
          type: 'number',
          description: 'Milliseconds to wait before reading the first chunk of buffer for the `firstChunk` field in the response. Default 500. Set to 0 to skip the snapshot. Ignored if readyPattern matched and provided a sync point already.',
        },
      },
      required: ['agentBin'],
    },
  },
  {
    name: 'onda_agent_prompt',
    description:
      'Submit a task prompt to an agent that was previously spawned with `onda_agent_spawn`. Use this once `onda_agent_spawn` has returned with `ready: true` (TUI textbox is up and accepting keystrokes). Writes the prompt into the PTY as one bracketed paste (always, short or long: a raw write is taken for a paste by the TUI and its Enter becomes a newline), waits until the textbox shows it, then sends Enter as a separate write and checks the rendered textbox.\n\n**The submission is verified, not assumed.** The result carries `submitted`: true when the TUI was seen to accept the prompt, false when it was not. On false (`reason`: `still_in_box` when the prompt is still in the textbox after one retry of Enter, `no_evidence` when nothing showed the turn starting) `success` is false too: read the terminal before acting, and send Enter via `onda_terminal_send_keys(["Enter"])` only if the prompt is still in the box. `completedSteps` contains "submit" only when submission was actually observed. Idempotent in the sense that you can call it multiple times — useful for multi-line drafts (each call with `submitWith: "none"` except the last) or for retry-on-blocker scenarios.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        terminalId: {
          type: 'string',
          description: 'Terminal id from `onda_agent_spawn` response (paneId === terminalId for terminal-content panes).',
        },
        prompt: {
          type: 'string',
          description: 'The text to write. For TUI agents this populates the textbox. No shell-quoting — the caller talks to a TUI, not a shell, so apostrophes, double quotes and multi-line text are all safe here (this is THE place for the task prompt; never put it in argv). Caller is responsible for any agent-bus preamble (e.g. "# STATUS:", "# DONE" sentinels, "/send kai brief: ..." vocabulary). Onda stays opinion-free about protocol semantics.',
        },
        submitWith: {
          type: 'string',
          enum: ['enter', 'none'],
          description: 'How to submit the prompt. "enter" (default) writes a CR after the text — this is what most TUIs need to actually submit. "none" leaves the text in the buffer without submitting; use this when chaining multiple writes (e.g. multi-line draft, each call writing one line with submitWith=none, the final one with submitWith=enter).',
        },
        readyPattern: {
          type: 'string',
          description: 'Optional defensive ready-sync regex. If provided, `agent.prompt` first runs a quick `waitForPattern` (default 5s timeout) before writing. Cheap when the buffer already matches; safety net when the caller is racing TUI cold-start. Generally redundant if `agent.spawn` already synced on the same pattern.',
        },
        readyTimeoutMs: {
          type: 'number',
          description: 'Max wait for `readyPattern` in ms. Default 5000.',
        },
        preWriteDelay: {
          type: 'number',
          description: 'Optional ms delay between ready-sync and the actual write. Some TUIs need a beat to finish layout transitions even after the textbox is technically present.',
        },
        postSubmitDelay: {
          type: 'number',
          description: 'Optional ms delay after sending Enter, before returning. Useful if you want to give the agent a moment to start streaming output that the next caller-side step (terminal_read snapshot, agent_wait) will need.',
        },
        onlyIfIdle: {
          type: 'boolean',
          description: 'Default false. If true, nothing is written unless the agent is idle: refuses with { success:false, errorCode:"not_idle", reason, completedSteps:[] } where reason is busy (agent working), asking (permission/answer prompt on screen), has_text (the human has text in the box, even typed seconds ago) or no_session (no agent session known on that terminal). For whoever wakes an idle session without writing over the user.',
        },
      },
      required: ['terminalId', 'prompt'],
    },
  },
  {
    name: 'onda_agent_wait',
    description:
      'Block on a subscriber session until a regex matches new terminal output, or timeout. Use this after `onda_agent_spawn` to wait for a sentinel pattern that indicates the delegated agent is done (or has hit a blocker). Returns { matched, match?, bufferedChunks, tailContent? } where tailContent is the last ~4KB of accumulated output (useful for surfacing a summary to the user or for debugging mismatched expectations).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session id returned by `onda_agent_spawn` (or by a manual `onda_terminal_subscribe`).',
        },
        doneRegex: {
          type: 'string',
          description: 'JavaScript regex (string form). Default matches `^# DONE`, `^# BLOCKED`, or `Esc to interrupt`. Pick a sentinel that matches whatever the agent-bus protocol used by your team prescribes.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Max wait in ms. Default 300000 (5 min). Cap to whatever your task complexity warrants.',
        },
        flags: {
          type: 'string',
          description: 'Regex flags. Default "m" (multiline).',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'onda_agent_close',
    description:
      'Escalation cleanup after an agent finishes (or to abandon a delegation). Three levels: SOFT — only `sessionId` set → unsubscribe (keeps PTY alive, lets you reattach or let the user inspect). MEDIUM — `+ killPty + terminalId` → terminates the agent process; a pane created by onda_agent_spawn goes with it. HARD — `+ unmountWorkspace + workspaceId` (and optionally `+ closeWindow + windowId`) → full teardown of an ephemeral delegation. Add `closePane` to remove any pane (the workspace\'s last one included) instead of leaving it on screen as "[Process exited]".\n\n**Empty workspaces.** After a kill or a pane close, if no live terminal is left in the workspace it leaves the mosaic when onda_agent_spawn mounted it (default), or when `unmountWhenEmpty: true`; a workspace the user mounted by hand stays, in its empty state. The result says `workspaceEmpty`, `unmounted`, and `removedPaneIds` (the closed pane plus any dead agent panes). For "[Process exited]" panes that are not the agent\'s, use onda_workspace_prune. All fields are optional; the tool does only what you ask (closeWindow without killPty first detaches the window\'s workspaces, so their sessions survive the close).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Subscriber session to detach. Idempotent.' },
        terminalId: { type: 'string', description: 'Terminal to kill. Required when `killPty` is true.' },
        workspaceId: { type: 'string', description: 'The agent\'s workspace. Required when `unmountWorkspace` is true; otherwise optional (found from the pane).' },
        killPty: { type: 'boolean', description: 'Default false. When true, the underlying PTY process is terminated. A pane created by onda_agent_spawn is removed with it; any other pane shows [Process exited] unless `closePane` is set.' },
        closePane: { type: 'boolean', description: 'Default false. When true, the pane is removed from its workspace (typically together with killPty), the last one included. The result says `paneClosed` (and `paneCloseSkipped` with the reason when it could not).' },
        unmountWhenEmpty: { type: 'boolean', description: 'What to do if no live terminal is left after the close. Default: unmount only if onda_agent_spawn mounted the workspace. true: unmount. false: keep it mounted (empty). Unmount is not delete — the workspace stays in the list.' },
        paneId: { type: 'string', description: 'Pane to close with `closePane`. Default: `terminalId` (they are the same for terminal panes spawned by onda_agent_spawn).' },
        unmountWorkspace: { type: 'boolean', description: 'Default false. When true, the workspace is dropped from its window\'s mosaic. The workspace itself still exists in the global list.' },
        closeWindow: { type: 'boolean', description: 'Default false. When true, the host window is closed via `BrowserWindow.close()`. Requires `windowId`. Only use when YOU spawned this window via `onda_window_new`.' },
        windowId: { type: 'string', description: 'Required when `closeWindow` is true.' },
        removeWorktree: { type: 'boolean', description: 'For an agent spawned with `worktree` the default is true, and killPty defaults to true when `terminalId` is given: closing it kills the session, unmounts the workspace once empty, then runs the onda_worktree_retire checks (nothing in use, clean, work already in origin\'s master/main/develop by merge, squash or merged PR) and, if they pass, `git worktree remove` + prune and deletes the workspace (its folder is gone). The result then has `closedViaRetire: true`. Here the branch is never deleted and no tag is made (for that, call onda_worktree_retire). Result: `worktreeRemoved: { path, branch, mergedInto, integratedBy }` + `workspaceDeleted`, or `worktreeKept: { reason, detail? }` with the onda_worktree_retire reasons, or "workspace_not_found", "remote_workspace", "workspace_unknown"; when the worktree is kept its workspace is unmounted and archived (`workspaceArchived: true`), or `workspaceKept: { reason }` if something in it still runs. Pass false to only stop watching (old behaviour). Any other agent: default false, true runs the same retire.' },
      },
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

  // ─── Workflow Canvas orchestration (F2.3) ───
  // Build and run a visual pipeline where each node is a headless `claude -p`
  // session, chained output→input. Use these to compose a multi-step Claude
  // pipeline programmatically instead of doing every step yourself in one
  // session — e.g. "generate options → critique → pick best → implement".
  {
    name: 'onda_workflow_create',
    description:
      'Create a new (empty) Workflow Canvas pipeline bound to a workspace. Call this when you want to compose a multi-step pipeline of chained Claude sessions. Returns { id }. Then add steps with onda_workflow_add_step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable workflow name.' },
        workspaceId: { type: 'string', description: 'Target workspace id the run spawns into (from onda_workspace_list).' },
      },
      required: ['workspaceId'],
    },
  },
  {
    name: 'onda_workflow_add_step',
    description:
      'Append a step to a workflow. Each step is one `claude -p` session with a prompt; its structured JSON output is fed to downstream steps. Set inputFrom to the step ids whose output this step needs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflowId: { type: 'string', description: 'Workflow id from onda_workflow_create.' },
        prompt: { type: 'string', description: 'Instruction for this step. End it by telling Claude to write its structured JSON result (the runner injects the exact output path).' },
        label: { type: 'string', description: 'Short label for the node.' },
        model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'], description: 'Model tier (default sonnet). Use haiku for cheap mechanical steps.' },
        inputFrom: { type: 'array', items: { type: 'string' }, description: 'Step ids whose JSON output to inject into this prompt.' },
        edgeMode: { type: 'string', enum: ['fresh', 'resume'], description: 'fresh = new session; resume = inherit the upstream session context.' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: "Tools for --allowedTools (e.g. ['Write']). Default ['Read','Write']." },
        mode: { type: 'string', enum: ['headless', 'interactive'], description: 'headless `claude -p` (default) or interactive TUI in a pane.' },
      },
      required: ['workflowId', 'prompt'],
    },
  },
  {
    name: 'onda_workflow_connect',
    description: 'Connect two steps (source → target): adds the edge and makes target consume source\'s output. Call after adding both steps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflowId: { type: 'string' },
        source: { type: 'string', description: 'Upstream step id.' },
        target: { type: 'string', description: 'Downstream step id.' },
      },
      required: ['workflowId', 'source', 'target'],
    },
  },
  {
    name: 'onda_workflow_run',
    description:
      'Run a workflow. Spawns each step in order in the target workspace, chaining output→input. Returns { accepted }. Poll onda_workflow_status for progress + cost. Runs under safety caps (max steps/concurrency/budget; never bypasses tool permissions).',
    inputSchema: {
      type: 'object' as const,
      properties: { workflowId: { type: 'string' } },
      required: ['workflowId'],
    },
  },
  {
    name: 'onda_workflow_cancel',
    description: 'Cancel an in-flight workflow run.',
    inputSchema: {
      type: 'object' as const,
      properties: { workflowId: { type: 'string' } },
      required: ['workflowId'],
    },
  },
  {
    name: 'onda_workflow_status',
    description: 'Get a workflow run status: per-step status, cost, duration, and cumulative cost. Call this to watch progress after onda_workflow_run.',
    inputSchema: {
      type: 'object' as const,
      properties: { workflowId: { type: 'string' } },
      required: ['workflowId'],
    },
  },
  {
    name: 'onda_workflow_list',
    description: 'List saved workflows (id, name, step count). Use to discover existing pipelines before creating a new one.',
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
  onda_pane_attach: { method: 'pane.attach' },

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

  // Agent Team — see agent-team-os/schema/CONTRACT.md
  onda_agent_sessions: { method: 'agent.sessions' },
  onda_agent_events: { method: 'agent.events' },
  onda_agentic_open: { method: 'agentic.open' },
  onda_agentic_close: { method: 'agentic.close' },
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
      waitForReady: args.waitForReady,
      direction: args.direction,
      relativeToPaneId: args.relativeToPaneId,
    }),
  },
  onda_workspace_tile: { method: 'workspace.setLayout' },
  onda_workspace_locate: { method: 'workspace.locate' },

  // Window
  onda_window_list: { method: 'window.list' },
  onda_window_new: { method: 'window.new' },
  onda_window_focus: { method: 'window.focus' },
  onda_window_mount_workspace: { method: 'window.mountWorkspace' },
  onda_workspace_unmount: { method: 'workspace.unmount' },
  onda_workspace_prune: { method: 'workspace.prune' },
  onda_workspace_remove: { method: 'workspace.remove' },
  onda_workspace_remove_dead: { method: 'workspace.removeDead' },
  onda_worktree_retire: { method: 'worktree.retire' },
  onda_worktree_list: { method: 'worktree.list' },

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

  // Remote hosts. No mapParams: every declared field is forwarded as-is, per
  // the warning below about schemas and mappers drifting apart.
  onda_remote_list: { method: 'remote.list' },
  onda_remote_sessions: { method: 'remote.sessions' },
  onda_remote_readdir: { method: 'remote.readDir' },
  onda_launch_session: { method: 'launchSession' },

  // Agent delegation: forward EVERY declared param to the backend. Do
  // not silently drop fields (the old `workspace.addTerminal` mapParams
  // bug was caused exactly by that: schema declared `direction`, mapper
  // omitted it, calls silently fell back to default placement).
  onda_agent_spawn: {
    method: 'agent.spawn',
    mapParams: (args) => ({
      placement: args.placement,
      workspaceRootPath: args.workspaceRootPath,
      workspaceName: args.workspaceName,
      targetWindowId: args.targetWindowId,
      mountDirection: args.mountDirection,
      splitDirection: args.splitDirection,
      splitCwd: args.splitCwd,
      workspaceId: args.workspaceId,
      addDirection: args.addDirection,
      agentName: args.agentName,
      agentBin: args.agentBin,
      agentArgs: args.agentArgs,
      execMode: args.execMode,
      subscribe: args.subscribe,
      snapshotDelay: args.snapshotDelay,
      readyPattern: args.readyPattern,
      readyTimeoutMs: args.readyTimeoutMs,
      trust: args.trust,
      unmountWhenEmpty: args.unmountWhenEmpty,
      worktree: args.worktree,
      labels: args.labels,
      allowDuplicate: args.allowDuplicate,
      addTerminalIfNeeded: args.addTerminalIfNeeded,
    }),
  },
  onda_agent_prompt: {
    method: 'agent.prompt',
    mapParams: (args) => ({
      terminalId: args.terminalId,
      prompt: args.prompt,
      submitWith: args.submitWith,
      readyPattern: args.readyPattern,
      readyTimeoutMs: args.readyTimeoutMs,
      preWriteDelay: args.preWriteDelay,
      postSubmitDelay: args.postSubmitDelay,
      onlyIfIdle: args.onlyIfIdle,
    }),
  },
  onda_agent_wait: {
    method: 'agent.wait',
    mapParams: (args) => ({
      sessionId: args.sessionId,
      doneRegex: args.doneRegex,
      timeoutMs: args.timeoutMs,
      flags: args.flags,
    }),
  },
  onda_agent_close: {
    method: 'agent.close',
    mapParams: (args) => ({
      sessionId: args.sessionId,
      terminalId: args.terminalId,
      workspaceId: args.workspaceId,
      killPty: args.killPty,
      closePane: args.closePane,
      paneId: args.paneId,
      unmountWorkspace: args.unmountWorkspace,
      unmountWhenEmpty: args.unmountWhenEmpty,
      closeWindow: args.closeWindow,
      windowId: args.windowId,
      removeWorktree: args.removeWorktree,
    }),
  },

  // Workflow Canvas orchestration (F2.3)
  onda_workflow_create: { method: 'workflow.create' },
  onda_workflow_add_step: { method: 'workflow.addStep' },
  onda_workflow_connect: { method: 'workflow.connect' },
  onda_workflow_run: { method: 'workflow.run' },
  onda_workflow_cancel: { method: 'workflow.cancel' },
  onda_workflow_status: { method: 'workflow.status' },
  onda_workflow_list: { method: 'workflow.list' },

  // System (onda_context handled separately - it's local, not RPC)
  onda_status: { method: 'session.current' },
  onda_app_info: { method: 'app.info' },
  onda_ping: { method: 'app.ping' },
};

// ─── MCP Server ──────────────────────────────────────────────

// Injected into the client's system prompt on connect. This is the one place
// where a model reads the *hierarchy* between tools — descriptions alone are
// flat, and three overlapping pipelines (agent_*, launch_session, the manual
// workspace_create → add_terminal → terminal_spawn dance) look equally valid
// without it. Keep it short: it costs context on every session.
const SERVER_INSTRUCTIONS = `Onda is the terminal emulator you are running inside. These tools mutate the live app the user is looking at — treat pane/workspace state as shared with them.

Layout model: Window ⊃ Workspace (root folder + panes, mounted as a tile in a window) ⊃ Pane (terminal | editor | diff). Terminals have a stable terminalId.

TO OPEN A WORKSPACE AND START AN AGENT SESSION (claude, codex, qwen, ...), ALWAYS use the agent_* flow:
  1. onda_agent_spawn(placement="workspace", workspaceRootPath=<path>, agentBin="claude", agentArgs=[flags only], readyPattern="❯|Welcome back|Try \\"")
     → locates the workspace BY FOLDER (real path: symlinks and letter case count as the same folder; creates it only if none exists), mounts it, picks the pane (none → creates one; idle shell → reuses it; the same agent already there → no second session, returns it with reusedAgent=true), starts the session in that folder, blocks until the screen settles. Returns terminalId + sessionId + state + reusedWorkspace.
     Read state before prompting: "ready" → go on. "trust_prompt" → first launch in that folder: ask the user, or spawn again with trust="accept" for a folder you created. "not_logged_in" / "onboarding" → the account needs /login or its first-run setup: tell the user, do not prompt. "timeout" → read the terminal. reusedPane/cwd say where the session started.
  2. onda_agent_prompt(terminalId, prompt) → writes the task into the TUI textbox and presses Enter. No shell involved: apostrophes, quotes and newlines are safe here.
  3. onda_agent_wait(sessionId, doneRegex, timeoutMs<=15000 in a loop) → wait for a sentinel.
  4. onda_agent_close(sessionId) → detach (soft); + killPty + terminalId → kill it, and the spawned pane goes with it. A workspace the spawn mounted leaves the mosaic once nothing alive is left in it (unmountWhenEmpty overrides). Leftover "[Process exited]" panes: onda_workspace_prune(workspaceId).
Placement variants: "background" (as "workspace", but the session runs unseen: listed as live, a click in the app mounts it — for trial sessions and delegates nobody needs to watch), "pane-split" (split the pane you are in), "same-workspace" (add a pane to an already-mounted workspaceId).
Parallel agents on one repo: onda_agent_spawn(worktree={repoRoot, branch}) creates/reuses the branch's worktree next to the repo, trusts it and mounts it; one agent per worktree. onda_agent_close(killPty, terminalId, workspaceId, removeWorktree=true) removes it only if nothing runs there, it is clean and its work is in origin's base (merge, squash or merged PR; else worktreeKept.reason), and deletes the workspace (kept: archived, with worktreeKept.reason); the branch stays. For an agent spawned with worktree this is the default of onda_agent_close(terminalId): removeWorktree=false only stops watching. onda_worktree_retire(workspaceId) also archives the branch under a tag and deletes it; onda_worktree_list(repoRoot) shows what is open. Spawn labels (labels={...}) stay on the workspace to find it again. Dead workspaces (rootExists=false in onda_workspace_list) are deleted, not archived: onda_workspace_remove (mode defaults to delete there) or all at once with onda_workspace_remove_dead(dryRun first).
Live = an agent session or a non-shell process (live_reason agent|process in the list tools); a shell at its prompt is not live. Workspaces are born empty (no implicit terminal). A spawn never duplicates an agent already in the workspace; after a spawn TIMEOUT, onda_terminal_list(workspaceId) before anything else — never a blind second spawn. After each spawn that put a workspace on screen, call onda_workspace_tile(layout="main", anchorWorkspaceId=<your workspace>): you large on the left, the agents in a column on the right.

DO NOT: pass the task prompt as an argv element (agentArgs, terminal_spawn args, launch_session prompt) — a single apostrophe breaks zsh parsing and the prompt never reaches the agent. DO NOT use onda_launch_session (deprecated; same backend, worse ergonomics). DO NOT hand-assemble workspace_create → window_mount_workspace → workspace_add_terminal → terminal_spawn → send_keys unless agent_spawn returned an error you must work around.

Terminal I/O rules: onda_terminal_read is a snapshot, subscribe+poll is a stream, wait_for(regex) is a sync barrier — prefer wait_for over polling noisy TUIs. Control keys go through onda_terminal_send_keys (["Ctrl+C"], ["Enter"]), never as escape bytes in terminal_send. In a TUI textbox a trailing \\n is a newline, not Submit: follow text with send_keys(["Enter"]). Always unsubscribe listeners you opened.`;

const server = new Server(
  {
    name: 'onda',
    version: '0.6.0',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
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
