/**
 * Suggested rewrites of the SDK usage found (M53).
 *
 * Three closed, syntax-level rewrite rules, each tied to a fix pattern:
 *
 * - `RECONCILE_ON_UNKNOWN_COMMIT` (Reconcile through status): a `submitDepositTx` in a `try`
 *   whose error path never reads status. The `catch` stops being "give up" or "resubmit" and
 *   reconciles through `getExecutionStatus` of the same deposit address. When the `try` is the
 *   body of a retry loop the loop is removed: the submission is sent once.
 * - `SINGLE_ORDER` (No second order while the first is unanswered; one key per order): a second
 *   `getQuote` / `submitDepositTx` (and an order-key change) after the first submission in the
 *   same block. Those statements, and later statements that only exist to use them, are
 *   removed; the first order is reconciled through status instead.
 * - `UNBOUNDED_STATUS_POLL` (Reconcile through status): a status loop with a fixed read count
 *   keeps reading until its own terminal check exits it.
 *
 * The result is a suggestion: it is not applied, compiled, or run by RouteSpec. The caller
 * re-parses the patched text and reports syntax errors.
 */
import ts from 'typescript';
import type { FixPatternId } from './catalogue.ts';
import { applyEdits, editsDisjoint, type TextEdit } from './diff.ts';
import {
  ancestorsWithinFunction,
  enclosingFunction,
  enclosingTry,
  isFunctionLike,
  isLoop,
  isTypeScriptPath,
  type ParsedUsage,
} from './usage.ts';

export type RewriteRule = 'RECONCILE_ON_UNKNOWN_COMMIT' | 'SINGLE_ORDER' | 'UNBOUNDED_STATUS_POLL';

export const RULE_PATTERN: Readonly<Record<RewriteRule, FixPatternId>> = Object.freeze({
  RECONCILE_ON_UNKNOWN_COMMIT: 'RECONCILE_THROUGH_STATUS',
  SINGLE_ORDER: 'NO_SECOND_ORDER_WHILE_UNANSWERED',
  UNBOUNDED_STATUS_POLL: 'RECONCILE_THROUGH_STATUS',
});

export interface AppliedRewrite {
  readonly rule: RewriteRule;
  readonly pattern: FixPatternId;
  /** 1-based original line span the rule changed. */
  readonly startLine: number;
  readonly endLine: number;
  readonly note: string;
}

export interface RewriteResult {
  readonly edits: readonly TextEdit[];
  readonly applied: readonly AppliedRewrite[];
  readonly skipped: ReadonlyArray<{
    readonly rule: RewriteRule;
    readonly line: number;
    readonly reason: string;
  }>;
  readonly patched: string;
}

export const HELPER_NAME = 'reconcileThroughStatus';
const TERMINAL_NAME = 'RECONCILE_TERMINAL_STATUSES';

function helperText(typed: boolean, eol: string): string {
  const lines = typed
    ? [
        `const ${TERMINAL_NAME} = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);`,
        '',
        '/** Reconcile through status: read the status of the same deposit address until it is terminal. */',
        `async function ${HELPER_NAME}(`,
        '  service: { getExecutionStatus(depositAddress: string): Promise<{ status: string }> },',
        '  depositAddress: string,',
        '): Promise<string> {',
      ]
    : [
        `const ${TERMINAL_NAME} = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);`,
        '',
        '/** Reconcile through status: read the status of the same deposit address until it is terminal. */',
        `async function ${HELPER_NAME}(service, depositAddress) {`,
      ];
  lines.push(
    '  for (let attempt = 0; ; attempt++) {',
    '    try {',
    '      const { status } = await service.getExecutionStatus(depositAddress);',
    `      if (${TERMINAL_NAME}.has(status)) return status;`,
    '    } catch {',
    '      // A failed status read is not an outcome: keep reconciling.',
    '    }',
    '    await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 5_000)));',
    '  }',
    '}',
  );
  return lines.join(eol);
}

function indentOf(sf: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sf);
  const lineStart = sf.text.lastIndexOf('\n', start - 1) + 1;
  const prefix = sf.text.slice(lineStart, start);
  return /^[ \t]*$/.test(prefix) ? prefix : (/^[ \t]*/.exec(prefix)?.[0] ?? '');
}

