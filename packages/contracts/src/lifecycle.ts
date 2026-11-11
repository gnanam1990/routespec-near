/**
 * The single shared ExecutionLifecycle state machine (DATA-MODEL.md section 4).
 *
 * GateRun, CaseRun, and session rows all use the same lifecycle enum; verdict is a separate
 * field and is never a lifecycle value. Terminal lifecycle states are immutable.
 */
import type { ExecutionLifecycle } from './enums.ts';
import { RouteSpecError } from './errors.ts';

export type LifecycleSubject = 'GATE_RUN' | 'CASE_RUN' | 'SESSION';

export const TERMINAL_LIFECYCLES: readonly ExecutionLifecycle[] = Object.freeze([
  'COMPLETED',
  'ABORTED',
  'ERROR',
]);

type Table = Readonly<Partial<Record<ExecutionLifecycle, readonly ExecutionLifecycle[]>>>;

const EXECUTION_CORE: Table = {
  READY: ['RUNNING', 'ABORTED', 'ERROR'],
  RUNNING: ['EVALUATING', 'RECOVERY_REQUIRED', 'ABORTED', 'ERROR'],
  RECOVERY_REQUIRED: ['RUNNING', 'EVALUATING', 'ABORTED', 'ERROR'],
  EVALUATING: ['COMPLETED', 'ERROR', 'RECOVERY_REQUIRED'],
};

export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleSubject, Table>> = Object.freeze({
  GATE_RUN: {
    DRAFT: ['VALIDATING', 'ABORTED', 'ERROR'],
    VALIDATING: ['READY', 'ABORTED', 'ERROR'],
    ...EXECUTION_CORE,
  },
  CASE_RUN: {
    PENDING: ['VALIDATING', 'ABORTED', 'ERROR'],
    VALIDATING: ['READY', 'ABORTED', 'ERROR'],
    ...EXECUTION_CORE,
  },
  SESSION: {
    ...EXECUTION_CORE,
  },
});

export const INITIAL_LIFECYCLE: Readonly<Record<LifecycleSubject, ExecutionLifecycle>> = Object.freeze({
  GATE_RUN: 'DRAFT',
  CASE_RUN: 'PENDING',
  SESSION: 'READY',
});

export function isTerminalLifecycle(state: ExecutionLifecycle): boolean {
  return TERMINAL_LIFECYCLES.includes(state);
}

export function canTransition(
  subject: LifecycleSubject,
  from: ExecutionLifecycle,
  to: ExecutionLifecycle,
): boolean {
  return (LIFECYCLE_TRANSITIONS[subject][from] ?? []).includes(to);
}

export function assertTransition(
  subject: LifecycleSubject,
  from: ExecutionLifecycle,
  to: ExecutionLifecycle,
): void {
  if (isTerminalLifecycle(from)) {
    throw new RouteSpecError('RS_TERMINAL_IMMUTABLE', 'Terminal lifecycle state is immutable.', {
      details: { subject, from, to },
    });
  }
  if (!canTransition(subject, from, to)) {
    throw new RouteSpecError('RS_LIFECYCLE_TRANSITION_INVALID', 'Lifecycle transition is not allowed.', {
      details: { subject, from, to },
    });
  }
}

/** All allowed (from, to) pairs, used by persistence triggers and tests. */
export function allowedTransitions(
  subject: LifecycleSubject,
): Array<[ExecutionLifecycle, ExecutionLifecycle]> {
  const out: Array<[ExecutionLifecycle, ExecutionLifecycle]> = [];
  for (const [from, tos] of Object.entries(LIFECYCLE_TRANSITIONS[subject])) {
    for (const to of tos ?? []) out.push([from as ExecutionLifecycle, to]);
  }
  return out;
}
