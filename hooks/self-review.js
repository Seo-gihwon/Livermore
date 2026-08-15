#!/usr/bin/env node
'use strict';
// Stop hook: Hermes-style background self-improvement review.
//
// Counts turns globally (across sessions) in .state.json. Every
// `review_interval` turns it extracts a digest of the last N messages from the
// transcript and launches `claude -p` in the background (detached) to review
// the conversation and save reusable knowledge as auto skills. The hook itself
// always exits 0 immediately so the main session is never blocked.
//
// Recursion guard: the spawned review session inherits LIVERMORE_REVIEW=1, so
// its own Stop hook exits before counting anything.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, loadState, saveState, readStdinJson } = require('./lib');

const TAIL_READ_BYTES = 256 * 1024; // never re-read a huge transcript in full

function extractDigest(transcriptPath, maxMessages, maxChars) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch (_err) {
    return [];
  }
  let text;
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
  } finally {
    fs.closeSync(fd);
  }

  const messages = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_err) {
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isMeta) continue;
    const content = entry.message && entry.message.content;
    let msgText = '';
    if (typeof content === 'string') {
      msgText = content;
    } else if (Array.isArray(content)) {
      msgText = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
    }
    msgText = msgText.trim();
    if (!msgText) continue; // skip tool-only turns
    messages.push({ role: entry.type, text: msgText.slice(0, maxChars) });
  }
  return messages.slice(-maxMessages);
}

function buildPrompt(digest) {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  const archiveDir = path.join(os.homedir(), '.claude', 'skills-archive');
  const digestText = digest.map((m) => `[${m.role}]\n${m.text}`).join('\n\n');

  return `You are running a background self-improvement review of a recent Claude Code conversation.

## Goal
Find procedures, corrections, and solutions from this conversation that are worth reusing, and save them as skills. Most sessions leave at least one small update behind. A pass that saves nothing is not neutral — it is a lost learning opportunity.

## Decision procedure — follow it in order, do not skip to the end
Step 1. Check the digest against each action signal below.
Step 2. If ANY action signal is present, you MUST create or patch a skill. "Nothing to save" is NOT available to you in that case. Your job then is to decide WHAT to write, not WHETHER to write.
Step 3. Only if NO action signal is present may you reply "Nothing to save".

## Action signals
- The user corrected your style, workflow, or tool choice — including a preference they had to repeat. A stated preference is class-level by definition: it applies to every future session, so never dismiss it as "just project configuration".
- A non-obvious technique, workaround, root cause, or debugging path was used. If it took more than one attempt to get right, it counts.
- An existing auto skill turned out to be wrong or incomplete during this session.

## Priorities
- Prefer PATCHING an existing auto skill over creating a new one.
- Skills must be class-level (a broad recurring topic), never a narrative of this one session. One skill per session is forbidden as a pattern. When the specific instance is too narrow, generalize it — do not discard it.

## Never save
These constrain WHAT you write. They are not grounds for writing nothing when an action signal is present — generalize past them instead.
- Environment-dependent failures (missing binary, unset credential).
- Negative claims about tools or features ("X does not work") — they keep blocking you for months after the problem is fixed.
- Session-specific transient errors.
- One-off task narratives.
- Unresolved failures written up as if they were verified workflows.

## Hard rules (violating any of these is worse than doing nothing)
1. You may create or edit files ONLY under: ${skillsDir}${path.sep}auto-<skill-name>${path.sep} — the directory name MUST start with "auto-". Never touch any other skill, plugin, memory, or file. Human-authored skills are strictly off limits.
2. Before patching an existing auto skill, READ its current SKILL.md first.
3. Never delete anything. To retire a skill, MOVE its directory to ${archiveDir}${path.sep} instead.
4. If an auto skill directory with the same name already exists, do not create a duplicate — patch the existing one.
5. Each skill is a directory containing a SKILL.md with YAML frontmatter in exactly this shape:
---
name: auto-<kebab-case, whole name max 64 chars>
description: <what it does AND when to use it, max 500 chars>
---
<markdown body with the actual instructions>

## Conversation digest (last ${digest.length} messages, each truncated)
${digestText}

Review the digest and act now. If there is genuinely nothing worth saving, reply "Nothing to save" and stop.
`;
}

function main() {
  // Recursion guard: never review a review session.
  if (process.env.LIVERMORE_REVIEW === '1') return 0;

  const config = loadConfig();
  if (!config.review_enabled) return 0;

  const event = readStdinJson();
  if (!event || !event.transcript_path) return 0;

  const state = loadState();
  state.turn_count = (state.turn_count || 0) + 1;
  saveState(state);

  const interval = Math.max(1, config.review_interval | 0);
  if (state.turn_count % interval !== 0) return 0;

  const digest = extractDigest(
    event.transcript_path,
    config.digest_message_count,
    config.digest_message_max_chars
  );
  if (digest.length === 0) return 0;

  const prompt = buildPrompt(digest);
  const promptFile = path.join(os.tmpdir(), `livermore-review-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(promptFile, prompt);

  // Prompt goes in via stdin (fd redirect) — argv would hit the ~32K command
  // line limit on Windows.
  if (process.env.LIVERMORE_DRYRUN === '1') {
    process.stdout.write(
      JSON.stringify({
        dryrun: true,
        command: config.claude_command,
        args: reviewArgs(config),
        prompt_file: promptFile
      })
    );
    return 0;
  }

  launchReview(config, promptFile);
  return 0;
}

function launchReview(config, promptFile) {
  if (process.platform === 'win32') {
    // Windows: a detached claude dies immediately (cmd.exe/claude exits 1
    // without a console), and a non-detached claude is killed by libuv's
    // kill-on-close job when this hook exits. A plain detached node process
    // survives both, so relaunch this script as a hidden keeper that spawns
    // claude non-detached and stays alive until the review finishes.
    // (Verified on a real Windows 11 machine — see PR notes.)
    const child = spawn(process.execPath, [__filename, '--spawn', promptFile], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', () => {}); // background launch is best-effort
    child.unref();
    return;
  }

  const promptFd = fs.openSync(promptFile, 'r');
  try {
    const child = spawn(config.claude_command, reviewArgs(config), {
      detached: true,
      stdio: [promptFd, 'ignore', 'ignore'],
      env: Object.assign({}, process.env, { LIVERMORE_REVIEW: '1' })
    });
    child.on('error', () => {}); // background launch is best-effort
    child.unref();
  } finally {
    fs.closeSync(promptFd);
  }
}

function reviewArgs(config) {
  // Comma-separated --allowedTools: Windows spawns claude via shell:true,
  // which does not re-quote args, so no spaces allowed inside one arg.
  return ['-p', '--model', config.review_model, '--allowedTools', 'Read,Glob,Grep,Write,Edit'];
}

// Windows keeper mode: runs detached from the hook, parents the review
// process for its whole lifetime (a `claude` .cmd shim needs shell:true —
// cmd.exe, NOT PowerShell — Cylance-safe).
function spawnMode(promptFile) {
  const config = loadConfig();
  const promptFd = fs.openSync(promptFile, 'r');
  const child = spawn(config.claude_command, reviewArgs(config), {
    stdio: [promptFd, 'ignore', 'ignore'],
    env: Object.assign({}, process.env, { LIVERMORE_REVIEW: '1' }),
    windowsHide: true,
    shell: true
  });
  child.on('error', () => process.exit(1));
  child.on('close', () => process.exit(0));
}

if (process.argv[2] === '--spawn' && process.argv[3]) {
  spawnMode(process.argv[3]);
} else {
  process.exit(main());
}