function lineNo(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Remove `levels` characters of indentation from every line after the first. */
function dedent(text: string, levels: number): string {
  if (levels <= 0) return text;
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : l.replace(new RegExp(`^[ \\t]{0,${levels}}`), '')))
    .join('\n');
}

/**
 * The range of a statement as whole lines when it stands alone on them (with its leading
 * comments), otherwise its exact text range.
 */
function statementRange(sf: ts.SourceFile, node: ts.Node): { start: number; end: number } {
  const text = sf.text;
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  let start = node.getStart(sf);
  // Take the comments that sit on their own lines directly above the statement.
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] as ts.CommentRange;
    const gap = text.slice(c.end, start);
    const lineStart = text.lastIndexOf('\n', c.pos - 1) + 1;
    if ((gap.match(/\n/g) ?? []).length > 1 || !/^\s*$/.test(gap)) break;
    if (!/^[ \t]*$/.test(text.slice(lineStart, c.pos))) break;
    start = c.pos;
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const end = node.end;
  const nl = text.indexOf('\n', end);
  const lineEnd = nl === -1 ? text.length : nl + 1;
  const before = text.slice(lineStart, start);
  const after = text.slice(end, nl === -1 ? text.length : nl);
  if (/^[ \t]*$/.test(before) && /^[ \t]*\r?$/.test(after)) return { start: lineStart, end: lineEnd };
  return { start: node.getStart(sf), end };
}

function endsWithExit(block: ts.Block): boolean {
  const last = block.statements[block.statements.length - 1];
  return last !== undefined && (ts.isReturnStatement(last) || ts.isThrowStatement(last));
}

function depositArgument(sf: ts.SourceFile, call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const p of arg.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'depositAddress') return p.name.text;
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === 'depositAddress'
    ) {
      return p.initializer.getText(sf);
    }
  }
  return null;
}

function receiverText(sf: ts.SourceFile, call: ts.CallExpression): string {
  return (call.expression as ts.PropertyAccessExpression).expression.getText(sf);
}

function containsStatusCall(usage: ParsedUsage, node: ts.Node): boolean {
  return usage.callNodes.some(
    (c) => c.call.phase === 'STATUS' && c.node.getStart() >= node.getStart() && c.node.end <= node.end,
  );
}

/** The ancestor of `node` that is a direct statement of `block`. */
function statementIn(block: ts.Block, node: ts.Node): ts.Statement | null {
  let child: ts.Node = node;
  for (let n = node.parent; n; child = n, n = n.parent) {
    if (n === block) return child as ts.Statement;
    if (isFunctionLike(n)) return null;
  }
  return null;
}

function nearestBlock(node: ts.Node): ts.Block | null {
  for (let n = node.parent; n && !isFunctionLike(n); n = n.parent) if (ts.isBlock(n)) return n;
  return null;
}

function declaredNames(node: ts.Node): string[] {
  const out: string[] = [];
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) out.push(name.text);
    else for (const e of name.elements) if (!ts.isOmittedExpression(e)) bind(e.name);
  };
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) bind(d.name);
  return out;
}

/** True when `node` reads any identifier in `names` (property names are not reads). */
function references(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const p = n.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isVariableDeclaration(p) && p.name === n);
      if (!isPropertyName) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

interface Plan {
  edits: TextEdit[];
  applied: AppliedRewrite[];
  skipped: Array<{ rule: RewriteRule; line: number; reason: string }>;
  needsHelper: boolean;
}

function overlapsAny(range: { start: number; end: number }, edits: readonly TextEdit[]): boolean {
  return edits.some((e) => range.start < e.end && e.start < range.end);
}

