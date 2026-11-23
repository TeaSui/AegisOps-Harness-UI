// Shared pieces: routing, icons, status marks, the raw-record drawer.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { post, useApi } from './api';
import { MARK_CLOSE, MARK_OPEN } from './marks';

// ---- routing: plain paths and the history API ---------------------------------------------------

export type Route = { path: string; query: URLSearchParams };
const read = (): Route => ({ path: window.location.pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(window.location.search) });
const routeListeners = new Set<() => void>();

export function navigate(to: string, replace = false) {
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  routeListeners.forEach((l) => l());
}

export function useRoute(): Route {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    routeListeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      routeListeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return route;
}

/** Updates query parameters in place (filters live in the URL so a view can be shared or reloaded). */
export function setQuery(changes: Record<string, string | null>) {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === '') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  navigate(window.location.pathname + (s ? `?${s}` : ''), true);
}

export function Link({ to, children, className, current, title }: { to: string; children: ReactNode; className?: string; current?: boolean; title?: string }) {
  return (
    <a
      href={to}
      className={className}
      title={title}
      aria-current={current ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---- icons ------------------------------------------------------------------------------------------

const PATHS: Record<string, ReactNode> = {
  now: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></>,
  sessions: <><path d="M4 6h16M4 12h16M4 18h10" /></>,
  audit: <><path d="M12 3 5 6v5c0 4.5 2.900 8 7 10 4.100-2 7-5.500 7-10V6z" /><path d="m9 12 2 2 4-4" /></>,
  cost: <><path d="M4 19V9M10 19V5M16 19v-7M21 19H3" /></>,
  ops: <><path d="M3 12h4l2-6 4 12 2-6h6" /></>,
  run: <><path d="M7 5v14l11-7z" /></>,
  ok: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  error: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  denied: <><circle cx="12" cy="12" r="9" /><path d="M6 18 18 6" /></>,
  pending: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  warn: <><path d="M12 4 2.500 20h19z" /><path d="M12 10v4M12 17v.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.5" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.500-4.500" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  theme: <><path d="M20 14.500A8 8 0 1 1 9.500 4a6.500 6.500 0 0 0 10.500 10.500z" /></>,
  down: <><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  back: <><path d="m14 6-6 6 6 6" /></>,
  fwd: <><path d="m10 6 6 6-6 6" /></>,
  skipBack: <><path d="m18 6-7 6 7 6M7 6v12" /></>,
  skipFwd: <><path d="m6 6 7 6-7 6M17 6v12" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.500 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  bellOff: <><path d="M6 16V11a6 6 0 0 1 9-5.200M18 11v5l1.500 2H8" /><path d="M10 20a2 2 0 0 0 4 0M4 4l16 16" /></>,
  swap: <><path d="M4 8h13l-3.500-3.500M20 16H7l3.500 3.500" /></>,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  replay: <><path d="M4 12a8 8 0 1 0 2.600-5.900" /><path d="M4 4v5h5" /></>,
};

export function Icon({ name, size }: { name: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? PATHS.info}
    </svg>
  );
}

const tint = (v: string) => `color-mix(in srgb, var(${v}) 58%, var(--surface))`;

// The six views: an ink outline with one flat colour each, so the rail reads by colour as well as by shape.
const VIEW_ICONS: Record<string, ReactNode> = {
  now: <><circle cx="12" cy="12" r="8.500" fill={tint('--s8')} /><circle cx="12" cy="12" r="2.600" fill="var(--ink)" stroke="none" /><path d="M12 1.800v3M12 19.200v3M1.800 12h3M19.200 12h3" /></>,
  sessions: <><path d="M3 7.500a2 2 0 0 1 2-2h4.200l2 2.200H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill={tint('--s4')} /><path d="M7 12.500h10M7 15.500h6" /></>,
  audit: <><path d="M12 2.800 4.800 5.800v5.400c0 4.400 2.900 7.900 7.200 9.900 4.300-2 7.200-5.500 7.200-9.900V5.800z" fill={tint('--s6')} /><path d="m8.800 12 2.300 2.300 4.200-4.600" /></>,
  cost: <><rect x="3.500" y="11" width="4.500" height="9" rx="1" fill={tint('--s1')} /><rect x="9.750" y="4" width="4.500" height="16" rx="1" fill={tint('--s1')} /><rect x="16" y="8" width="4.500" height="12" rx="1" fill={tint('--s1')} /></>,
  ops: <><rect x="2.800" y="4.500" width="18.400" height="15" rx="3" fill={tint('--s5')} /><path d="M5.500 12h3l1.800-4 3.200 8 1.700-4h3.300" /></>,
  run: <><circle cx="12" cy="12" r="9" fill={tint('--s2')} /><path d="M10 8.200v7.600l6-3.800z" fill="var(--ink)" /></>,
};

export function ViewIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="1.700" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {VIEW_ICONS[name] ?? PATHS.info}
    </svg>
  );
}

