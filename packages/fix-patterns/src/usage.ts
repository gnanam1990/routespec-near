/**
 * SDK usage found in a subject source file (M53).
 *
 * The source is parsed with the TypeScript compiler (syntax only; nothing is executed or
 * type-checked). Every call to the three official 1Click SDK service methods is recorded with
 * its real line and column, and a small closed set of code shapes is derived from those call
 * sites. A shape is a fact about the source text, not a verdict: only the invariant kernel judges
 * behaviour, and a shape is shown only when a violated invariant links to its pattern.
 */
import ts from 'typescript';
import type { FixPatternId } from './catalogue.ts';

export const SDK_METHODS = Object.freeze({
  getQuote: 'QUOTE',
  submitDepositTx: 'COMMIT',
  getExecutionStatus: 'STATUS',
} as const);

export type SdkMethod = keyof typeof SDK_METHODS;
export type SdkPhase = (typeof SDK_METHODS)[SdkMethod];

export type UsageShape =
  | 'COMMIT_RETRIED_IN_LOOP'
  | 'REPEATED_COMMIT_CALL'
  | 'REPEATED_QUOTE_CALL'
  | 'ORDER_KEY_CHANGED'
  | 'NO_STATUS_READ'
  | 'STATUS_NOT_READ_AFTER_COMMIT_ERROR'
  | 'STATUS_POLL_BOUNDED';

/** Which patterns a shape is evidence for. */
export const SHAPE_PATTERNS: Readonly<Record<UsageShape, readonly FixPatternId[]>> = Object.freeze({
  COMMIT_RETRIED_IN_LOOP: ['RECONCILE_THROUGH_STATUS', 'IDEMPOTENCY_KEY', 'NO_SECOND_ORDER_WHILE_UNANSWERED'],
  REPEATED_COMMIT_CALL: ['NO_SECOND_ORDER_WHILE_UNANSWERED', 'IDEMPOTENCY_KEY'],
  REPEATED_QUOTE_CALL: ['NO_SECOND_ORDER_WHILE_UNANSWERED', 'IDEMPOTENCY_KEY'],
  ORDER_KEY_CHANGED: ['IDEMPOTENCY_KEY', 'NO_SECOND_ORDER_WHILE_UNANSWERED'],
  NO_STATUS_READ: ['RECONCILE_THROUGH_STATUS'],
  STATUS_NOT_READ_AFTER_COMMIT_ERROR: ['RECONCILE_THROUGH_STATUS'],
  STATUS_POLL_BOUNDED: ['RECONCILE_THROUGH_STATUS'],
});

export const SHAPE_TEXT: Readonly<Record<UsageShape, string>> = Object.freeze({
  COMMIT_RETRIED_IN_LOOP: 'submitDepositTx is called inside a loop: an unanswered submission is resubmitted.',
  REPEATED_COMMIT_CALL:
    'A second submitDepositTx call site in the same function: a second deposit for one intent.',
  REPEATED_QUOTE_CALL:
    'A second getQuote call site after a deposit submission: a fresh quote for the same intent.',
  ORDER_KEY_CHANGED: 'The order key is changed after the first deposit submission.',
  NO_STATUS_READ: 'This function submits a deposit but never calls getExecutionStatus.',
  STATUS_NOT_READ_AFTER_COMMIT_ERROR:
    'When submitDepositTx throws, no getExecutionStatus call is reached: the unknown outcome is never reconciled.',
  STATUS_POLL_BOUNDED:
    'The status loop stops after a fixed number of reads, whether or not a terminal status arrived.',
});

export interface SdkCall {
  readonly method: SdkMethod;
  readonly phase: SdkPhase;
  /** 1-based line and column of the method name. */
  readonly line: number;
  readonly column: number;
  /** Source text of the receiver, e.g. `ctx.sdk.OneClickService`. */
  readonly receiver: string;
  /** Source text of the whole call, bounded. */
  readonly text: string;
  readonly functionName: string | null;
  readonly inLoop: boolean;
  readonly inTry: boolean;
  readonly inCatch: boolean;
}

