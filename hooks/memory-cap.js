#!/usr/bin/env node
'use strict';
// PreToolUse hook: enforce Hermes-style memory capacity cap.
//
// Blocks (exit 2) a Write that would ADD a new file under a /memory/ directory
// while the MEMORY.md index is over capacity. Edits and overwrites of existing
// files always pass — blocking consolidation would deadlock the agent.
// After 3 blocks in the same session the hook downgrades to a warning
// (Hermes: _MAX_CONSOLIDATION_FAILURES_PER_TURN = 3).
const fs = require('fs');
const path = require('path');
const { loadConfig, loadState, saveState, readStdinJson } = require('./lib');

const MAX_BLOCKS_PER_SESSION = 3;
const MAX_TRACKED_SESSIONS = 50;

function main() {
  const config = loadConfig();
  if (!config.memory_cap_enabled) return 0;

  const event = readStdinJson();
  if (!event || !event.tool_input) return 0;

  const filePath = event.tool_input.file_path;
  if (!filePath || typeof filePath !== 'string') return 0;

  // Windows paths may use backslashes; normalize before segment matching.
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.toLowerCase().lastIndexOf('/memory/');
  if (idx === -1) return 0;

  // Only the creation of a NEW memory file is capped. Modifying an existing
  // file (consolidation / cleanup direction, and every Edit call) passes.
  if (fs.existsSync(filePath)) return 0;
  if (event.tool_name === 'Edit') return 0;

  const memoryDir = norm.slice(0, idx + '/memory'.length);
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) return 0; // no index yet -> nothing to overflow

  let content;
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch (_err) {
    return 0;
  }

  const lineCount = content.split('\n').filter((l) => l.trim() !== '').length;
  const byteSize = Buffer.byteLength(content, 'utf8');
  const maxLines = config.memory_index_max_lines;
  const maxBytes = config.memory_index_max_bytes;
  if (lineCount <= maxLines && byteSize <= maxBytes) return 0;

  // Over capacity. Infinite-loop guard: after 3 blocks this session, warn and pass.
  const state = loadState();
  const blocks = state.memory_cap_blocks || {};
  const sessionId = event.session_id || 'unknown';
  const blockCount = blocks[sessionId] || 0;

  if (blockCount >= MAX_BLOCKS_PER_SESSION) {
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          `livermore: memory index still over cap (${lineCount}/${maxLines} lines, ` +
          `${byteSize}/${maxBytes} bytes) but the write was allowed after ` +
          `${blockCount} blocked attempts this session.`
      })
    );
    return 0;
  }

  blocks[sessionId] = blockCount + 1;
  const keys = Object.keys(blocks);
  if (keys.length > MAX_TRACKED_SESSIONS) {
    for (const key of keys.slice(0, keys.length - MAX_TRACKED_SESSIONS)) delete blocks[key];
  }
  state.memory_cap_blocks = blocks;
  saveState(state);

  process.stderr.write(
    [
      `Memory index is over capacity: ${lineCount} lines / limit ${maxLines} lines, ` +
        `${byteSize} bytes / limit ${maxBytes} bytes.`,
      'Adding a NEW memory file is blocked until the index shrinks.',
      '',
      `Current MEMORY.md index (${indexPath}):`,
      '---',
      content.trimEnd(),
      '---',
      '',
      'Consolidate (replace) existing memories or delete stale entries first, then retry ' +
        'this save within the same turn. Editing or rewriting EXISTING memory files is ' +
        'always allowed — only new-file creation is capped.'
    ].join('\n')
  );
  return 2;
}

process.exit(main());