export function Shield() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M17.500 4.500 28 8.400v7.800c0 6.600-4.400 11.700-10.500 14C11.400 27.900 7 22.800 7 16.200V8.400z" fill="var(--drop)" />
      <path d="M16 2.800 26.500 6.700v7.800c0 6.600-4.400 11.700-10.500 14C9.900 26.200 5.500 21.100 5.500 14.500V6.700z" fill="var(--go)" stroke="var(--ink)" strokeWidth="1.600" strokeLinejoin="round" />
      <path d="M10.500 15.600h3.200l1.800-4.500 2.600 8.600 1.700-4.100h2.200" fill="none" stroke="var(--ink)" strokeWidth="1.900" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- status: always a glyph and a word, never colour alone ---------------------------------------------

type Tone = 'good' | 'warn' | 'serious' | 'critical' | 'idle' | 'info';
const TONE_ICON: Record<Tone, string> = { good: 'ok', warn: 'warn', serious: 'warn', critical: 'error', idle: 'pending', info: 'info' };

export function Mark({ tone, children, icon, title }: { tone: Tone; children: ReactNode; icon?: string; title?: string }) {
  return (
    <span className={`mark ${tone}`} title={title}>
      <Icon name={icon ?? TONE_ICON[tone]} />
      {children}
    </span>
  );
}

export function Pill({ tone, children, icon, title }: { tone: Tone; children: ReactNode; icon?: string | null; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {icon === null ? null : <Icon name={icon ?? TONE_ICON[tone]} />}
      {children}
    </span>
  );
}

const OUTCOME: Record<string, { tone: Tone; icon: string; label: string }> = {
  ok: { tone: 'good', icon: 'ok', label: 'ok' },
  error: { tone: 'critical', icon: 'error', label: 'failed' },
  denied: { tone: 'serious', icon: 'denied', label: 'denied' },
  pending: { tone: 'idle', icon: 'pending', label: 'no result' },
};
export function Outcome({ status }: { status: string }) {
  const o = OUTCOME[status] ?? { tone: 'idle' as Tone, icon: 'info', label: status };
  return <Mark tone={o.tone} icon={o.icon}>{o.label}</Mark>;
}

export function Severity({ level }: { level: string | null }) {
  if (!level) return <span className="muted">none</span>;
  const tone: Tone = level === 'critical' ? 'critical' : level === 'high' ? 'serious' : level === 'medium' ? 'warn' : 'idle';
  return <Pill tone={tone}>{level}</Pill>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Problem({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="banner critical" role="alert">
      <Mark tone="critical">{error}</Mark>
    </div>
  );
}

/** Search snippets arrive with marker characters around the match; they become <mark> here, as text. */
export function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let rest = text;
  let key = 0;
  for (;;) {
    const open = rest.indexOf(MARK_OPEN);
    if (open === -1) break;
    const close = rest.indexOf(MARK_CLOSE, open);
    if (close === -1) break;
    parts.push(rest.slice(0, open), <mark key={key++}>{rest.slice(open + 1, close)}</mark>);
    rest = rest.slice(close + 1);
  }
  parts.push(rest.split(MARK_OPEN).join('').split(MARK_CLOSE).join(''));
  return <>{parts}</>;
}

