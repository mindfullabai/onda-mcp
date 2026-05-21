#!/usr/bin/env node
/**
 * Install (or update) the onda-mcp-usage Claude Code skill into
 * `~/.claude/skills/onda-mcp-usage/`.
 *
 * Runs automatically as a `postinstall` step of @mindfullabai/onda-mcp,
 * AND can be invoked manually:
 *   npx @mindfullabai/onda-mcp install-skill
 *   npx @mindfullabai/onda-mcp install-skill --force
 *   npx @mindfullabai/onda-mcp install-skill --skills-dir /custom/path
 *
 * Idempotent + version-aware: if the installed SKILL.md has the same
 * `metadata.version` as the bundled one, skip. Use `--force` to overwrite
 * regardless. Honors `--quiet` for silent CI runs.
 *
 * Failure modes are non-fatal: if we cannot write (e.g. ~/.claude doesn't
 * exist on a CI box), we log a hint and exit 0 so `npm install` does not
 * abort the user's workflow.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir, EOL } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const SOURCE_SKILL_PATH = resolve(PKG_ROOT, 'skills', 'onda-mcp-usage', 'SKILL.md');

const argv = process.argv.slice(2);
const FLAG_FORCE = argv.includes('--force');
const FLAG_QUIET = argv.includes('--quiet') || process.env.ONDA_MCP_QUIET === '1';

const customSkillsDirIdx = argv.findIndex((a) => a === '--skills-dir');
const TARGET_SKILLS_DIR =
  customSkillsDirIdx !== -1 && argv[customSkillsDirIdx + 1]
    ? resolve(argv[customSkillsDirIdx + 1])
    : join(homedir(), '.claude', 'skills');

const TARGET_SKILL_DIR = join(TARGET_SKILLS_DIR, 'onda-mcp-usage');
const TARGET_SKILL_PATH = join(TARGET_SKILL_DIR, 'SKILL.md');

const log = (...args) => {
  if (!FLAG_QUIET) console.log('[onda-mcp install-skill]', ...args);
};

/**
 * Extract `metadata.version: x.y.z` from a SKILL.md frontmatter, or
 * fall back to the top-level `version:` key. Returns null if absent.
 */
function extractVersion(content) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const block = fm[1];
  const metaVer = block.match(/^\s*version:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
  if (metaVer) return metaVer[1].trim();
  return null;
}

function main() {
  if (!existsSync(SOURCE_SKILL_PATH)) {
    log(`source skill missing at ${SOURCE_SKILL_PATH} — nothing to install`);
    return;
  }

  const sourceContent = readFileSync(SOURCE_SKILL_PATH, 'utf8');
  const sourceVersion = extractVersion(sourceContent);

  // Target dir may not exist (Claude Code not installed on this box).
  if (!existsSync(dirname(TARGET_SKILLS_DIR))) {
    log(
      `~/.claude not found — Claude Code does not appear to be installed.${EOL}` +
        '       Skipping skill install. Run `npx @mindfullabai/onda-mcp install-skill` later if needed.',
    );
    return;
  }

  let installedVersion = null;
  if (existsSync(TARGET_SKILL_PATH)) {
    try {
      installedVersion = extractVersion(readFileSync(TARGET_SKILL_PATH, 'utf8'));
    } catch {
      installedVersion = null;
    }
  }

  if (!FLAG_FORCE && installedVersion && sourceVersion && installedVersion === sourceVersion) {
    log(`already up to date (v${installedVersion}) — skipping. Use --force to overwrite.`);
    return;
  }

  try {
    mkdirSync(TARGET_SKILL_DIR, { recursive: true });
    writeFileSync(TARGET_SKILL_PATH, sourceContent, 'utf8');
    const verLabel = sourceVersion ? `v${sourceVersion}` : '(unversioned)';
    if (installedVersion) {
      log(`updated ${installedVersion} -> ${sourceVersion ?? '?'} at ${TARGET_SKILL_PATH}`);
    } else {
      log(`installed ${verLabel} at ${TARGET_SKILL_PATH}`);
    }
    // Sanity: confirm write
    const written = statSync(TARGET_SKILL_PATH);
    if (written.size === 0) {
      log('WARNING: wrote 0 bytes — install may have failed silently');
      process.exitCode = 1;
    }
  } catch (err) {
    log(`install failed: ${err.message}`);
    log('  Hint: run with --skills-dir <path> to redirect, or fix permissions on ~/.claude/skills/');
    // Non-fatal during postinstall to avoid breaking `npm install`.
    return;
  }
}

main();
