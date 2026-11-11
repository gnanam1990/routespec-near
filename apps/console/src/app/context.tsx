import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '../api/errors.ts';
import type { ConnectionState, ControlClient, MutationResult } from '../api/client.ts';

interface ConsoleContextValue {
  readonly client: ControlClient;
  readonly connection: ConnectionState;
  /** Incremented by Reconnect; every resource reloads its persisted record. */
  readonly reloadEpoch: number;
  readonly reconnect: () => void;
  readonly announce: (message: string) => void;
  readonly announcement: string;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function ConsoleProvider({ client, children }: { client: ControlClient; children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>(client.connectionState);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => client.subscribe(setConnection), [client]);
  const reconnect = useCallback(() => setReloadEpoch((n) => n + 1), []);
  const announce = useCallback((message: string) => {
    // Clearing first makes identical consecutive messages announce again.
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(message), 30);
  }, []);
  const value = useMemo(
    () => ({ client, connection, reloadEpoch, reconnect, announce, announcement }),
    [client, connection, reloadEpoch, reconnect, announce, announcement],
  );
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (value === null) throw new Error('ConsoleProvider missing');
  return value;
}

export type ResourceState<T> =
  | {
      readonly status: 'loading';
      readonly data: T | null;
      readonly error: null;
      readonly fetchedAt: string | null;
    }
  | { readonly status: 'success'; readonly data: T; readonly error: null; readonly fetchedAt: string }
  | {
      readonly status: 'error';
      readonly data: T | null;
      readonly error: ApiError;
      readonly fetchedAt: string | null;
    };

/**
 * Loads one persisted record. On failure the last authoritative value is kept and marked
 * stale; it is never replaced by a guess.
 */
export function useResource<T>(
  load: ((client: ControlClient, signal: AbortSignal) => Promise<T>) | null,
  deps: readonly unknown[],
): { state: ResourceState<T>; reload: () => void } {
  const { client, reloadEpoch } = useConsole();
  const [state, setState] = useState<ResourceState<T>>({
    status: 'loading',
    data: null,
    error: null,
    fetchedAt: null,
  });
  const [localEpoch, setLocalEpoch] = useState(0);
  const lastGood = useRef<{ data: T; fetchedAt: string } | null>(null);
  const depsKey = JSON.stringify(deps);
  const prevKey = useRef(depsKey);

  useEffect(() => {
    if (load === null) return;
    if (prevKey.current !== depsKey) {
      // A changed selection invalidates prior data: never show another identity's record.
      lastGood.current = null;
      prevKey.current = depsKey;
    }
    const controller = new AbortController();
    setState({
      status: 'loading',
      data: lastGood.current?.data ?? null,
      error: null,
      fetchedAt: lastGood.current?.fetchedAt ?? null,
    });
    load(client, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        const fetchedAt = new Date().toISOString();
        lastGood.current = { data, fetchedAt };
        setState({ status: 'success', data, error: null, fetchedAt });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError({
                kind: 'SERVER',
                message: 'Unexpected console error.',
                status: null,
                code: null,
                requestId: null,
                recoverable: false,
                fieldErrors: [],
                method: 'GET',
                path: '',
                attempts: 1,
                outcomeUnknown: false,
              });
        setState({
          status: 'error',
          data: lastGood.current?.data ?? null,
          error: apiError,
          fetchedAt: lastGood.current?.fetchedAt ?? null,
        });
      },
    );
    return () => controller.abort();
  }, [client, reloadEpoch, localEpoch, depsKey]);

  const reload = useCallback(() => setLocalEpoch((n) => n + 1), []);
  return { state, reload };
}

export type MutationState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'success'; readonly result: MutationResult<T> }
  | { readonly status: 'error'; readonly error: ApiError };

export type MutationOutcome<T> =
  | { readonly kind: 'ok'; readonly result: MutationResult<T> }
  | { readonly kind: 'error'; readonly error: ApiError }
  | { readonly kind: 'busy' };

/** One mutation control. Only the submitted action is disabled while pending. */
export function useMutation<A extends unknown[], T>(
  run: (client: ControlClient, ...args: A) => Promise<MutationResult<T>>,
): { state: MutationState<T>; submit: (...args: A) => Promise<MutationOutcome<T>>; reset: () => void } {
  const { client } = useConsole();
  const [state, setState] = useState<MutationState<T>>({ status: 'idle' });
  const pending = useRef(false);
  const submit = useCallback(
    async (...args: A): Promise<MutationOutcome<T>> => {
      if (pending.current) return { kind: 'busy' };
      pending.current = true;
      setState({ status: 'pending' });
      try {
        const result = await run(client, ...args);
        setState({ status: 'success', result });
        return { kind: 'ok', result };
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError({
                kind: 'SERVER',
                message: 'Unexpected console error.',
                status: null,
                code: null,
                requestId: null,
                recoverable: false,
                fieldErrors: [],
                method: 'POST',
                path: '',
                attempts: 1,
                outcomeUnknown: true,
              });
        setState({ status: 'error', error: apiError });
        return { kind: 'error', error: apiError };
      } finally {
        pending.current = false;
      }
    },
    [client, run],
  );
  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return { state, submit, reset };
}