function reconcileOnUnknownCommit(
  usage: ParsedUsage,
  plan: Plan,
  eol: string,
  taken: readonly TextEdit[],
): void {
  const sf = usage.sourceFile;
  const seen = new Set<ts.Node>();
  for (const { node, call } of usage.callNodes) {
    if (call.phase !== 'COMMIT') continue;
    const t = enclosingTry(node);
    if (!t || !t.catchClause || seen.has(t)) continue;
    seen.add(t);
    const loop = ancestorsWithinFunction(t).find(isLoop);
    const statusOnErrorPath =
      containsStatusCall(usage, t.catchClause) ||
      usage.callNodes.some(
        (s) =>
          s.call.phase === 'STATUS' &&
          s.node.getStart() >= (loop ?? t).end &&
          enclosingFunction(s.node) === enclosingFunction(node),
      );
    if (statusOnErrorPath) continue;
    const dep = depositArgument(sf, node);
    if (dep === null) {
      plan.skipped.push({
        rule: 'RECONCILE_ON_UNKNOWN_COMMIT',
        line: call.line,
        reason: 'DEPOSIT_ADDRESS_NOT_FOUND',
      });
      continue;
    }
    const svc = receiverText(sf, node);
    // Replace the whole retry loop when the try statement is its only statement.
    const loopBody = loop && ts.isBlock(loop.statement) ? loop.statement : null;
    const replaceLoop =
      loop !== undefined &&
      loopBody !== null &&
      loopBody.statements.length === 1 &&
      loopBody.statements[0] === t;
    const target: ts.Statement = replaceLoop ? (loop as ts.Statement) : t;
    const indent = indentOf(sf, target);
    const inner = `${indent}  `;
    const tryBlock = dedent(t.tryBlock.getText(sf), indentOf(sf, t).length - indent.length);
    const replacement = [
      `${indent}try ${tryBlock} catch {`,
      `${inner}// Outcome unknown: do not resubmit. Reconcile through status on the same deposit address.`,
      `${inner}const terminalStatus = await ${HELPER_NAME}(${svc}, ${dep});`,
      `${inner}return { result: 'RECONCILED', terminalStatus }; // adapt to this function's own result`,
      `${indent}}`,
    ].join(eol);
    const range = statementRange(sf, target);
    if (overlapsAny(range, taken)) continue;
    const wholeLines = range.start !== target.getStart(sf);
    plan.edits.push({
      start: range.start,
      end: range.end,
      text: wholeLines ? `${replacement}${eol}` : replacement.trimStart(),
    });
    let removedAfter = 0;
    const parent = target.parent;
    if (endsWithExit(t.tryBlock) && ts.isBlock(parent)) {
      const idx = parent.statements.indexOf(target);
      for (const s of parent.statements.slice(idx + 1)) {
        const r = statementRange(sf, s);
        plan.edits.push({ start: r.start, end: r.end, text: '' });
        removedAfter++;
      }
    }
    plan.needsHelper = true;
    plan.applied.push({
      rule: 'RECONCILE_ON_UNKNOWN_COMMIT',
      pattern: RULE_PATTERN.RECONCILE_ON_UNKNOWN_COMMIT,
      startLine: lineNo(sf, target.getStart(sf)),
      endLine: lineNo(sf, target.end),
      note: [
        replaceLoop
          ? 'The retry loop is removed: the deposit is submitted once.'
          : 'The deposit is submitted once.',
        'Its error path reconciles through status instead of giving up or resubmitting.',
        removedAfter > 0
          ? `${removedAfter} statement(s) after it are no longer reachable and are removed.`
          : '',
      ]
        .filter((s) => s.length > 0)
        .join(' '),
    });
  }
}

