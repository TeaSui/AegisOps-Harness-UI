// The shell: navigation rail, command palette, keyboard movement, theme, and the view for the current path.
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, qs, useApi } from './api';
import { when } from './format';
import { Icon, Link, Mark, RecordHost, Shield, ToastHost, navigate, useRoute } from './ui';
import { Now } from './views/Now';
import { Sessions } from './views/Sessions';
import { Session } from './views/Session';
import { Audit } from './views/Audit';
import { Cost } from './views/Cost';
import { Ops } from './views/Ops';
import { Run } from './views/Run';

const VIEWS = [
  { key: 'n', path: '/', label: 'Now', icon: 'now' },
  { key: 's', path: '/sessions', label: 'Sessions', icon: 'sessions' },
  { key: 'a', path: '/audit', label: 'Audit', icon: 'audit' },
  { key: 'c', path: '/cost', label: 'Cost', icon: 'cost' },
  { key: 'o', path: '/ops', label: 'Ops', icon: 'ops' },
  { key: 'r', path: '/run', label: 'Run', icon: 'run' },
];

type Theme = 'system' | 'light' | 'dark';
const THEME_LABEL: Record<Theme, string> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('aegis-theme');
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('aegis-theme', theme);
    } catch {
      /* the choice just does not persist */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))];
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/** j / k / Enter over whatever rows the current view marked with data-row; "/" focuses its filter; "g" then a letter jumps. */
function useKeyboard(openPalette: () => void, mainRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    let pendingG = 0;
    const rows = () => Array.from(mainRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []);
    const move = (delta: number) => {
      const list = rows();
      if (!list.length) return;
      const current = list.findIndex((r) => r.classList.contains('row-active'));
      const next = Math.max(0, Math.min(list.length - 1, current === -1 ? (delta > 0 ? 0 : list.length - 1) : current + delta));
      list.forEach((r) => r.classList.remove('row-active'));
      list[next].classList.add('row-active');
      list[next].scrollIntoView({ block: 'nearest' });
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) {
        if (e.key === 'Escape' && e.target instanceof HTMLElement) e.target.blur();
        return;
      }
      const now = Date.now();
      if (pendingG && now - pendingG < 1200) {
        pendingG = 0;
        const view = VIEWS.find((v) => v.key === e.key.toLowerCase());
        if (view) {
          e.preventDefault();
          navigate(view.path);
        }
        return;
      }
      if (e.key === 'g') pendingG = now;
      else if (e.key === 'j') move(1);
      else if (e.key === 'k') move(-1);
      else if (e.key === 'Enter') {
        const active = mainRef.current?.querySelector<HTMLElement>('[data-row].row-active');
        if (active) {
          e.preventDefault();
          active.click();
        }
      } else if (e.key === '/') {
        const filter = mainRef.current?.querySelector<HTMLElement>('[data-filter]');
        if (filter) {
          e.preventDefault();
          filter.focus();
        }
      } else if (e.key === '?') openPalette();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette, mainRef]);
}

type Entry = { group: string; label: string; hint?: string; go: () => void };

function Palette({ onClose, cycleTheme }: { onClose: () => void; cycleTheme: () => void }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      get(`/api/sessions${qs({ q, limit: 8 })}`).then(
        (r) => live && setFound(r.items),
        () => live && setFound([]),
      );
    }, 160);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [text]);
  const entries = useMemo<Entry[]>(() => {
    const q = text.trim().toLowerCase();
    const views: Entry[] = [
      ...VIEWS.map((v) => ({ group: 'Go to', label: v.label, hint: `g ${v.key}`, go: () => navigate(v.path) })),
      { group: 'Go to', label: 'Audit: risk findings', go: () => navigate('/audit') },
      { group: 'Go to', label: 'Audit: ledger of what ran', go: () => navigate('/audit/ledger') },
      { group: 'Go to', label: 'Audit: integrity of transcripts', go: () => navigate('/audit/integrity') },
      { group: 'Go to', label: 'Ops: hooks', go: () => navigate('/ops/hooks') },
      { group: 'Go to', label: 'Ops: tools and MCP servers', go: () => navigate('/ops/tools') },
      { group: 'Go to', label: 'Ops: configuration', go: () => navigate('/ops/config') },
      { group: 'Go to', label: 'Ops: doctor checks', go: () => navigate('/ops/doctor') },
      { group: 'Do', label: 'Switch theme', go: cycleTheme },
      { group: 'Do', label: 'Sessions with errors', go: () => navigate('/sessions?errors=1') },
      { group: 'Do', label: 'Sessions with high-risk actions', go: () => navigate('/sessions?risk=high') },
    ].filter((e) => !q || e.label.toLowerCase().includes(q));
    const sessions: Entry[] = found.map((s) => ({ group: 'Sessions', label: s.title, hint: when(s.lastTs), go: () => navigate(`/sessions/${encodeURIComponent(s.id)}`) }));
    const search: Entry[] = q.length >= 2 ? [{ group: 'Search', label: `Search sessions for "${text.trim()}"`, go: () => navigate(`/sessions${qs({ q: text.trim() })}`) }] : [];
    return [...views, ...sessions, ...search];
  }, [text, found, cycleTheme]);
  useEffect(() => setSelected(0), [text]);
  const choose = (e: Entry) => {
    onClose();
    e.go();
  };
  let lastGroup = '';
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={input}
          value={text}
          placeholder="Go to a view, or search sessions by what was said or run"
          aria-label="Command or search"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => Math.min(entries.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter' && entries[selected]) choose(entries[selected]);
          }}
        />
        <ul role="listbox">
          {entries.map((e, i) => {
            const head = e.group !== lastGroup ? <div className="group" key={`g-${e.group}`}>{e.group}</div> : null;
            lastGroup = e.group;
            return (
              <div key={`${e.group}-${e.label}-${i}`}>
                {head}
                <li role="option" aria-selected={i === selected} onMouseEnter={() => setSelected(i)} onClick={() => choose(e)}>
                  <span className="clip">{e.label}</span>
                  {e.hint ? <span className="hint">{e.hint}</span> : null}
                </li>
              </div>
            );
          })}
          {entries.length === 0 ? <div className="group">Nothing matches. Type two or more characters to search sessions.</div> : null}
        </ul>
      </div>
    </>
  );
}