// ---- toast ----------------------------------------------------------------------------------------

const ToastContext = createContext<(message: string) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);
export function ToastHost({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 2600);
    return () => window.clearTimeout(t);
  }, [message]);
  return (
    <ToastContext.Provider value={setMessage}>
      {children}
      {message ? <div className="toast" role="status">{message}</div> : null}
    </ToastContext.Provider>
  );
}

export async function copyText(text: string, toast: (m: string) => void, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Copying was blocked by the browser');
  }
}

// ---- the raw record drawer: every claim can be checked against its transcript line --------------------

export type RecordRef = { file: number; line: number };
const RecordContext = createContext<(ref: RecordRef) => void>(() => undefined);
export const useRecord = () => useContext(RecordContext);

export function RecordHost({ children }: { children: ReactNode }) {
  const [ref, setRef] = useState<RecordRef | null>(null);
  return (
    <RecordContext.Provider value={setRef}>
      {children}
      {ref ? <RecordDrawer at={ref} onClose={() => setRef(null)} onMove={setRef} /> : null}
    </RecordContext.Provider>
  );
}

function RecordDrawer({ at, onClose, onMove }: { at: RecordRef; onClose: () => void; onMove: (r: RecordRef) => void }) {
  const record = useApi<any>(`/api/records/${at.file}/${at.line}`);
  const [revealed, setRevealed] = useState<{ key: string; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const toast = useToast();
  const key = `${at.file}:${at.line}`;
  const shown = revealed?.key === key ? revealed.text : record.data?.text;
  useEffect(() => {
    setConfirming(false);
    setFailed(null);
  }, [key]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const reveal = async () => {
    try {
      const r = await post<any>(`/api/records/${at.file}/${at.line}/reveal`);
      setRevealed({ key, text: r.text });
      setConfirming(false);
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Transcript record">
        <header>
          <Icon name="file" size={18} />
          <div style={{ minWidth: 0 }}>
            <h2>Transcript record</h2>
            <div className="mono muted clip" title={record.data?.path}>
              {record.data ? `${record.data.path}:${record.data.line}` : `line ${at.line}`}
            </div>
          </div>
          <span className="spacer" />
          <button className="btn small quiet" onClick={() => onMove({ file: at.file, line: Math.max(1, at.line - 1) })} title="Previous line">Previous</button>
          <button className="btn small quiet" onClick={() => onMove({ file: at.file, line: at.line + 1 })} title="Next line">Next</button>
          <button className="btn small quiet" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </header>
        <div className="scroll">
          <Problem error={record.error ?? failed} />
          {shown !== undefined ? <pre className="code">{shown}</pre> : record.loading ? <Empty title="Reading the transcript" /> : null}
        </div>
        <footer>
          {revealed?.key === key ? (
            <Mark tone="warn">Unmasked. This reveal was written to the activity log.</Mark>
          ) : confirming ? (
            <>
              <span>Show this one record with its secrets unmasked? The reveal is logged.</span>
              <button className="btn small danger" onClick={reveal}>Reveal this record</button>
              <button className="btn small quiet" onClick={() => setConfirming(false)}>Keep masked</button>
            </>
          ) : (
            <>
              <span>Secrets are masked. {record.data?.truncated ? 'Cut at 256 KB.' : ''}</span>
              <button className="btn small" onClick={() => setConfirming(true)}>Reveal…</button>
            </>
          )}
          <span style={{ flex: 1 }} />
          {shown !== undefined ? (
            <button className="btn small" onClick={() => copyText(shown, toast)}><Icon name="copy" size={14} />Copy</button>
          ) : null}
        </footer>
      </aside>
    </>
  );
}

/** A small "file:line" button that opens the raw record. */
export function Source({ file, line }: { file: number; line: number }) {
  const open = useRecord();
  return (
    <button
      className="linkish mono"
      title="Open the transcript record this came from"
      onClick={(e) => {
        e.stopPropagation();
        open({ file, line });
      }}
    >
      line {line}
    </button>
  );
}
