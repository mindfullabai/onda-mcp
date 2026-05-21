#!/usr/bin/env node
/**
 * `onda-mcp-install-skill` bin entry. Forwards to scripts/install-skill.mjs.
 *
 * Distributed via package.json `bin` so users can run:
 *   npx @mindfullabai/onda-mcp install-skill
 *
 * (npm executes the matching `onda-mcp-install-skill` binary; we ship a
 * minimal wrapper to allow forwarding any argv.)
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(__dirname, '..', 'scripts', 'install-skill.mjs');
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 0);