function singleOrder(usage: ParsedUsage, plan: Plan, eol: string): void {
  const sf = usage.sourceFile;
  const byFn = new Map<ts.Node | null, typeof usage.callNodes>();
  for (const c of usage.callNodes) {
    const fn = enclosingFunction(c.node);
    byFn.set(fn, [...(byFn.get(fn) ?? []), c]);
  }
  for (const [fn, calls] of byFn) {
    const commits = calls.filter((c) => c.call.phase === 'COMMIT');
    const first = commits[0];
    if (!first) continue;
    const later = [
      ...calls
        .filter((c) => c.node.getStart() > first.node.end && c.call.phase !== 'STATUS')
        .map((c) => c.node),
      ...usage.keyChangeNodes.filter((k) => enclosingFunction(k) === fn && k.getStart() > first.node.end),
    ].sort((a, b) => a.getStart() - b.getStart());
    const anchorNode = later[0];
    if (!anchorNode) continue;
    const block = nearestBlock(anchorNode);
    const statements = block ? later.map((n) => statementIn(block, n)) : [];
    if (!block || statements.some((s) => s === null)) {
      plan.skipped.push({
        rule: 'SINGLE_ORDER',
        line: lineNo(sf, anchorNode.getStart(sf)),
        reason: 'SECOND_ORDER_SPANS_BLOCKS',
      });
      continue;
    }
    const dep = depositArgument(sf, first.node);
    if (dep === null) {
      plan.skipped.push({ rule: 'SINGLE_ORDER', line: first.call.line, reason: 'DEPOSIT_ADDRESS_NOT_FOUND' });
      continue;
    }
    const removed = new Set<ts.Statement>(statements as ts.Statement[]);
    const declared = new Set<string>();
    for (const s of removed) for (const n of declaredNames(s)) declared.add(n);
    const anchor = statements[0] as ts.Statement;
    const idx = block.statements.indexOf(anchor);
    const pruned: TextEdit[] = [];
    let prunedReturn = false;
    for (const s of block.statements.slice(idx)) {
      if (removed.has(s)) continue;
      if (!references(s, declared)) continue;
      if (ts.isReturnStatement(s) && s.expression && ts.isObjectLiteralExpression(s.expression)) {
        const obj = s.expression;
        const drop = obj.properties.filter((p) => references(p, declared));
        const multiline = obj.getText(sf).includes('\n');
        const lastProp = obj.properties[obj.properties.length - 1];
        const ownLines =
          multiline &&
          obj.properties.every((p) => {
            const r = statementRange(sf, p);
            return r.start !== p.getStart(sf) || sf.text.slice(p.end, r.end).trim() === ',';
          });
        if (ownLines && lastProp) {
          // Remove each dropped property's own line and add terminalStatus as the last line.
          for (const p of drop) {
            const lineStart = sf.text.lastIndexOf('\n', p.getStart(sf) - 1) + 1;
            const nl = sf.text.indexOf('\n', p.end);
            pruned.push({ start: lineStart, end: nl === -1 ? sf.text.length : nl + 1, text: '' });
          }
          const close = obj.end - 1;
          const closeLineStart = sf.text.lastIndexOf('\n', close - 1) + 1;
          const lastHasComma = sf.text.slice(lastProp.end, close).trim().startsWith(',');
          const propIndent = indentOf(sf, lastProp);
          const comma =
            !lastHasComma && !drop.includes(lastProp)
              ? { start: lastProp.end, end: lastProp.end, text: ',' }
              : null;
          if (comma) pruned.push(comma);
          pruned.push({
            start: closeLineStart,
            end: closeLineStart,
            text: `${propIndent}terminalStatus,${eol}`,
          });
        } else {
          const keep = obj.properties.filter((p) => !drop.includes(p));
          const items = [...keep.map((p) => p.getText(sf)), 'terminalStatus'];
          pruned.push({ start: obj.getStart(sf), end: obj.end, text: `{ ${items.join(', ')} }` });
        }
        prunedReturn = true;
        continue;
      }
      removed.add(s);
      for (const n of declaredNames(s)) declared.add(n);
    }
    const indent = indentOf(sf, anchor);
    const insert = [
      `${indent}// One order per intent: never place a second order while the first is unanswered.`,
      `${indent}// Reconcile the first order through status on its own deposit address instead.`,
      `${indent}const terminalStatus = await ${HELPER_NAME}(${receiverText(sf, first.node)}, ${dep});`,
    ].join(eol);
    for (const s of removed) {
      const r = statementRange(sf, s);
      plan.edits.push({ start: r.start, end: r.end, text: s === anchor ? `${insert}${eol}` : '' });
    }
    plan.edits.push(...pruned);
    plan.needsHelper = true;
    const lines = [...removed].map((s) => lineNo(sf, s.getStart(sf)));
    plan.applied.push({
      rule: 'SINGLE_ORDER',
      pattern: RULE_PATTERN.SINGLE_ORDER,
      startLine: Math.min(...lines),
      endLine: Math.max(...[...removed].map((s) => lineNo(sf, s.end))),
      note: [
        `${removed.size} statement(s) that place or use a second order are removed;`,
        'the first order is reconciled through status on its own deposit address.',
        prunedReturn
          ? 'The returned object no longer carries the second order and gains terminalStatus.'
          : '',
      ]
        .filter((x) => x.length > 0)
        .join(' '),
    });
  }
}

