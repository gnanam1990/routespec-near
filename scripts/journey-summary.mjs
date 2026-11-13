#!/usr/bin/env node
// Prints a short, human-readable summary of a delivery journey record written by
// `pnpm run delivery:journey -- --work <dir> --out <file.json>`. Read-only: it only reads the
// JSON file it is given and prints plain text. Exit 0 = printed, 2 = usage or read error.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: node scripts/journey-summary.mjs <journey.json>\n');
  process.exit(2);
}

let j;
try {
  j = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  process.stderr.write(`journey-summary: cannot read ${file}: ${String(error)}\n`);
  process.exit(2);
}

const out = [];
const line = (s = '') => out.push(s);
const inv = (c, id) => c.invariants?.find((i) => i.invariantId === id)?.status ?? '-';

line(`journey     ${j.schema} on ${j.platform}, node ${j.node}, commit ${String(j.commit).slice(0, 12)}`);
line(`containment ${j.containment?.mode ?? 'UNKNOWN'}`);
line();

const runs = [
  ['baselineRun', 'baseline client, release corpus'],
  ['baselineOnPromoted', 'baseline client, promoted corpus'],
  ['correctedRun', 'corrected client, promoted corpus'],
];
for (const [key, title] of runs) {
  const r = j[key];
  if (r === undefined) continue;
  line(`${title}: gate decision ${r.decision}`);
  for (const c of r.cases ?? []) {
    const outcome = c.jobOutcome?.result ?? '-';
    const attempts = (c.jobOutcome?.attempts ?? []).map((a) => `${a.status} ${a.code}`).join(', ');
    line(
      `  case ${c.ordinal} ${c.scenarioName}: client ${outcome}` +
        `${attempts === '' ? '' : ` (resubmissions answered: ${attempts})`}` +
        ` | INV-03 ${inv(c, 'INV-03')} | INV-04 ${inv(c, 'INV-04')}` +
        ` | effect coverage ${c.effectCoverage?.basis ?? '-'} | case verdict ${c.verdict}`,
    );
  }
  line();
}

const reg = j.regression ?? {};
if (reg.promotionRefusal !== undefined && reg.promotionRefusal !== null) {
  line(
    `capture as release evidence: refused ${reg.promotionRefusal.status} ${reg.promotionRefusal.code}` +
      ` (${(reg.promotionRefusal.reasons ?? []).join(', ')})`,
  );
} else if (reg.releaseEvidence !== undefined && reg.releaseEvidence !== null) {
  line(`capture as release evidence: ${reg.releaseEvidence.releaseEvidence ? 'accepted' : 'refused'}`);
}
if (reg.promotion !== undefined && reg.promotion !== null) line(`promoted as ${reg.promotion.evidenceUse}`);
if (reg.finalRegressionStatus !== undefined) line(`regression status ${reg.finalRegressionStatus}`);
if (j.bundleVerify !== undefined) line(`evidence bundle verified offline: ${j.bundleVerify.verified}`);
const rp = j.recoveryProof;
if (rp?.recover !== undefined) {
  line(
    `crash recovery: epoch ${rp.recover.previousEpoch} -> ${rp.recover.fencingEpoch},` +
      ` stale token ${rp.staleExecutionTokenCommit?.error?.code ?? '-'},` +
      ` second mutation ${rp.secondMutationUnderReconciliationToken?.error?.code ?? '-'}`,
  );
}

process.stdout.write(`${out.join('\n')}\n`);
