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
      'List all active terminals with their IDs, PIDs, working directories, and alive status. Essential for discovering which terminals exist before running commands.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
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

  // --- Workspace ---
  {
    name: 'onda_workspace_list',
    description: 'List all workspaces with their IDs, names, root paths, and which is active.',
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
    description: 'Add a new terminal pane to a workspace. Works in tiled mode to create terminals within workspace layout.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID. Omit to use active workspace.' },
        cwd: { type: 'string', description: 'Working directory for the new terminal.' },
        shell: { type: 'string', description: 'Shell to use (e.g., /bin/zsh).' },
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
  onda_terminal_run: { method: 'terminal.run' },
  onda_terminal_send: { method: 'terminal.send' },
  onda_terminal_list: { method: 'terminal.list' },
  onda_terminal_kill: { method: 'terminal.kill' },

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
