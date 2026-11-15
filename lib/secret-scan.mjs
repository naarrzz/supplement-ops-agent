#!/usr/bin/env node
// Scans files that would be committed for secrets, real deployment URLs, n8n credential IDs,
// and any word listed in the gitignored .forbidden-words file (one per line, case-insensitive).
// Runs as a test and as a git pre-commit hook. Exit code 1 if anything is found.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = [
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Google OAuth token', /ya29\.[0-9A-Za-z_-]{20,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[0-9A-Za-z]{30,}/],
  ['Real Apps Script deployment URL', /script\.google\.com\/macros\/s\/(?!YOUR_DEPLOYMENT_ID)[A-Za-z0-9_-]{20,}/],
  ['Token value in env file', /^OPS_TOKEN=(?!paste-the-same-token)\S+/m],
  ['n8n credential reference', /"credentials"\s*:\s*\{\s*"\w+"\s*:\s*\{\s*"id"/],
];

export function filesToScan() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter((f) => f && !f.endsWith('package-lock.json'));
}

export function scan(files = filesToScan()) {
  const forbiddenPath = join(ROOT, '.forbidden-words');
  const forbidden = existsSync(forbiddenPath)
    ? readFileSync(forbiddenPath, 'utf8').split('\n').map((w) => w.trim()).filter(Boolean)
    : [];
  const findings = [];
  for (const f of files) {
    const path = join(ROOT, f);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const [label, re] of PATTERNS) if (re.test(text)) findings.push(`${f}: ${label}`);
    for (const w of forbidden) {
      // whole words only, so a longer ordinary word that merely starts with a listed word is not a hit
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}\\b`, 'i');
      if (re.test(text)) findings.push(`${f}: forbidden word from .forbidden-words`);
    }
  }
  return { findings, forbiddenWords: forbidden.length, files: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = scan();
  if (r.findings.length) {
    console.error('Secret scan FAILED:\n' + r.findings.map((x) => '  ' + x).join('\n'));
    process.exit(1);
  }
  console.log(`Secret scan clean: ${r.files} files, ${r.forbiddenWords} forbidden words checked.`);
}
