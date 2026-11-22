import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Home, rec, start, T0 } from './fixture.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const sources = walk(join(root, 'web', 'src')).filter((f) => /\.(tsx?|css)$/.test(f));

test('AEGIS-36 AEGIS-37 the client type-checks, builds, and is served with the security headers', async () => {
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'web', 'tsconfig.json')], { stdio: 'pipe' });
  execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', join(root, 'web', 'vite.config.ts'), '--logLevel', 'error'], { stdio: 'pipe', cwd: root });
  assert.ok(existsSync(join(root, 'web', 'dist', 'index.html')));
  const home = new Home();
  home.transcript('-work-alpha', 's', [rec.prompt({ sid: 's', at: T0 }, '<img src=x onerror=alert(1)><script>alert(2)</script>')]);
  const c = await start(home);
  try {
    const page = await c.getRes('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
    const html = await page.text();
    assert.match(html, /<div id="root">/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'the page has an inline script');
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'(;|$)/);
    // client routes are served by the same page; assets by their path; nothing outside the build
    assert.equal((await c.getRes('/sessions/anything')).status, 200);
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1];
    const js = await c.getRes(asset);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
    for (const path of ['/assets/../../package.json', '/..%2F..%2Fpackage.json', '/assets/%2e%2e/%2e%2e/package.json', '/missing.js']) {
      const res = await c.getRes(path);
      assert.ok(res.status === 404 || !(await res.text()).includes('"devDependencies"'), path);
    }
    // without the session cookie the page is a notice, not the client
    const anonymous = await fetch(`${c.origin}/`);
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(await anonymous.text(), /assets\//);
    // INPUT-01: markup in a transcript reaches the client as a JSON string, never as markup
    const list = await c.getRes('/api/sessions');
    assert.match(list.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(((await list.json()) as any).items[0].title, '<img src=x onerror=alert(1)><script>alert(2)</script>');
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-36 the client source has no raw-HTML sink and loads nothing from a remote host', () => {
  assert.ok(sources.length > 8);
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const sink of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.ok(!text.includes(sink), `${sink} in ${file}`);
    }
    // the only absolute URLs allowed are namespace identifiers and the link guard itself
    const urls = (text.match(/https?:\/\/[^\s'"`)]+/g) ?? []).filter((u) => !u.startsWith('http://www.w3.org/'));
    assert.deepEqual(urls, [], `remote URL in ${file}`);
  }
  const built = walk(join(root, 'web', 'dist')).filter((f) => /\.(html|css)$/.test(f));
  for (const file of built) assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:src|href)="https?:|url\(\s*["']?https?:|@import/, file);
});

test('DEP-01 the server has no runtime package dependency and versions are pinned', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  for (const [name, version] of Object.entries<string>(manifest.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is not pinned`);
  assert.ok(existsSync(join(root, 'package-lock.json')));
  for (const file of walk(join(root, 'server', 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/from '([^'.][^']*)'/g)) assert.match(m[1], /^node:/, `${file} imports ${m[1]}`);
  }
});
