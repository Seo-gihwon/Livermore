'use strict';
// Shared helpers for livermore hooks. No dependencies, Node.js only (no PowerShell anywhere).
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

const CONFIG_DEFAULTS = {
  memory_index_max_lines: 20,
  memory_index_max_bytes: 4096,
  review_interval: 10,
  review_model: 'claude-haiku-4-5-20251001',
  review_enabled: true,
  memory_cap_enabled: true,
  claude_command: 'claude',
  digest_message_count: 24,
  digest_message_max_chars: 1000
};

function configFile() {
  return process.env.LIVERMORE_CONFIG_FILE || path.join(PLUGIN_ROOT, 'config.json');
}

function stateFile() {
  return process.env.LIVERMORE_STATE_FILE || path.join(PLUGIN_ROOT, '.state.json');
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

function loadConfig() {
  return Object.assign({}, CONFIG_DEFAULTS, readJsonFile(configFile(), {}));
}

function loadState() {
  const state = readJsonFile(stateFile(), {});
  return typeof state === 'object' && state !== null ? state : {};
}

function saveState(state) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n');
  } catch (_err) {
    // State persistence is best-effort; a hook must never crash the session over it.
  }
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch (_err) {
    return null;
  }
}

module.exports = { PLUGIN_ROOT, loadConfig, loadState, saveState, readStdinJson };