function unboundedStatusPoll(usage: ParsedUsage, plan: Plan): void {
  const sf = usage.sourceFile;
  const seen = new Set<ts.Node>();
  for (const { node, call } of usage.callNodes) {
    if (call.phase !== 'STATUS') continue;
    const loop = ancestorsWithinFunction(node).find(isLoop);
    if (!loop || !ts.isForStatement(loop) || loop.condition === undefined || seen.has(loop)) continue;
    seen.add(loop);
    let exits = false;
    const visit = (n: ts.Node): void => {
      if (exits || isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) || (ts.isBreakStatement(n) && n.label === undefined)) exits = true;
      ts.forEachChild(n, visit);
    };
    visit(loop.statement);
    if (!exits) {
      plan.skipped.push({
        rule: 'UNBOUNDED_STATUS_POLL',
        line: lineNo(sf, loop.getStart(sf)),
        reason: 'NO_TERMINAL_EXIT',
      });
      continue;
    }
    // `for (init; cond; incr)` -> `for (init; ; incr)`
    plan.edits.push({ start: loop.condition.getStart(sf), end: loop.condition.end, text: '' });
    plan.applied.push({
      rule: 'UNBOUNDED_STATUS_POLL',
      pattern: RULE_PATTERN.UNBOUNDED_STATUS_POLL,
      startLine: lineNo(sf, loop.getStart(sf)),
      endLine: lineNo(sf, loop.getStart(sf)),
      note: 'The read-count bound is removed: the loop reads status until its own terminal check exits it. Add a back-off between reads.',
    });
  }
}

function helperInsertion(sf: ts.SourceFile, path: string, eol: string): TextEdit {
  const imports = sf.statements.filter((s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s));
  const last = imports[imports.length - 1];
  const text = helperText(isTypeScriptPath(path), eol);
  if (last) {
    const nl = sf.text.indexOf('\n', last.end);
    const at = nl === -1 ? sf.text.length : nl + 1;
    return { start: at, end: at, text: `${eol}${text}${eol}` };
  }
  const first = sf.statements[0];
  const at = first ? statementRange(sf, first).start : sf.text.length;
  return { start: at, end: at, text: `${text}${eol}${eol}` };
}

/** Apply the rewrite rules for the requested patterns to one parsed source. */
export function rewriteForPatterns(
  usage: ParsedUsage,
  patterns: ReadonlySet<FixPatternId>,
  rules: ReadonlySet<RewriteRule>,
): RewriteResult {
  const sf = usage.sourceFile;
  const eol = sf.text.includes('\r\n') ? '\r\n' : '\n';
  const plan: Plan = { edits: [], applied: [], skipped: [], needsHelper: false };
  if (rules.has('SINGLE_ORDER') && patterns.has('NO_SECOND_ORDER_WHILE_UNANSWERED'))
    singleOrder(usage, plan, eol);
  if (rules.has('RECONCILE_ON_UNKNOWN_COMMIT') && patterns.has('RECONCILE_THROUGH_STATUS')) {
    const before = plan.edits.length;
    const probe: Plan = { edits: [], applied: [], skipped: [], needsHelper: false };
    reconcileOnUnknownCommit(usage, probe, eol, plan.edits);
    if (editsDisjoint([...plan.edits.slice(0, before), ...probe.edits])) {
      plan.edits.push(...probe.edits);
      plan.applied.push(...probe.applied);
      plan.skipped.push(...probe.skipped);
      plan.needsHelper ||= probe.needsHelper;
    } else {
      for (const a of probe.applied)
        plan.skipped.push({ rule: a.rule, line: a.startLine, reason: 'OVERLAPS_EARLIER_REWRITE' });
    }
  }
  if (rules.has('UNBOUNDED_STATUS_POLL') && patterns.has('RECONCILE_THROUGH_STATUS')) {
    const probe: Plan = { edits: [], applied: [], skipped: [], needsHelper: false };
    unboundedStatusPoll(usage, probe);
    if (editsDisjoint([...plan.edits, ...probe.edits])) {
      plan.edits.push(...probe.edits);
      plan.applied.push(...probe.applied);
      plan.skipped.push(...probe.skipped);
    } else {
      for (const a of probe.applied)
        plan.skipped.push({ rule: a.rule, line: a.startLine, reason: 'OVERLAPS_EARLIER_REWRITE' });
    }
  }
  const alreadyHasHelper = sf.statements.some(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === HELPER_NAME,
  );
  if (plan.needsHelper && !alreadyHasHelper) plan.edits.push(helperInsertion(sf, usage.path, eol));
  const edits = plan.edits;
  return {
    edits,
    applied: plan.applied,
    skipped: plan.skipped,
    patched: edits.length === 0 ? sf.text : applyEdits(sf.text, edits),
  };
}
