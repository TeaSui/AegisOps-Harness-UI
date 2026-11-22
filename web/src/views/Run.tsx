// Run: start a headless run of the harness and stop it. Exists only when Aegis was started with --control.
import { useEffect, useState } from 'react';
import { post, useApi } from '../api';
import { duration, shortPath, when } from '../format';
import { Empty, Link, Mark, Pill, Problem, useToast } from '../ui';

const MODE_HELP: Record<string, string> = {
  plan: 'Plan only: reads and proposes, changes nothing',
  manual: 'Asks before each action; in a headless run anything that would ask is denied',
  acceptEdits: 'File edits are accepted; other actions follow your rules',
  auto: 'The auto-mode classifier decides',
  dontAsk: 'Only what your allow rules permit; nothing else runs',
};

const STATE_TONE: Record<string, 'info' | 'good' | 'critical' | 'idle'> = { starting: 'info', running: 'info', exited: 'good', failed: 'critical' };

function Launcher() {
  const projects = useApi<any>('/api/projects');
  const runs = useApi<any>('/api/runs', 'all');
  const toast = useToast();
  const [project, setProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('plan');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items: any[] = runs.data?.items ?? [];
  const active = items.some((r) => r.state === 'starting' || r.state === 'running');
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(runs.reload, 1500);
    return () => window.clearInterval(t);
  }, [active, runs.reload]);
  useEffect(() => {
    if (!project && projects.data?.items.length) setProject(projects.data.items[0].id);
  }, [projects.data, project]);
  const launch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/runs', { project, prompt, permissionMode: mode, ...(model.trim() ? { model: model.trim() } : {}) });
      setPrompt('');
      toast('Run launched');
      runs.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async (id: string) => {
    try {
      await post(`/api/runs/${id}/stop`);
      toast('Stop requested');
      runs.reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <>
      <form className="form panel pad" onSubmit={launch}>
        <label>
          Prompt
          <textarea className="field" rows={5} value={prompt} maxLength={runs.data?.maxPrompt ?? 100000} required placeholder="What should the run do?" onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <div className="cols">
          <label>
            Project
            <select className="field" value={project} onChange={(e) => setProject(e.target.value)} required>
              {(projects.data?.items ?? []).map((p: any) => <option key={p.id} value={p.id}>{shortPath(p.cwd) || p.id}</option>)}
            </select>
            <small>Only folders the harness has already worked in.</small>
          </label>
          <label>
            Permission mode
            <select className="field" value={mode} onChange={(e) => setMode(e.target.value)}>
              {(runs.data?.modes ?? ['plan']).map((m: string) => <option key={m} value={m}>{m}</option>)}
            </select>
            <small>{MODE_HELP[mode]}</small>
          </label>
          <label>
            Model
            <input className="field" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Your default" pattern="[A-Za-z0-9][A-Za-z0-9._:\[\]\-]{0,99}" />
            <small>An alias such as sonnet or opus, or a full id. Empty uses your default.</small>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={busy || !prompt.trim() || !project}>{busy ? 'Launching…' : 'Launch run'}</button>
          <span className="muted">Runs as you, in that folder, and spends tokens. A mode that bypasses permission checks is never offered.</span>
        </div>
        {error ? <Mark tone="critical">{error}</Mark> : null}
      </form>

      <section className="section">
        <div className="section-head"><h2>Runs launched here</h2><p>Since Aegis started. At most {runs.data?.maxActive ?? 4} run at once.</p></div>
        <Problem error={runs.error} />
        <div className="panel table-wrap">
          {items.length === 0 ? <Empty title="No run yet">A launched run appears here, and among the sessions once it writes its transcript.</Empty> : (
            <table>
              <thead><tr><th>State</th><th>Started</th><th>Project</th><th>Mode</th><th>Model</th><th>Result</th><th /></tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td><Pill tone={r.state === 'exited' && (r.exitCode !== 0 || r.signal) ? 'critical' : STATE_TONE[r.state] ?? 'idle'}>{r.state}</Pill></td>
                    <td className="nowrap">{when(r.startedAt)}</td>
                    <td className="mono" title={r.cwd}>{shortPath(r.cwd)}</td>
                    <td>{r.permissionMode}</td>
                    <td>{r.model ?? 'default'}</td>
                    <td style={{ maxWidth: 360 }}>
                      {r.state === 'exited' ? (r.signal ? `stopped by ${r.signal}` : `exit code ${r.exitCode}`) : r.state === 'failed' ? 'could not start' : 'running'}
                      {r.endedAt ? <span className="muted">, {duration(r.endedAt - r.startedAt)}</span> : null}
                      {r.stderrTail && r.exitCode !== 0 ? <div className="cell-sub mono" style={{ overflowWrap: 'anywhere' }}>{r.stderrTail.slice(-300)}</div> : null}
                    </td>
                    <td className="r">
                      <Link to={`/sessions/${encodeURIComponent(r.sessionId)}`}>Session</Link>
                      {r.state === 'running' || r.state === 'starting' ? <button className="btn small danger" style={{ marginLeft: 10 }} onClick={() => stop(r.id)} disabled={!!r.stopRequestedAt}>{r.stopRequestedAt ? 'Stopping…' : 'Stop'}</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

export function Run({ control }: { control: boolean | undefined }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Run</h1>
          <p className="lede">Start a headless run in a project and watch it like any other session. Interactive work stays in the terminal.</p>
        </div>
      </div>
      {control === undefined ? null : control ? (
        <Launcher />
      ) : (
        <div className="panel pad" style={{ maxWidth: 760 }}>
          <h2 style={{ marginBottom: 6 }}>This console is read-only</h2>
          <p className="soft" style={{ marginBottom: 12 }}>
            Launching runs is off unless Aegis is started with control mode, so a console that only reads can never be turned into a way to run code. To enable it, stop Aegis and start it again with:
          </p>
          <pre className="code panel" style={{ background: 'var(--sunken)' }}>npm run start:control</pre>
          <p className="soft" style={{ marginTop: 12 }}>
            To continue an existing session yourself, open it under <Link to="/sessions">Sessions</Link> and copy its resume command.
          </p>
        </div>
      )}
    </div>
  );
}
