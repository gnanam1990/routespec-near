#!/usr/bin/env node
// Repository secret scan: checks every tracked and untracked-but-not-ignored file for
// high-confidence secret patterns. Prints only file paths, line numbers, and rule names —
// never the matched value. Exit 0 = clean, 1 = findings, 2 = scan error.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  [
    'generic-assigned-secret',
    /\b(?:api[_-]?key|secret|password|jwt)\b\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{24,}['"]/i,
  ],
];

let files;
try {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  files = out.split('\0').filter(Boolean);
} catch (error) {
  console.error('secret-scan: unable to list files:', error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const findings = [];
for (const file of files) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    continue; // deleted in working tree
  }
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
  const buf = readFileSync(file);
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [name, pattern] of RULES) {
      if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${name}`);
    }
  });
}

if (findings.length > 0) {
  console.error(`secret-scan: ${findings.length} finding(s) (values withheld):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`secret-scan: clean (${files.length} files scanned, ${RULES.length} rules)`);