export interface ShapeFinding {
  readonly shape: UsageShape;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly functionName: string | null;
}

export interface SdkUsage {
  readonly path: string;
  readonly calls: readonly SdkCall[];
  readonly shapes: readonly ShapeFinding[];
  readonly parseErrors: number;
}

/** Internal view kept for the rewriter: nodes of one parse. */
export interface ParsedUsage extends SdkUsage {
  readonly sourceFile: ts.SourceFile;
  readonly callNodes: ReadonlyArray<{ readonly call: SdkCall; readonly node: ts.CallExpression }>;
  readonly keyChangeNodes: readonly ts.CallExpression[];
}

const MAX_TEXT = 200;

export function scriptKindFor(path: string): ts.ScriptKind {
  const p = path.toLowerCase();
  if (p.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (p.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function isTypeScriptPath(path: string): boolean {
  const k = scriptKindFor(path);
  return k === ts.ScriptKind.TS || k === ts.ScriptKind.TSX;
}

export function parseSource(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
}

export function parseErrorCount(sf: ts.SourceFile): number {
  return (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0;
}

function bounded(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
}

export function isFunctionLike(node: ts.Node): node is ts.SignatureDeclaration & ts.Node {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

export function isLoop(node: ts.Node): node is ts.IterationStatement {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

export function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let n = node.parent; n; n = n.parent) if (isFunctionLike(n)) return n;
  return null;
}

function functionName(fn: ts.Node | null): string | null {
  if (fn === null) return null;
  const named = (fn as { name?: ts.Node }).name;
  if (named && ts.isIdentifier(named)) return named.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

function position(sf: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

/** Ancestors of `node` up to (not including) its enclosing function. */
export function ancestorsWithinFunction(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  for (let n = node.parent; n && !isFunctionLike(n); n = n.parent) out.push(n);
  return out;
}

/** Nearest try statement whose try block contains `node` (within the same function). */
export function enclosingTry(node: ts.Node): ts.TryStatement | null {
  let child: ts.Node = node;
  for (let n = node.parent; n && !isFunctionLike(n); child = n, n = n.parent) {
    if (ts.isTryStatement(n) && n.tryBlock === child) return n;
  }
  return null;
}

function sdkMethodOf(
  node: ts.CallExpression,
): { method: SdkMethod; access: ts.PropertyAccessExpression } | null {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const name = callee.name.text;
  if (!Object.hasOwn(SDK_METHODS, name)) return null;
  return { method: name as SdkMethod, access: callee };
}

function isKeyChange(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'setLogicalJob';
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return inner.getStart() >= outer.getStart() && inner.end <= outer.end;
}

/** Scan one source file for official 1Click SDK service calls and the derived shapes. */
export function scanSdkUsageParsed(path: string, text: string): ParsedUsage {
  const sf = parseSource(path, text);
  const callNodes: Array<{ call: SdkCall; node: ts.CallExpression }> = [];
  const keyChangeNodes: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const m = sdkMethodOf(node);
      if (m) {
        const fn = enclosingFunction(node);
        const ancestors = ancestorsWithinFunction(node);
        const at = position(sf, m.access.name.getStart(sf));
        callNodes.push({
          node,
          call: {
            method: m.method,
            phase: SDK_METHODS[m.method],
            line: at.line,
            column: at.column,
            receiver: bounded(m.access.expression.getText(sf)),
            text: bounded(node.getText(sf)),
            functionName: functionName(fn),
            inLoop: ancestors.some(isLoop),
            inTry: enclosingTry(node) !== null,
            inCatch: ancestors.some((a) => ts.isCatchClause(a)),
          },
        });
      } else if (isKeyChange(node)) keyChangeNodes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Local functions that read status (for example a reconcile helper): a call to one of them
  // reaches getExecutionStatus too.
  const helperNames = new Set<string>();
  for (const c of callNodes) {
    if (c.call.phase !== 'STATUS') continue;
    const name = functionName(enclosingFunction(c.node));
    if (name !== null) helperNames.add(name);
  }
  const statusReaches: ts.Node[] = callNodes.filter((c) => c.call.phase === 'STATUS').map((c) => c.node);
  const visitHelpers = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      helperNames.has(node.expression.text)
    ) {
      statusReaches.push(node);
    }
    ts.forEachChild(node, visitHelpers);
  };
  visitHelpers(sf);

  const shapes: ShapeFinding[] = [];
  const add = (shape: UsageShape, node: ts.Node, fn: ts.Node | null): void => {
    const at = position(sf, node.getStart(sf));
    shapes.push({ shape, ...at, text: bounded(node.getText(sf)), functionName: functionName(fn) });
  };
  const byFunction = new Map<ts.Node | null, Array<{ call: SdkCall; node: ts.CallExpression }>>();
  for (const c of callNodes) {
    const fn = enclosingFunction(c.node);
    byFunction.set(fn, [...(byFunction.get(fn) ?? []), c]);
  }
  for (const [fn, calls] of byFunction) {
    const commits = calls.filter((c) => c.call.phase === 'COMMIT');
    const quotes = calls.filter((c) => c.call.phase === 'QUOTE');
    const statuses = calls.filter((c) => c.call.phase === 'STATUS');
    const reaches = statusReaches.filter((n) => enclosingFunction(n) === fn);
    for (const c of commits) if (c.call.inLoop) add('COMMIT_RETRIED_IN_LOOP', c.node, fn);
    for (const c of commits.slice(1)) add('REPEATED_COMMIT_CALL', c.node, fn);
    const firstCommit = commits[0];
    if (firstCommit) {
      for (const q of quotes) {
        if (q.node.getStart() > firstCommit.node.end) add('REPEATED_QUOTE_CALL', q.node, fn);
      }
      for (const k of keyChangeNodes) {
        if (enclosingFunction(k) === fn && k.getStart() > firstCommit.node.end)
          add('ORDER_KEY_CHANGED', k, fn);
      }
      if (reaches.length === 0) add('NO_STATUS_READ', firstCommit.node, fn);
      else {
        for (const c of commits) {
          const t = enclosingTry(c.node);
          if (!t || !t.catchClause) continue;
          const loop = ancestorsWithinFunction(t).find(isLoop);
          const after = loop ?? t;
          const reached = reaches.some(
            (s) => contains(t.catchClause as ts.CatchClause, s) || s.getStart() >= after.end,
          );
          if (!reached) add('STATUS_NOT_READ_AFTER_COMMIT_ERROR', t.catchClause, fn);
        }
      }
    }
    for (const s of statuses) {
      const loop = ancestorsWithinFunction(s.node).find(isLoop);
      if (loop && ts.isForStatement(loop) && loop.condition !== undefined)
        add('STATUS_POLL_BOUNDED', loop, fn);
    }
  }
  const order = (a: ShapeFinding, b: ShapeFinding) =>
    a.line - b.line || a.column - b.column || (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0);
  const uniq = new Map<string, ShapeFinding>();
  for (const s of shapes.sort(order)) uniq.set(`${s.shape}:${s.line}:${s.column}`, s);
  return {
    path,
    calls: callNodes.map((c) => c.call),
    shapes: [...uniq.values()],
    parseErrors: parseErrorCount(sf),
    sourceFile: sf,
    callNodes,
    keyChangeNodes,
  };
}

export function scanSdkUsage(path: string, text: string): SdkUsage {
  const p = scanSdkUsageParsed(path, text);
  return { path: p.path, calls: p.calls, shapes: p.shapes, parseErrors: p.parseErrors };
}
