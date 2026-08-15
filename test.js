#!/usr/bin/env node
'use strict';
// Plain-assert test suite for the livermore hooks. Run: node test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, 'hooks');
const MEMORY_CAP = path.join(HOOKS, 'memory-cap.js');
const SELF_REVIEW = path.join(HOOKS, 'self-review.js');

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livermore-test-'));
let testCount = 0;

function tempDir(name) {
  const dir = path.join(workRoot, `${name}-${testCount}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir, overrides) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(Object.assign({}, overrides)));
  return file;
}

function runHook(script, event, { configFile, stateFile, env } = {}) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || {}, {
      LIVERMORE_CONFIG_FILE: configFile,
      LIVERMORE_STATE_FILE: stateFile
    })
  });
}

function test(name, fn) {
  testCount++;
  fn();
  console.log(`ok ${testCount} - ${name}`);
}

// ---------- memory-cap.js ----------

function makeMemoryDir(indexLines) {
  const dir = tempDir('mem');
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir);
  if (indexLines !== null) {
    const content = Array.from({ length: indexLines }, (_, i) => `- memory entry ${i + 1}`).join('\n') + '\n';
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), content);
  }
  return memoryDir;
}

function writeEvent(filePath, sessionId = 'sess-1', toolName = 'Write') {
  return {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: { file_path: filePath, content: 'new memory' }
  };
}

test('memory-cap: blocks new file when index over line cap (exit 2, Hermes-style message)', () => {
  const memoryDir = makeMemoryDir(21);
  const stateFile = path.join(tempDir('state'), 'state.json');
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, 'new-note.md')), { configFile, stateFile });
  assert.strictEqual(res.status, 2, `expected exit 2, got ${res.status}\n${res.stderr}`);
  assert.ok(res.stderr.includes('21 lines / limit 20 lines'), 'stderr must state current vs limit');
  assert.ok(res.stderr.includes('memory entry 21'), 'stderr must include full MEMORY.md index');
  assert.ok(/[Cc]onsolidate/.test(res.stderr), 'stderr must instruct consolidation + retry');
});

test('memory-cap: passes when index is at the cap (20 lines)', () => {
  const memoryDir = makeMemoryDir(20);
  const stateFile = path.join(tempDir('state'), 'state.json');
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, 'new-note.md')), { configFile, stateFile });
  assert.strictEqual(res.status, 0);
});

test('memory-cap: blocks on byte cap even when line count is fine', () => {
  const memoryDir = makeMemoryDir(null);
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- ' + 'x'.repeat(5000) + '\n');
  const stateFile = path.join(tempDir('state'), 'state.json');
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, 'new-note.md')), { configFile, stateFile });
  assert.strictEqual(res.status, 2);
  assert.ok(res.stderr.includes('bytes / limit 4096 bytes'));
});

test('memory-cap: Write to an EXISTING memory file passes (consolidation direction)', () => {
  const memoryDir = makeMemoryDir(25);
  const existing = path.join(memoryDir, 'old-note.md');
  fs.writeFileSync(existing, 'old content');
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runHook(MEMORY_CAP, writeEvent(existing), {
    configFile,
    stateFile: path.join(tempDir('state'), 'state.json')
  });
  assert.strictEqual(res.status, 0);
});

test('memory-cap: rewriting MEMORY.md itself passes (index cleanup must never deadlock)', () => {
  const memoryDir = makeMemoryDir(25);
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, 'MEMORY.md')), {
    configFile,
    stateFile: path.join(tempDir('state'), 'state.json')
  });
  assert.strictEqual(res.status, 0);
});

test('memory-cap: Edit tool passes', () => {
  const memoryDir = makeMemoryDir(25);
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, 'missing.md'), 'sess-1', 'Edit'), {
    configFile,
    stateFile: path.join(tempDir('state'), 'state.json')
  });
  assert.strictEqual(res.status, 0);
});

test('memory-cap: non-memory paths pass untouched', () => {
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runHook(MEMORY_CAP, writeEvent(path.join(tempDir('proj'), 'src', 'app.js')), {
    configFile,
    stateFile: path.join(tempDir('state'), 'state.json')
  });
  assert.strictEqual(res.status, 0);
});

test('memory-cap: after 3 blocks in a session the 4th attempt passes with a warning', () => {
  const memoryDir = makeMemoryDir(30);
  const stateFile = path.join(tempDir('state'), 'state.json');
  const configFile = writeConfig(tempDir('cfg'), {});
  for (let i = 0; i < 3; i++) {
    const res = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, `n${i}.md`), 'sess-loop'), { configFile, stateFile });
    assert.strictEqual(res.status, 2, `block ${i + 1} should exit 2`);
  }
  const res4 = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, 'n4.md'), 'sess-loop'), { configFile, stateFile });
  assert.strictEqual(res4.status, 0, '4th attempt must pass');
  const out = JSON.parse(res4.stdout);
  assert.ok(out.systemMessage.includes('allowed'), 'must surface a bypass warning');
  // A different session still gets blocked.
  const other = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, 'n5.md'), 'sess-other'), { configFile, stateFile });
  assert.strictEqual(other.status, 2);
});

test('memory-cap: memory_cap_enabled=false disables the check', () => {
  const memoryDir = makeMemoryDir(30);
  const configFile = writeConfig(tempDir('cfg'), { memory_cap_enabled: false });
  const res = runHook(MEMORY_CAP, writeEvent(path.join(memoryDir, 'new.md')), {
    configFile,
    stateFile: path.join(tempDir('state'), 'state.json')
  });
  assert.strictEqual(res.status, 0);
});

// ---------- self-review.js ----------

function makeTranscript(messageCount) {
  const dir = tempDir('transcript');
  const file = path.join(dir, 'transcript.jsonl');
  const lines = [];
  for (let i = 1; i <= messageCount; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant';
    lines.push(JSON.stringify({ type: role, message: { role, content: `msg-${String(i).padStart(2, '0')} body` } }));
    // Noise the digest must skip: tool-only assistant turns and system lines.
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }));
    lines.push(JSON.stringify({ type: 'system', subtype: 'noise' }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function runReview(transcriptPath, { configFile, stateFile, env } = {}) {
  return runHook(SELF_REVIEW, { session_id: 'sess-r', transcript_path: transcriptPath }, {
    configFile,
    stateFile,
    env: Object.assign({ LIVERMORE_DRYRUN: '1' }, env || {})
  });
}

test('self-review: fires only every review_interval turns (global cumulative counter)', () => {
  const transcript = makeTranscript(30);
  const stateFile = path.join(tempDir('state'), 'state.json');
  const configFile = writeConfig(tempDir('cfg'), { review_interval: 10 });
  for (let turn = 1; turn <= 9; turn++) {
    const res = runReview(transcript, { configFile, stateFile });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout.trim(), '', `turn ${turn} must not fire`);
  }
  const res10 = runReview(transcript, { configFile, stateFile });
  assert.strictEqual(res10.status, 0);
  const out = JSON.parse(res10.stdout);
  assert.strictEqual(out.dryrun, true, 'turn 10 must fire');
  assert.strictEqual(out.args[0], '-p');
  assert.ok(out.args.includes('claude-haiku-4-5-20251001'), 'must pass configured review model');
  const res11 = runReview(transcript, { configFile, stateFile });
  assert.strictEqual(res11.stdout.trim(), '', 'turn 11 must not fire');
  assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).turn_count, 11, 'counter accumulates across sessions');
});

test('self-review: digest contains only the last 24 messages', () => {
  const transcript = makeTranscript(30);
  const stateFile = path.join(tempDir('state'), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ turn_count: 9 }));
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runReview(transcript, { configFile, stateFile });
  const out = JSON.parse(res.stdout);
  const prompt = fs.readFileSync(out.prompt_file, 'utf8');
  assert.ok(prompt.includes('msg-30'), 'newest message present');
  assert.ok(prompt.includes('msg-07'), 'message 7 (30-24+1) present');
  assert.ok(!prompt.includes('msg-06'), 'message 6 must be cut');
  assert.ok(!prompt.includes('tool_use'), 'tool-only turns must be excluded');
  assert.ok(prompt.includes('last 24 messages'));
  assert.ok(prompt.includes('auto-'), 'prompt must state the auto- prefix rule');
  assert.ok(prompt.includes('skills-archive'), 'prompt must state archive-instead-of-delete rule');
  assert.ok(prompt.includes('Nothing to save'), 'prompt must keep the no-op option');
});

test('self-review: long messages are truncated to digest_message_max_chars', () => {
  const dir = tempDir('transcript');
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'HEAD-' + 'y'.repeat(5000) + '-TAIL' } }) + '\n'
  );
  const stateFile = path.join(tempDir('state'), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ turn_count: 9 }));
  const configFile = writeConfig(tempDir('cfg'), { digest_message_max_chars: 100 });
  const res = runReview(file, { configFile, stateFile });
  const prompt = fs.readFileSync(JSON.parse(res.stdout).prompt_file, 'utf8');
  assert.ok(prompt.includes('HEAD-'));
  assert.ok(!prompt.includes('-TAIL'), 'over-limit tail must be truncated');
});

test('self-review: LIVERMORE_REVIEW=1 (spawned review session) neither counts nor fires', () => {
  const transcript = makeTranscript(4);
  const stateFile = path.join(tempDir('state'), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ turn_count: 9 }));
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runReview(transcript, { configFile, stateFile, env: { LIVERMORE_REVIEW: '1' } });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '');
  assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).turn_count, 9, 'counter must not move');
});

test('self-review: review_enabled=false disables everything', () => {
  const transcript = makeTranscript(4);
  const stateFile = path.join(tempDir('state'), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ turn_count: 9 }));
  const configFile = writeConfig(tempDir('cfg'), { review_enabled: false });
  const res = runReview(transcript, { configFile, stateFile });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '');
  assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).turn_count, 9);
});

test('self-review: missing transcript exits 0 without crashing', () => {
  const stateFile = path.join(tempDir('state'), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ turn_count: 9 }));
  const configFile = writeConfig(tempDir('cfg'), {});
  const res = runReview(path.join(workRoot, 'does-not-exist.jsonl'), { configFile, stateFile });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '');
});

console.log(`\n${testCount} tests passed`);
fs.rmSync(workRoot, { recursive: true, force: true });
