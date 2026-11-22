// Talks to the Aegis server on the same origin. State-changing calls carry the header the server requires.
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parse(res: Response) {
  if (res.ok) return res.json();
  let message = `The server answered ${res.status}`;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* keep the generic message */
  }
  if (res.status === 401) message = 'This console is signed out. Open the link Aegis printed in the terminal when it started.';
  throw new ApiError(res.status, message);
}

export const get = <T = any>(path: string): Promise<T> => fetch(path, { credentials: 'same-origin' }).then(parse);

export const post = <T = any>(path: string, body?: unknown): Promise<T> =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Aegis': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(parse);

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---- push: one event stream for the whole console -------------------------------------------------------

type Listener = (event: 'index' | 'live' | 'open', data: any) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
export const pushState = { connected: false };

function connect() {
  if (source) return;
  source = new EventSource('/api/events');
  const emit = (event: 'index' | 'live' | 'open', data: any) => listeners.forEach((l) => l(event, data));
  source.addEventListener('index', (e) => emit('index', JSON.parse((e as MessageEvent).data)));
  source.addEventListener('live', (e) => emit('live', JSON.parse((e as MessageEvent).data)));
  // there is no replay: after a reconnect everything on screen is refetched
  source.onopen = () => {
    pushState.connected = true;
    emit('open', {});
  };
  source.onerror = () => {
    pushState.connected = false;
  };
}

export function onPush(listener: Listener): () => void {
  connect();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type Loaded<T> = { data: T | undefined; error: string | null; loading: boolean; reload: () => void };

/**
 * Loads a path and keeps it fresh: reloads when the path changes and, when `live` is given, when the server
 * pushes a change that matters (coalesced, so a busy session does not hammer the server).
 */
export function useApi<T = any>(path: string | null, live?: 'all' | 'live' | ((sessions: string[]) => boolean)): Loaded<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean; path: string | null }>({ data: undefined, error: null, loading: !!path, path });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    get<T>(path).then(
      (data) => mine === seq.current && setState({ data, error: null, loading: false, path }),
      (e: Error) => mine === seq.current && setState((s) => ({ data: s.path === path ? s.data : undefined, error: e.message, loading: false, path })),
    );
  }, [path]);
  useEffect(() => {
    setState((s) => (s.path === path ? s : { data: undefined, error: null, loading: !!path, path }));
    load();
  }, [load, path]);
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    if (!live) return;
    let timer: number | undefined;
    const off = onPush((event, data) => {
      const want = liveRef.current;
      const relevant = event === 'open' || want === 'all' || (want === 'live' ? true : event === 'index' && typeof want === 'function' && want(data.sessions ?? []));
      if (!relevant || timer) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        load();
      }, 400);
    });
    return () => {
      off();
      if (timer) window.clearTimeout(timer);
    };
  }, [load, !!live]);
  return { data: state.path === path ? state.data : undefined, error: state.error, loading: state.loading, reload: load };
}