export function App() {
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, cycleTheme] = useTheme();
  const mainRef = useRef<HTMLElement | null>(null);
  const openPalette = useMemo(() => () => setPaletteOpen(true), []);
  useKeyboard(openPalette, mainRef);
  const overview = useApi<any>('/api/overview', 'all');
  const live = useApi<any>('/api/live', 'all');
  const attention = live.data?.attention?.length ?? 0;
  const indexing = overview.data?.index?.state === 'indexing';
  useEffect(() => {
    if (!indexing) return;
    const t = window.setInterval(overview.reload, 1000);
    return () => window.clearInterval(t);
  }, [indexing, overview.reload]);
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
    mainRef.current?.querySelectorAll('.row-active').forEach((r) => r.classList.remove('row-active'));
  }, [route.path]);

  const section = '/' + (route.path.split('/')[1] ?? '');
  let view;
  if (route.path === '/') view = <Now live={live} overview={overview.data} />;
  else if (route.path === '/sessions') view = <Sessions query={route.query} facets={overview.data?.facets} />;
  else if (route.path.startsWith('/sessions/')) view = <Session id={decodeURIComponent(route.path.slice('/sessions/'.length))} query={route.query} />;
  else if (section === '/audit') view = <Audit tab={route.path.split('/')[2] ?? 'findings'} query={route.query} />;
  else if (section === '/cost') view = <Cost query={route.query} />;
  else if (section === '/ops') view = <Ops tab={route.path.split('/')[2] ?? 'health'} query={route.query} />;
  else if (section === '/run') view = <Run control={overview.data?.control} />;
  else view = <div className="page"><div className="empty"><b>No such page</b>Use the navigation on the left, or press Ctrl K.</div></div>;

  const progress = overview.data?.index?.progress;
  return (
    <ToastHost>
      <RecordHost>
        <div className="shell">
          <nav className="rail" aria-label="Views">
            <div className="brand">
              <Shield />
              <div>
                <b>Aegis</b>
                <span>Claude Code console</span>
              </div>
            </div>
            <div className="nav">
              {VIEWS.map((v) => (
                <Link key={v.path} to={v.path} current={v.path === '/' ? route.path === '/' : section === v.path} title={`${v.label} (g then ${v.key})`}>
                  <Icon name={v.icon} />
                  <span>{v.label}</span>
                  {v.path === '/' && attention > 0 ? <b className="count" title={`${attention} need you`}>{attention}</b> : null}
                  <kbd>{v.key}</kbd>
                </Link>
              ))}
            </div>
            <div className="rail-foot">
              {indexing && progress ? (
                <div title="Reading transcripts">
                  <div className="wide">Indexing {progress.done} of {progress.total}</div>
                  <div className="progress"><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
                </div>
              ) : null}
              <button className="linkish row" onClick={openPalette} title="Command palette">
                <Icon name="search" size={15} />
                <span className="wide">Search and commands</span>
                <kbd className="wide">Ctrl K</kbd>
              </button>
              <button className="linkish row" onClick={cycleTheme} title={`${THEME_LABEL[theme]}. Click to change.`}>
                <Icon name="theme" size={15} />
                <span className="wide">{THEME_LABEL[theme]}</span>
              </button>
              <div className="wide">
                {overview.data ? (
                  overview.data.control ? <Mark tone="warn">Control mode: runs can be launched</Mark> : <span>Read-only. v{overview.data.version}</span>
                ) : overview.error ? (
                  <Mark tone="critical">Not connected</Mark>
                ) : null}
              </div>
            </div>
          </nav>
          <main className="main" ref={mainRef} tabIndex={-1}>
            {overview.error && !overview.data ? (
              <div className="page"><div className="banner critical" role="alert"><Mark tone="critical">{overview.error}</Mark></div></div>
            ) : (
              view
            )}
          </main>
        </div>
        {paletteOpen ? <Palette onClose={() => setPaletteOpen(false)} cycleTheme={cycleTheme} /> : null}
      </RecordHost>
    </ToastHost>
  );
}
