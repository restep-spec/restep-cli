// Tests for restep (the CLI) against the reference server and a mock server.
// From restep/:  node tools/restep-cli/test.mjs
// Ports: 8850 reference server, 8851 the same with RESTEP_TOKEN (oauth), 8852 mock server
// (actions, subcollections, service-desc and retries), 8859 nothing (network error).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'restep.mjs');
const SERVER = join(here, 'vendor/restep-server.mjs');
const REF = 'http://localhost:8850', AUTH = 'http://localhost:8851', MOCK = 'http://localhost:8852';

// ── Mock server: what the reference does not have ─────────────────────
if (process.argv[2] === '--mock') {
  let flaky = 0;
  const counts = {};
  const discovery = {
    restep: '1.0', profiles: ['core', 'query', 'writes'], extensions: ['actions'],
    collections: {
      orders: {
        path: '/orders', methods: ['GET'], item_methods: ['GET'],
        actions: {
          cancel: { on: 'item', safe: false, idempotent: false, description: 'Cancela el pedido.',
            input: { type: 'object', properties: { reason: { type: 'string' } }, additionalProperties: false } },
          import: { on: 'collection', safe: false, idempotent: true },
          preview: { on: 'item', safe: true, idempotent: true, method: 'GET' },
        },
      },
      reviews: { path: '/books/{id}/reviews', sort: ['id'], max_limit: 10 },
      flaky: { path: '/flaky' },
    },
  };
  createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    const echo = { method: req.method, url: req.url, key: req.headers['idempotency-key'] ?? null, body: (() => { try { return body ? JSON.parse(body) : null; } catch { return body; } })() };
    // Draft 6: roots with discoveries that the reference does not have (§1.1, §1.2, §4.2, §5.1, §5.9, §7.1).
    const d6 = {
      restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'], extensions: ['actions', 'inherit'], idempotency: { ttl: 86400, anonymous: false },
      collections: {
        things: {
          path: '/things', methods: ['GET', 'POST'], id_from: 'derived',
          filter: { size: { type: 'shape', ops: ['eq'] }, name: { type: 'string', ops: ['eq', 'regex'] } },
          named_filters: { odd: { type: 'polygon', description: 'Tipo desconocido.' } },
          actions: { zap: { on: 'universe', safe: false, idempotent: false }, peek: { on: 'item', safe: true, idempotent: true, method: 'QUERY' } },
          inherit: { rate: { own: 'rate_own', from: [], default: true } },
        },
        pages: { path: '/pages' },
      },
      singletons: { prefs: { path: '/prefs', methods: ['GET', 'PATCH'], description: 'Preferencias.' }, tpl: { path: '/u/{id}/prefs' }, kid: { path: '/kid/{k}/x', parent: 'nowhere' },
        settings: { path: '/things/{thing_id}/settings', parent: 'things', methods: ['GET', 'PATCH'], actions: { reset: { safe: false, idempotent: true, effects: [] } } } },
    };
    // Draft 7: what the reference does not show at the CLI level (§3, §4.2, §5.1, §5.7, §6.1, §11.1).
    const v7 = {
      restep: '1.0-draft.7', default_language: 'es-es', profiles: ['core', 'query', 'writes'], extensions: ['actions'], idempotency: { ttl: 1 },
      collections: {
        events: {
          path: '/events', methods: ['GET', 'POST'], item_methods: ['GET', 'PATCH', 'DELETE'], id_from: 'client', upsert: true, reusable_ids: true,
          filter: { id: { type: 'string', ops: ['eq', 'in', 'nin'] }, title: { type: 'string', ops: ['prefix', 'contains'] },
            starts: { type: 'localdatetime', ops: ['ge'] }, zone: { type: 'timezone', ops: ['eq'] }, len: { type: 'duration', ops: ['le'] },
            'reviews.rating': { type: 'integer', ops: ['ge'], quantifier: 'some' }, formats: { type: 'string', ops: ['eq'], quantifier: 'every' },
            reviews: { type: 'string', ops: ['null'] }, 'reviews.id': { type: 'string', ops: ['null'] }, labels: { type: 'string', ops: ['null'] }, pages: { type: 'integer', ops: ['eq', 'ge', 'in'] },
            // Council round 3: a number field (decision 7), null alone with "some" (decision 8).
            weight: { type: 'number', ops: ['ge'] }, tags: { type: 'string', ops: ['null'], quantifier: 'some' } },
          relations: { reviews: { to: 'reviews', many: true } },
          named_filters: { active: { description: 'Not archived.', default: true }, featured: { description: 'Featured.' } },
          localized: { name: { source: 'name_i18n' } },
          item_method_effects: { DELETE: [] },
          actions: {
            compare: { on: 'item', safe: true, idempotent: true, method: 'GET', params: { with: { type: 'string', required: true }, ids: { type: 'integer', list: true } }, output: { type: 'object' } },
            notify: { on: 'item', safe: false, idempotent: true, effects: ['external'] },
            quote: { on: 'item', safe: true, idempotent: true, method: 'GET', effects: ['charges'] },
            peek: { on: 'item', safe: true, idempotent: true, method: 'GET', effects: ['teleports'] },
            ping: { on: 'item', safe: true, idempotent: true, method: 'GET' },
          },
        },
        files: { path: '/files', methods: ['POST'], item_methods: ['GET'], upload: { media_types: ['image/*', 'application/pdf'], max_size: 100 } },
        isbns: { path: '/isbns', filter: { isbn: { type: 'string', ops: ['eq'], required: true } } },
        // Council round 3 (§5.1): upload and create, with and without multipart; a replay without body (§7.3).
        docs: { path: '/docs', methods: ['POST'], upload: { media_types: ['application/json', 'text/*'], multipart: true }, schemas: { create: { type: 'object' } } },
        sheets: { path: '/sheets', methods: ['POST'], upload: { media_types: ['*/*'] }, schemas: { create: { type: 'object' } } },
        // Council round 4 (§5.1): only uploads, and */* admits a JSON file.
        blobs: { path: '/blobs', methods: ['POST'], upload: { media_types: ['*/*'] } },
        replays: { path: '/replays', methods: ['POST'] },
        slow: { path: '/slow', methods: ['POST'] },
      },
      singletons: { prefs: { path: '/prefs', methods: ['GET', 'PATCH'], method_effects: { PATCH: ['external'] } },
        quiet: { path: '/quiet', methods: ['GET', 'PATCH'], method_effects: { PATCH: [] } }, loud: { path: '/loud', methods: ['GET', 'PATCH'] } },
    };
    if (req.url.startsWith('/v7/') && req.url !== '/v7/') {
      const head = { method: req.method, url: req.url, type: req.headers['content-type'] ?? null, disposition: req.headers['content-disposition'] ?? null,
        size: Buffer.byteLength(body), inm: req.headers['if-none-match'] ?? null, key: req.headers['idempotency-key'] ?? null };
      counts[req.url] = (counts[req.url] ?? 0) + 1;
      if (req.url === '/v7/count') return send(200, counts);
      if (req.url === '/v7/slow' || req.url === '/v7/events/gone') return send(503, { type: 'about:blank', title: 'No disponible', status: 503, code: 'unavailable' }, { 'retry-after': req.url === '/v7/slow' ? '2' : '0' });
      if (req.method === 'POST' && req.url === '/v7/files' && head.type === 'application/json')
        return send(415, { type: 'about:blank', title: 'Unsupported Media Type', status: 415, code: 'unsupported_media_type' }, { 'accept-post': 'image/*, application/pdf' });
      if (req.method === 'POST' && req.url === '/v7/files') return send(201, { id: 'f1', echo: head }, { location: '/v7/files/f1' });
      if (req.method === 'POST' && (req.url === '/v7/blobs' || req.url === '/v7/sheets')) return send(201, { id: 'b1', echo: { ...head, body } }, { location: `${req.url}/b1` });
      if (req.method === 'POST' && req.url === '/v7/docs') return send(201, { id: 'd1', echo: { ...head, body } }, { location: '/v7/docs/d1' });
      if (req.method === 'POST' && req.url === '/v7/replays') { res.writeHead(201, { location: '/v7/replays/r1', 'idempotent-replayed': 'true' }); return res.end(); }
      if (req.method === 'PATCH') return send(201, { id: 'e1', echo: head }, { location: req.url });
      if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      return send(200, req.url.includes(':') ? { echo: head } : { items: [], next: null, echo: head }, { 'content-language': 'es-es', vary: 'Accept-Language' });
    }
    if (req.url === '/e400/') return send(400, { type: 'about:blank', title: 'Bad request', status: 400, code: 'bad_request' });
    if (req.url === '/sd/') {
      res.writeHead(200, { 'content-type': 'text/html', link: '</v2/>; rel="service-desc", </sd-one>; rel="service-desc"' });
      return res.end('<h1>Dos</h1>');
    }
    if (req.url === '/d6/things/7/settings') return send(200, { theme: 'dark', echo });
    if (req.url === '/d6/things/7/settings:reset' && req.method === 'POST') return send(200, { theme: 'light', echo });
    const roots = {
      '/v2/': { restep: '2.0', collections: { books: { path: '/books' } } },
      '/rara/': { restep: 'uno', collections: { books: { path: '/books' } } },
      '/d6/': d6,
      '/sinext/': { restep: '1.0-draft.7', profiles: ['core'], collections: { books: { path: '/books', actions: { reserve: { on: 'item', safe: false, idempotent: false } } } } },
      '/old/': { ...d6, restep: '1.0-draft.6' },
      '/v7/': v7,
      '/sd-one': d6,
    };
    if (req.url === '/xo/') {
      res.writeHead(200, { 'content-type': 'text/html', link: '<http://127.0.0.1:8852/xo-desc>; rel="service-desc"' });
      return res.end('<h1>Otra</h1>');
    }
    if (req.url === '/xo-desc') return send(200, { ...d6, 'x-auth': req.headers.authorization ?? null, 'x-cookie': req.headers.cookie ?? null }, { 'cache-control': 'no-store' });
    if (Object.hasOwn(roots, req.url)) return send(200, roots[req.url], { 'cache-control': 'no-store' });
    if (req.url === '/d6/things' && req.method === 'POST') return send(201, { id: 'x', echo });
    if (req.url.startsWith('/d6/things')) return send(200, { items: [], next: null, echo });
    if (req.url === '/d6/prefs') return send(200, { theme: 'dark', echo });
    if (req.url === '/d6/pages') return send(200, { items: [{ id: '1' }], next: 'ftp://localhost:8852/d6/pages?cursor=2' });
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html', link: '</openapi.json>; rel="service-desc", </restep.json>; rel="service-desc"; type="application/json"' });
      return res.end('<h1>Tienda</h1>');
    }
    if (req.url === '/openapi.json') return send(200, { openapi: '3.1.0' });
    if (req.url === '/restep.json') return send(200, discovery, { 'cache-control': 'no-store' });
    if (req.url === '/orders/2001:cancel' && req.method === 'POST') return send(200, { id: '2001', status: 'cancelled', echo });
    if (req.url === '/orders:import' && req.method === 'POST') { res.writeHead(204); return res.end(); }
    if (req.url === '/orders/2001:preview' && req.method === 'GET') return send(200, { id: '2001', preview: true, echo });
    if (req.url.startsWith('/books/7/reviews')) return send(200, { items: [{ id: '1', text: 'Buenísimo' }], next: null, echo });
    if (req.url === '/flaky') {
      if (flaky++ === 0) return send(503, { type: 'about:blank', title: 'No disponible', status: 503, code: 'unavailable' }, { 'retry-after': '0' });
      return send(200, { items: [{ id: 'ok' }], next: null });
    }
    send(404, { type: 'about:blank', title: 'No encontrado', status: 404, code: 'not_found' });
  }).listen(8852, () => console.log('ready'));
}

// ── Utilities ──────────────────────────────────────────────────────────────
function start(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cmd, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.once('data', () => resolve(p));
    p.once('exit', (c) => reject(new Error(`${cmd} exited with ${c}`)));
  });
}
let baseEnv;
function run(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
    p.stdin.end(input ?? '');
  });
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message.replace(/\n/g, '\n        ')}`); }
}
function check(cond, msg, r) {
  if (!cond) throw new Error(`${msg}${r ? `\n code ${r.code}\n stdout: ${r.stdout.slice(0, 600)}\n stderr: ${r.stderr.slice(0, 600)}` : ''}`);
}
const ok = (r, msg = 'should exit with 0') => check(r.code === 0, msg, r);
const exit = (r, code) => check(r.code === code, `should exit with ${code}`, r);

// ── Tests ─────────────────────────────────────────────────────────────────
async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'restep-cli-'));
  const cache = join(tmp, 'cache');
  const config = join(tmp, 'config.json');
  writeFileSync(config, JSON.stringify({
    aliases: {
      tienda: { url: `${REF}/`, language: 'es' },
      privada: { url: AUTH, token_env: 'TOKEN_PRIVADA' },
      corta: REF,
    },
  }));
  baseEnv = { ...process.env, RESTEP_CACHE_DIR: cache, RESTEP_CONFIG: config, RESTEP_URL: '', RESTEP_TOKEN: '', RESTEP_LANGUAGE: '' };
  const procs = await Promise.all([
    start(SERVER, [], { PORT: '8850', RESTEP_TOKEN: '' }),
    start(SERVER, [], { PORT: '8851', RESTEP_TOKEN: 'secreto' }),
    start(fileURLToPath(import.meta.url), ['--mock'], {}),
  ]);
  try {
    console.log('describe');
    await test('describe lists collections and profiles', async () => {
      const r = await run([REF, 'describe']);
      ok(r);
      check(/books/.test(r.stdout) && /categories/.test(r.stdout) && /core, query, writes/.test(r.stdout), 'collections or profiles missing', r);
    });
    await test('--help names get and update of a singleton and describe of a resource (§5.9)', async () => {
      const r = await run(['--help']);
      ok(r); check(/describe \[collection\|resource\]/.test(r.stdout) && /get <resource>/.test(r.stdout) && /update <resource> --data/.test(r.stdout), 'the help does not name them', r);
    });
    await test('no command means describe', async () => {
      const r = await run([REF]);
      ok(r); check(/products/.test(r.stdout), 'does not describe', r);
    });
    await test('describe of a collection: filters, sort, fields', async () => {
      const r = await run([REF, 'describe', 'books']);
      ok(r);
      check(/category\s+enum\s+eq, ne, in\s+novela-negra/.test(r.stdout), 'filters missing', r);
      check(/Sort: id, title, price, rating, year/.test(r.stdout) && /Required on create: title, price/.test(r.stdout), 'sort or required fields missing', r);
    });
    await test('describe --format json', async () => {
      const r = await run([REF, 'describe', 'products', '--format', 'json']);
      ok(r); check(r.json().path === '/products' && r.json().language_maps.name, 'not the declaration', r);
    });
    await test('describe of a missing collection suggests', async () => {
      const r = await run([REF, 'describe', 'bokos']);
      exit(r, 3); check(/Did you mean "books"\?/.test(r.stderr), 'no suggestion', r);
    });
    await test('the cache stores discovery and --no-cache skips it', async () => {
      check(readdirSync(cache).some((f) => f.endsWith('.json')), 'no cache file');
      const a = await run([REF, 'get', 'books', '7', '-v']);
      ok(a); check(!/\(discovery\)/.test(a.stderr), 'fetches discovery despite the cache', a);
      const b = await run([REF, 'get', 'books', '7', '-v', '--no-cache']);
      ok(b); check(/> GET http:\/\/localhost:8850\/ {2}\(discovery\)/.test(b.stderr), 'does not fetch it again', b);
    });

    console.log('get: querying');
    await test('lists the collection (json)', async () => {
      const r = await run([REF, 'get', 'books']);
      ok(r); check(r.json().items.length === 7 && r.json().next === null, 'not the 7 books', r);
    });
    await test('--filter equals, symbols and [op]', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'category=novela-negra', '--filter', 'price<=17', '-f', 'year[ge]=2023']);
      ok(r);
      const ids = r.json().items.map((i) => i.id);
      check(ids.join() === '12', `expected only 12, not ${ids}`, r);
    });
    await test('--filter in and !=', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'category[in]=poesia,ensayo']);
      ok(r); check(r.json().items.length === 2, 'in does not filter', r);
      const n = await run([REF, 'get', 'books', '-f', 'category!=novela-negra']);
      ok(n); check(n.json().items.length === 4, 'ne does not filter', n);
    });
    await test('named filters: -f name and -f name=value (§6.1)', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'featured', '-f', 'price<=15']);
      ok(r); check(r.json().items.map((i) => i.id).join() === '30', 'featured and price<=15 do not give 30', r);
      const s = await run([REF, 'get', 'books', '-f', 'search=NIEBLA', '-s', 'id']);
      ok(s); check(s.json().items.map((i) => i.id).join() === '50,7', 'search does not filter', s);
      const v = await run([REF, 'get', 'books', '-f', 'featured=sí']);
      exit(v, 3); check(/is a switch: it takes no value/.test(v.stderr), 'switch with a value gives no local error', v);
      const o = await run([REF, 'get', 'books', '-f', 'search[eq]=x']);
      exit(o, 3); check(/is a named filter: it takes no operator/.test(o.stderr), 'operator gives no local error', o);
      const d = await run([REF, 'describe', 'books']);
      ok(d); check(/Named filters/.test(d.stdout) && /featured/.test(d.stdout), 'describe does not show them', d);
    });
    await test('missing filter: local error with a suggestion', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'categry=poesia']);
      exit(r, 3); check(/Did you mean "category"\?/.test(r.stderr) && /--raw/.test(r.stderr), 'no suggestion', r);
    });
    await test('--raw sends anyway and shows the problem+json readably', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'categry=poesia', '--raw']);
      exit(r, 5);
      check(/Error 400 unsupported_parameter/.test(r.stderr) && /Parameter: filter\[categry\]/.test(r.stderr), 'problem badly shown', r);
      check(/Hint: filters of "books": id \(eq, in\)/.test(r.stderr), 'no filters hint', r);
    });
    await test('--format json with an error: the problem as is on stdout', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'categry=poesia', '--raw', '-o', 'json']);
      exit(r, 5); check(r.json().code === 'unsupported_parameter', 'not on stdout', r);
    });
    await test('undeclared operator and values of the wrong type', async () => {
      const a = await run([REF, 'get', 'books', '-f', 'price!=10']);
      exit(a, 3); check(/does not support operator ne/.test(a.stderr) && /eq, lt, le, gt, ge/.test(a.stderr), 'operador', a);
      const b = await run([REF, 'get', 'books', '-f', 'year>abc']);
      exit(b, 3); check(/is not an integer/.test(b.stderr), 'integer', b);
      const c = await run([REF, 'get', 'books', '-f', 'category=novela']);
      exit(c, 3); check(/"novela-negra"/.test(c.stderr), 'enum', c);
      const d = await run([REF, 'get', 'books', '-f', 'rating[null]=si']);
      exit(d, 3); check(/true or false/.test(d.stderr), 'null', d);
      const e = await run([REF, 'get', 'books', '-f', 'price=1', '-f', 'price[eq]=2']);
      exit(e, 3); check(/twice/.test(e.stderr), 'repeated', e);
      const f = await run([REF, 'get', 'books', '-f', 'price']); // only a name is a switch (§6.1); price is not one
      exit(f, 3); check(/filters a field and needs a value/.test(f.stderr), 'field without a value', f);
      const g = await run([REF, 'get', 'books', '-f', 'price<']);
      exit(g, 3);
    });
    await test('--sort and a missing sort key', async () => {
      const r = await run([REF, 'get', 'books', '--sort', '-price']);
      ok(r); check(r.json().items[0].id === '23', 'does not sort by descending price', r);
      const e = await run([REF, 'get', 'books', '-s', 'ratin']);
      exit(e, 3); check(/Did you mean "rating"/.test(e.stderr), 'no suggestion', e);
    });
    await test('--fields on a list and an item; missing field', async () => {
      const r = await run([REF, 'get', 'books', '--fields', 'title,price']);
      ok(r); check(Object.keys(r.json().items[0]).filter((k) => k !== '_actions').sort().join() === '_etag,id,price,title', 'fields (plus _etag, §7.2)', r);
      const i = await run([REF, 'get', 'books', '7', '--fields', 'title']);
      ok(i); check(i.json().title && !i.json().price && i.json()._etag, 'item fields', i);
      const e = await run([REF, 'get', 'books', '--fields', 'titel']);
      exit(e, 3); check(/"title"/.test(e.stderr), 'no suggestion', e);
      const m = await run([REF, 'get', 'products', '--fields', 'name.es']);
      exit(m, 3); check(/language map/.test(m.stderr), 'language map', m);
    });
    await test('--limit, --all follows next, limit out of range', async () => {
      const r = await run([REF, 'get', 'books', '--limit', '2']);
      ok(r); check(r.json().items.length === 2 && r.json().next, 'page of 2', r);
      const all = await run([REF, 'get', 'books', '--limit', '2', '--all']);
      ok(all); check(all.json().items.length === 7 && new Set(all.json().items.map((i) => i.id)).size === 7, '--all does not bring the 7', all);
      const e = await run([REF, 'get', 'books', '--limit', '99']);
      exit(e, 3); check(/maximum of "books", 50/.test(e.stderr), 'max_limit', e);
    });
    await test('--count', async () => {
      const r = await run([REF, 'get', 'books', '--count']);
      ok(r); check(r.stdout.trim() === '7', 'total', r);
      const f = await run([REF, 'get', 'books', '--count', '-f', 'category=novela-negra', '-o', 'json']);
      ok(f); check(f.json().total === 3, 'filtered total', f);
    });
    await test('ndjson, csv and table formats', async () => {
      const n = await run([REF, 'get', 'books', '-o', 'ndjson', '--all', '-n', '3']);
      ok(n); check(n.stdout.trim().split('\n').length === 7 && JSON.parse(n.stdout.split('\n')[0]).id, 'ndjson', n);
      const c = await run([REF, 'get', 'books', '-o', 'csv', '--fields', 'title,price']);
      ok(c); check(c.stdout.split('\n')[0] === 'id,title,price' && /^7,La niebla de Portugalete,18.50$/m.test(c.stdout), 'csv', c);
      const t = await run([REF, 'get', 'books', '-o', 'table', '-f', 'category=poesia']);
      ok(t); check(/^id\s+title\s+price/.test(t.stdout) && /Cuaderno de faros/.test(t.stdout), 'table', t);
      const e = await run([REF, 'get', 'books', '-o', 'yaml']);
      exit(e, 2);
    });
    await test('get of an item and 404', async () => {
      const r = await run([REF, 'get', 'books', '7']);
      ok(r); check(r.json().title === 'La niebla de Portugalete', 'item', r);
      const e = await run([REF, 'get', 'books', '999']);
      exit(e, 7); check(/Error 404 not_found/.test(e.stderr), '404', e);
    });

    console.log('writes');
    let id;
    await test('create with --data and an automatic Idempotency-Key', async () => {
      const r = await run([REF, 'create', 'books', '--data', '{"title":"Nuevo","price":"10.00"}', '-v']);
      ok(r); id = r.json().id;
      check(id && /> idempotency-key: "[0-9a-f-]{36}"/.test(r.stderr) && /< 201 Created/.test(r.stderr), 'no key or no 201', r);
    });
    await test('create with @file and with - (standard input)', async () => {
      const file = join(tmp, 'libro.json');
      writeFileSync(file, '{"title":"De archivo","price":"5.00"}');
      const a = await run([REF, 'create', 'books', '-d', `@${file}`]);
      ok(a); check(a.json().title === 'De archivo', 'file', a);
      const b = await run([REF, 'create', 'books', '-d', '-'], { input: '{"title":"De stdin","price":"6.00"}' });
      ok(b); check(b.json().title === 'De stdin', 'stdin', b);
    });
    await test('the same --idempotency-key replays without duplicating; with another body, 422', async () => {
      const args = [REF, 'create', 'books', '-d', '{"title":"Una vez","price":"1.00"}', '--idempotency-key', 'clave-1'];
      const a = await run(args), b = await run(args);
      ok(a); ok(b);
      check(a.json().id === b.json().id && /replay/.test(b.stderr), 'not a replay', b);
      const c = await run([REF, 'create', 'books', '-d', '{"title":"Otra","price":"1.00"}', '--idempotency-key', 'clave-1']);
      exit(c, 9); check(/idempotency_mismatch/.test(c.stderr), 'mismatch', c);
    });
    await test('body validated against schemas.create; --raw sends anyway', async () => {
      const a = await run([REF, 'create', 'books', '-d', '{"title":"Sin precio"}']);
      exit(a, 3); check(/\/price \(required\)/.test(a.stderr), 'required', a);
      const b = await run([REF, 'create', 'books', '-d', '{"title":"X","price":18}']);
      exit(b, 3); check(/\/price \(type\)/.test(b.stderr), 'type', b);
      const c = await run([REF, 'create', 'books', '-d', '{"title":"X","price":"1","isbn":"1"}']);
      exit(c, 3); check(/\/isbn \(unknown\)/.test(c.stderr), 'unknown', c);
      const d = await run([REF, 'create', 'books', '-d', '{"title":"Sin precio"}', '--raw']);
      exit(d, 9); check(/Error 422 invalid/.test(d.stderr) && /- \/price \(required\)/.test(d.stderr), 'server', d);
      const e = await run([REF, 'create', 'books', '-d', '{nope']);
      exit(e, 2); check(/not valid JSON/.test(e.stderr), 'json', e);
    });
    await test('--minimal: no body, Location and ETag are shown', async () => {
      const r = await run([REF, 'create', 'books', '-d', '{"title":"Mín","price":"1.00"}', '--minimal']);
      ok(r); check(r.json().status === 201 && /^\/books\/\d+$/.test(r.json().location) && r.json().etag, 'minimal', r);
    });
    await test('update with Merge Patch, --if-match and --safe', async () => {
      const a = await run([REF, 'update', 'books', id, '-d', '{"price":"12.00","rating":null}', '-v']);
      ok(a); check(a.json().price === '12.00' && /content-type: application\/merge-patch\+json/.test(a.stderr), 'patch', a);
      const b = await run([REF, 'update', 'books', id, '-d', '{"price":"13.00"}', '--if-match', 'viejo']);
      exit(b, 8); check(/412 precondition_failed/.test(b.stderr) && /--safe/.test(b.stderr), '412', b);
      const g = await run([REF, 'get', 'books', id, '-v']);
      const etag = /< etag: (.+)/.exec(g.stderr)[1];
      const c = await run([REF, 'update', 'books', id, '-d', '{"price":"13.00"}', '--if-match', etag.replace(/"/g, '')]);
      ok(c, '--if-match without quotes should work'); check(c.json().price === '13.00', 'if-match', c);
      const d = await run([REF, 'update', 'books', id, '-d', '{"price":"14.00"}', '--safe', '-v']);
      ok(d); check(/> GET .*\/books\//.test(d.stderr) && /> if-match: "[0-9a-f]+"/.test(d.stderr) && d.json().price === '14.00', 'safe', d);
      const e = await run([REF, 'update', 'books', id, '-d', '{"id":"1"}']);
      exit(e, 3);
    });
    await test('inherited value hint (read_only)', async () => {
      const r = await run([REF, 'update', 'products', '1', '-d', '{"tax_rate":"3"}', '--raw']);
      exit(r, 9); check(/write "tax_rate_own"/.test(r.stderr), 'no hint', r);
    });
    await test('delete with --safe and then 404', async () => {
      const r = await run([REF, 'delete', 'books', id, '--safe']);
      ok(r);
      const g = await run([REF, 'get', 'books', id]);
      exit(g, 7);
    });
    await test('--curl prints and does not send', async () => {
      const before = (await run([REF, 'get', 'books', '--count'])).stdout.trim();
      const r = await run([REF, 'create', 'books', '-d', '{"title":"Curl","price":"1.00"}', '--curl'], { env: { RESTEP_TOKEN: 'x' } });
      ok(r);
      check(/^curl -sS -X POST 'http:\/\/localhost:8850\/books' /.test(r.stdout) && /-H 'idempotency-key: "/.test(r.stdout)
        && /--data-raw '\{"title":"Curl","price":"1.00"\}'/.test(r.stdout) && /\$RESTEP_TOKEN/.test(r.stdout) && !/Bearer x/.test(r.stdout), 'curl', r);
      const after = (await run([REF, 'get', 'books', '--count'])).stdout.trim();
      check(before === after, `it created something (${before} → ${after})`);
      const s = await run([REF, 'update', 'books', '7', '-d', '{"price":"1.00"}', '--safe', '--curl']);
      ok(s); check(/# --safe/.test(s.stdout) && /-X PATCH/.test(s.stdout), 'curl --safe', s);
      const q = await run([REF, 'get', 'books', '-f', 'price<=15', '--curl']);
      ok(q); check(q.stdout.includes("'http://localhost:8850/books?filter%5Bprice%5D%5Ble%5D=15'"), 'query curl', q);
    });
    await test('declared methods: POST on an item does not exist', async () => {
      const r = await run([MOCK, 'create', 'orders', '-d', '{}']);
      exit(r, 3); check(/does not support POST/.test(r.stderr), 'methods', r);
    });

    console.log('profiles, token and language');
    await test('RESTEP_URL without a URL in the command', async () => {
      const r = await run(['get', 'books', '7'], { env: { RESTEP_URL: REF } });
      ok(r); check(r.json().id === '7', 'env', r);
    });
    await test('alias @tienda with a language; string alias; unknown alias', async () => {
      const r = await run(['@tienda', 'get', 'books', '999']);
      exit(r, 7); check(/No encontrado/.test(r.stderr) && /no existe/.test(r.stderr), 'not in Spanish', r);
      const c = await run(['@corta', 'get', 'books', '7']);
      ok(c);
      const u = await run(['@tiend', 'get', 'books']);
      exit(u, 2); check(/"tienda"/.test(u.stderr), 'alias suggestion', u);
    });
    await test('default alias in the config file', async () => {
      const file = join(tmp, 'config-default.json');
      writeFileSync(file, JSON.stringify({ default: 'tienda', aliases: { tienda: REF } }));
      const r = await run(['get', 'books', '7'], { env: { RESTEP_CONFIG: file } });
      ok(r); check(r.json().id === '7', 'default', r);
    });
    await test('RESTEP_LANGUAGE and --language', async () => {
      const r = await run([REF, 'get', 'books', '999'], { env: { RESTEP_LANGUAGE: 'es' } });
      exit(r, 7); check(/No encontrado/.test(r.stderr), 'env', r);
      const l = await run([REF, 'get', 'books', '999', '--language', 'es']);
      check(/No encontrado/.test(l.stderr), 'option', l);
    });
    await test('no URL: usage error', async () => {
      const r = await run(['get', 'books']);
      exit(r, 2); check(/Missing the API URL/.test(r.stderr), 'message', r);
    });
    await test('token: readable 401, RESTEP_TOKEN, --token and the alias token_env', async () => {
      const a = await run([AUTH, 'get', 'books']);
      exit(a, 6); check(/401 unauthenticated/.test(a.stderr) && /RESTEP_TOKEN/.test(a.stderr) && /oauth-protected-resource/.test(a.stderr), '401', a);
      const b = await run([AUTH, 'get', 'books', '--count'], { env: { RESTEP_TOKEN: 'secreto' } });
      ok(b); check(/^\d+$/.test(b.stdout.trim()), 'env', b);
      const c = await run([AUTH, 'get', 'books', '7', '--token', 'secreto', '-v']);
      ok(c); check(/authorization: Bearer \*\*\*\*/.test(c.stderr) && !c.stderr.includes('secreto'), 'the token shows in verbose', c);
      const d = await run(['@privada', 'get', 'books', '7'], { env: { TOKEN_PRIVADA: 'secreto' } });
      ok(d);
      const e = await run([AUTH, 'get', 'books', '7', '--token', 'malo']);
      exit(e, 6); check(/the token is not valid/.test(e.stderr), 'bad token', e);
    });

    console.log('actions, subcollections, service-desc, retries');
    await test('discovery through rel="service-desc"', async () => {
      const r = await run([MOCK, 'describe']);
      ok(r); check(/orders/.test(r.stdout) && /Extensions: actions/.test(r.stdout), 'service-desc', r);
    });
    await test('item action with a body and Idempotency-Key', async () => {
      const r = await run([MOCK, 'action', 'orders', '2001', 'cancel', '-d', '{"reason":"me equivoqué"}']);
      ok(r); const e = r.json().echo;
      check(e.method === 'POST' && e.url === '/orders/2001:cancel' && /^"[0-9a-f-]{36}"$/.test(e.key) && e.body.reason === 'me equivoqué', 'action', r);
    });
    await test('action: validated input, missing with a suggestion, wrong on', async () => {
      const a = await run([MOCK, 'action', 'orders', '2001', 'cancel', '-d', '{"motivo":"x"}']);
      exit(a, 3); check(/\/motivo \(unknown\)/.test(a.stderr), 'input', a);
      const b = await run([MOCK, 'action', 'orders', '2001', 'cancle']);
      exit(b, 3); check(/Did you mean "cancel"\?/.test(b.stderr), 'suggestion', b);
      const c = await run([MOCK, 'action', 'orders', 'cancel']);
      exit(c, 2); check(/item action/.test(c.stderr), 'on', c);
      // The reference already announces actions: the API without the extension is a root of the mock.
      const d = await run([`${MOCK}/sinext/`, 'action', 'books', '7', 'reserve']);
      exit(d, 3); check(/actions extension/.test(d.stderr), 'no extension', d);
      const u = await run([REF, 'action', 'books', '7', 'reserve']);
      exit(u, 3); check(/has no action "reserve"/.test(u.stderr), 'action not declared in the reference', u);
    });
    await test('collection action (idempotent, no key) and GET action', async () => {
      const a = await run([MOCK, 'action', 'orders', 'import', '-v']);
      ok(a); check(/> POST http:\/\/localhost:8852\/orders:import/.test(a.stderr) && !/idempotency-key/.test(a.stderr), 'collection', a);
      const b = await run([MOCK, 'action', 'orders', '2001', 'preview']);
      ok(b); check(b.json().echo.method === 'GET' && b.json().preview, 'GET', b);
    });
    await test('subcollection with --parent', async () => {
      const r = await run([MOCK, 'get', 'reviews', '--parent', '7', '--sort', 'id']);
      ok(r); check(r.json().echo.url === '/books/7/reviews?sort=id', 'path', r);
      const e = await run([MOCK, 'get', 'reviews']);
      exit(e, 2); check(/--parent/.test(e.stderr), 'missing parent', e);
    });
    await test('--retry retries a 503 with Retry-After', async () => {
      const r = await run([MOCK, 'get', 'flaky', '--retry', '2', '-v']);
      ok(r); check(/< 503/.test(r.stderr) && r.json().items[0].id === 'ok', 'retry', r);
    });
    await test('network error: code 4', async () => {
      const r = await run(['http://localhost:8859', 'get', 'books']);
      exit(r, 4); check(/Could not connect/.test(r.stderr), 'message', r);
    });
    await test('unknown command and option: code 2 with a suggestion', async () => {
      const a = await run([REF, 'lsit', 'books']);
      exit(a, 2);
      const b = await run([REF, 'get', 'books', '--filtre', 'x=1']);
      exit(b, 2); check(/--filter/.test(b.stderr), 'suggestion', b);
    });

    const comp = async (...words) => (await run(['__complete', '--', ...words])).stdout.trim().split('\n');
    console.log('relations, subcollections and actions against the reference');
    await test('reviews subcollection with its parent: 404 without a parent, deleted with the book', async () => {
      const r = await run([REF, 'get', 'reviews', '--parent', '7', '-o', 'json']);
      ok(r); check(r.json().items.length >= 1 && r.json().items.every((x) => x._etag), 'reviews of book 7', r);
      const n = await run([REF, 'get', 'reviews', '--parent', 'no-existe', '-o', 'json']);
      check(n.code !== 0 && /not_found|404/.test(n.stderr + n.stdout), 'the parent does not exist', n);
      const b = await run([REF, 'create', 'books', '-d', '{"title":"Con reseña","price":"3.00","category":"poesia"}', '-o', 'json']);
      ok(b); const bookId = JSON.parse(b.stdout).id;
      const c = await run([REF, 'create', 'reviews', '--parent', bookId, '-d', '{"rating":4,"text":"Corta."}', '-o', 'json']);
      ok(c); const revId = JSON.parse(c.stdout).id;
      ok(await run([REF, 'get', 'reviews', revId, '--parent', bookId, '-o', 'json']));
      ok(await run([REF, 'delete', 'books', bookId]));
      const g = await run([REF, 'get', 'reviews', revId, '--parent', bookId, '-o', 'json']);
      check(g.code !== 0, 'the review is deleted with the book', g);
    });
    await test('--include: depth 2, relation with href and polymorphic with type', async () => {
      const a = await run([REF, 'get', 'products', '--include', 'category.parent', '-o', 'json']);
      ok(a); check(a.json().items.some((p) => p.category?.parent?.name), 'category.parent included', a);
      const deep = await run([REF, 'get', 'products', '--include', 'category.parent.parent']);
      exit(deep, 3); check(/include depth/.test(deep.stderr), 'goes beyond include_depth', deep);
      const h = await run([REF, 'get', 'books', '7', '-i', 'highlight', '-o', 'json']);
      ok(h); const hl = h.json().highlight;
      check(hl?.href === `/books/7/reviews/${hl?.id}` && typeof hl.text === 'string', 'highlight with href', h);
      const f = await run([REF, 'get', 'reviews', hl.id, '--parent', '7', '-o', 'json']);
      ok(f); check(f.json().text === hl.text, 'the href leads to the review', f);
      const p = await run([REF, 'get', 'categories', '--include', 'showcase', '-o', 'json']);
      ok(p); const shown = p.json().items.map((c) => c.showcase).filter(Boolean);
      check(shown.length && shown.every((x) => ['books', 'products'].includes(x.type)), 'showcase with type', p);
      const bad = await run([REF, 'get', 'categories', '--include', 'showcase.author']);
      exit(bad, 3); check(/include depth/.test(bad.stderr), 'categories does not declare include_depth: 1', bad);
      const no = await run([REF, 'get', 'books', '--include', 'editor']);
      exit(no, 3); check(/is not a relation/.test(no.stderr), 'undeclared relation', no);
      const sg = await run([REF, 'get', 'shop', '--include', 'x']);
      exit(sg, 3); check(/singleton resource/.test(sg.stderr), 'include on a singleton', sg);
    });
    await test('reference actions: collection GET, POST with input, idempotent', async () => {
      const low = await run([REF, 'action', 'products', 'low_stock', '-o', 'json']);
      ok(low); check(low.json().items.every((x) => x.stock < 5), 'low_stock', low);
      const before = (await run([REF, 'get', 'products', '2', '-o', 'json'])).json().stock;
      const r = await run([REF, 'action', 'products', '2', 'restock', '-d', '{"quantity":2}', '-o', 'json']);
      ok(r); check(r.json().stock === before + 2, 'restock adds', r);
      const v = await run([REF, 'action', 'products', '2', 'restock', '-d', '{"quantity":0}']);
      exit(v, 3); check(/quantity/.test(v.stderr), 'input validated locally', v);
      const a = await run([REF, 'action', 'authors', 'find_or_create', '-d', '{"name":"Autora de la CLI"}', '-o', 'json']);
      const b = await run([REF, 'action', 'authors', 'find_or_create', '-d', '{"name":"Autora de la CLI"}', '-o', 'json']);
      // 11.1 (draft 7): an unsafe action on a collection answers 201 with Location, or 204: never 200.
      ok(a); ok(b); check((a.stdout === '' || typeof a.json().id === 'string') && b.stdout === '', 'find_or_create creates once, then gives 204', b);
      const t = await run([REF, 'action', 'categories', '2', 'inherit_tax', '-o', 'json']);
      ok(t); check(t.json().tax_rate_own === null, 'inherit_tax without a body', t);
    });

    console.log('drafts 6 and 7: versions, unknown values, singletons');
    await test('singleton: describe, get, --fields, update; no create or delete (§5.9)', async () => {
      const d = await run([REF, 'describe']);
      ok(d); check(/Singleton resources/.test(d.stdout) && /shop\s+\/shop/.test(d.stdout), 'describe does not show shop', d);
      const ds = await run([REF, 'describe', 'shop']);
      ok(ds); check(/singleton resource/.test(ds.stdout) && /Fields: name/.test(ds.stdout), 'describe shop', ds);
      const g = await run([REF, 'get', 'shop']);
      ok(g); check(typeof g.json().name === 'string', 'get shop', g);
      const f = await run([REF, 'get', 'shop', '--fields', 'name']);
      ok(f); check(f.json().name && f.json().max_reservations === undefined, 'fields on shop', f);
      const u = await run([REF, 'update', 'shop', '-d', JSON.stringify({ name: g.json().name })]);
      ok(u); check(u.json().name === g.json().name, 'update shop', u);
      const i = await run([REF, 'get', 'shop', '7']);
      exit(i, 2);
      const c = await run([REF, 'create', 'shop', '-d', '{}']);
      exit(c, 3); check(/singleton resource/.test(c.stderr), 'create shop', c);
      const x = await run([REF, 'delete', 'shop', '1']);
      exit(x, 3);
    });
    await test('singletons with a template and no parent, or a parent that names nothing, are ignored (§5.9)', async () => {
      const d = await run([`${MOCK}/d6/`, 'describe']);
      ok(d); check(/prefs/.test(d.stdout) && /settings/.test(d.stdout) && !/tpl/.test(d.stdout) && !/\bkid\b/.test(d.stdout), 'tpl or kid show up', d);
      const t = await run([`${MOCK}/d6/`, 'get', 'tpl']);
      exit(t, 3);
      const g = await run([`${MOCK}/d6/`, 'get', 'prefs']);
      ok(g); check(g.json().echo.url === '/d6/prefs', 'get prefs', g);
    });
    await test('version: accepts the suffix and rejects another major or a malformed one, also with --raw (§1.1)', async () => {
      const a = await run([REF, 'describe']);
      ok(a); check(/Restep 1\.0-draft\.\d+/.test(a.stdout), 'does not show the draft', a);
      const b = await run([`${MOCK}/v2/`, 'get', 'books']);
      exit(b, 1); check(/is not Restep 1/.test(b.stderr) && /another major version/.test(b.stderr), 'major 2', b);
      const c = await run([`${MOCK}/v2/`, 'get', 'books', '--raw']);
      exit(c, 1); check(!/echo/.test(c.stdout), 'with --raw it falls back to core', c);
      const d = await run([`${MOCK}/rara/`, 'describe']);
      exit(d, 1); check(/grammar/.test(d.stderr), 'malformed', d);
    });
    await test('unknown values: filter, operator, named filter and action are not used (§4.2)', async () => {
      const d = await run([`${MOCK}/d6/`, 'describe', 'things']);
      ok(d); check(/quantifier this CLI does not know.*size/.test(d.stdout) && /Action zap: declared with an on/.test(d.stdout) && !/^\s+size\s+shape/m.test(d.stdout), 'describe', d);
      const f = await run([`${MOCK}/d6/`, 'get', 'things', '-f', 'size=3']);
      exit(f, 3);
      const o = await run([`${MOCK}/d6/`, 'get', 'things', '-f', 'name[regex]=a']);
      exit(o, 3);
      const n = await run([`${MOCK}/d6/`, 'get', 'things', '-f', 'odd=x']);
      exit(n, 3);
      const z = await run([`${MOCK}/d6/`, 'action', 'things', 'zap']);
      exit(z, 3); check(/does not know/.test(z.stderr), 'action with an unknown on', z);
      const p = await run([`${MOCK}/d6/`, 'action', 'things', '1', 'peek']);
      exit(p, 3);
      check((await comp(`${MOCK}/d6/`, 'get', 'things', '-f', '')).join() === 'name=,name[eq]=', 'filter completion');
    });
    await test('unknown id_from: does not send id; without it, creates (§5.1)', async () => {
      const a = await run([`${MOCK}/d6/`, 'create', 'things', '-d', '{"id":"a1","x":1}']);
      exit(a, 3); check(/id_from "derived"/.test(a.stderr), 'message', a);
      const r = await run([`${MOCK}/d6/`, 'create', 'things', '-d', '{"id":"a1"}', '--raw']);
      exit(r, 3);
      const b = await run([`${MOCK}/d6/`, 'create', 'things', '-d', '{"x":1}']);
      ok(b); check(b.json().echo.method === 'POST', 'creates without id', b);
      const c = await run([REF, 'create', 'books', '-d', '{"id":"zz","title":"X","price":"1.00"}']);
      exit(c, 3); check(/the server assigns the id/.test(c.stderr), 'id with id_from server', c);
    });
    await test('anonymous: false: without credentials it sends no Idempotency-Key (§7.1)', async () => {
      const a = await run([`${MOCK}/d6/`, 'create', 'things', '-d', '{"x":1}']);
      ok(a); check(a.json().echo.key === null, 'sends the key without credentials', a);
      const b = await run([`${MOCK}/d6/`, 'create', 'things', '-d', '{"x":1}', '--idempotency-key', 'k1']);
      exit(b, 3); check(/anonymous/.test(b.stderr), 'explicit key', b);
      const c = await run([`${MOCK}/d6/`, 'create', 'things', '-d', '{"x":1}', '--token', 't']);
      ok(c); check(/^"[0-9a-f-]{36}"$/.test(c.json().echo.key), 'with credentials it does', c);
    });
    await test('experimental inherit only with the draft it knows (§1.2)', async () => {
      const a = await run([`${MOCK}/d6/`, 'describe', 'things']);
      ok(a); check(/Inherited rate/.test(a.stdout), 'draft 7 shows it', a);
      const b = await run([`${MOCK}/old/`, 'describe', 'things']);
      ok(b); check(!/Inherited/.test(b.stdout), 'draft 6 shows it', b);
      const c = await run([`${MOCK}/old/`, 'describe']);
      ok(c); check(/inherit extension is the one of 1\.0-draft\.6/.test(c.stdout), 'warning', c);
    });
    await test('a literal + goes as %2B; next with another scheme is not followed (§5.2, §3)', async () => {
      const q = await run([REF, 'get', 'books', '-f', 'search=a+b c', '--curl']);
      ok(q); check(q.stdout.includes('search%5D=a%2Bb+c'), 'encoding', q);
      const n = await run([`${MOCK}/d6/`, 'get', 'pages', '--all']);
      exit(n, 1); check(/scheme/.test(n.stderr), 'ftp', n);
    });
    await test('credentials from -H do not go to another origin (§4.3)', async () => {
      const r = await run([`${MOCK}/xo/`, 'describe', '-o', 'json', '-H', 'Authorization: Bearer x', '-H', 'Cookie: s=1', '--token', 'y']);
      ok(r); check(r.json()['x-auth'] === null && r.json()['x-cookie'] === null, 'sends credentials to 127.0.0.1', r);
    });

    console.log('draft 7');
    const V7 = `${MOCK}/v7/`;
    await test('describe: default language, default and required filters, localized fields, effects, params, upload (§4.3, §5.6, §6.1, §11.1)', async () => {
      const d = await run([V7, 'describe']);
      ok(d); check(/Default language: es-es/.test(d.stdout), 'default_language', d);
      const ev = await run([V7, 'describe', 'events']);
      ok(ev);
      for (const re of [/Default filters .*: active/, /Localized fields .*name from name_i18n/, /upsert/, /reusable_ids/, /Effects: .*item DELETE none/,
        /Action notify \(.*effects: external\)/, /Parameters \(-P name=value\): with string required, ids integer list/, /Returns its own result/,
        /^\s+reviews\.rating\s.*some/m]) check(re.test(ev.stdout), `describe events: ${re}`, ev);
      check(!/^\s+formats\s+string/m.test(ev.stdout) && /does not know \(not used, §4\.2\): formats/.test(ev.stdout), 'a filter with an unknown quantifier is not used', ev);
      const f = await run([V7, 'describe', 'files']);
      ok(f); check(/cannot be listed/.test(f.stdout) && /Upload \(create --file\): image\/\*, application\/pdf · up to 100 bytes/.test(f.stdout), 'files', f);
      const i = await run([V7, 'describe', 'isbns']);
      ok(i); check(/Required filters .*: isbn/.test(i.stdout), 'isbns', i);
    });
    await test('filters: nin, prefix, contains, localdatetime, timezone, durations and quantifier (§3, §6.1)', async () => {
      const good = [['id[nin]=a,b', 'filter%5Bid%5D%5Bnin%5D=a%2Cb'], ['title[prefix]=La', 'title%5D%5Bprefix%5D=La'], ['title[contains]=x', 'contains'],
        ['starts>=2027-03-30T19:00:00', 'starts%5D%5Bge%5D=2027-03-30T19%3A00%3A00'], ['zone=Europe/Madrid', 'Europe%2FMadrid'], ['len<=PT1.5S', 'PT1.5S'],
        ['len<=pt90m', 'pt90m'], ['reviews.rating>=4', 'rating%5D%5Bge%5D=4']];
      for (const [fl, want] of good) {
        const r = await run([V7, 'get', 'events', '-f', fl, '--curl']);
        ok(r, `-f ${fl}`); check(r.stdout.includes(want), `-f ${fl}: ${want}`, r);
      }
      for (const fl of ['title[prefix]=', 'starts>=2027-03-30T19:00:00Z', 'len<=P1M', 'len<=PT1.1234567891S', 'formats=pdf', 'id[nin]=a,,b'])
        exit(await run([V7, 'get', 'events', '-f', fl]), 3);
    });
    await test('default filters: --all without -f is a full copy; -f name=false turns one off (§5.2, §6.1)', async () => {
      const a = await run([V7, 'get', 'events', '--all', '--curl']);
      ok(a); check(a.stdout.includes('filter%5Bactive%5D=false') && /full copy/.test(a.stderr), 'full copy', a);
      const k = await run([V7, 'get', 'events', '--all', '-f', 'active', '--curl']);
      ok(k); check(!k.stdout.includes('=false'), 'with -f it is not a full copy', k);
      const off = await run([V7, 'get', 'events', '-f', 'active=false', '--curl']);
      ok(off); check(off.stdout.includes('filter%5Bactive%5D=false'), 'turned off', off);
      exit(await run([V7, 'get', 'events', '-f', 'featured=false']), 3);
      const one = await run([V7, 'get', 'events', '--curl']);
      ok(one); check(!one.stdout.includes('active'), 'a page does not turn it off', one);
    });
    await test('a required filter goes in every list (§6.1)', async () => {
      const r = await run([V7, 'get', 'isbns']);
      exit(r, 3); check(/requires the filter isbn/.test(r.stderr), 'message', r);
      ok(await run([V7, 'get', 'isbns', '-f', 'isbn=978', '--curl']));
    });
    await test('a localized field is sent and the server decides (§5.1), and the language received is shown (§3, §5.6)', async () => {
      const c = await run([V7, 'create', 'events', '-d', '{"id":"e1","name":"Fiesta"}', '-o', 'json']);
      ok(c); check(c.json().echo.method === 'POST', 'create sent', c);
      ok(await run([V7, 'update', 'events', 'e1', '-d', '{"name":"Fiesta"}']), 'update sent');
      const g = await run([V7, 'get', 'events']);
      ok(g); check(/\(language: es-es\)/.test(g.stderr), 'language', g);
    });
    await test('upsert: update creates; --create-only sends If-None-Match: * (§5.1)', async () => {
      const u = await run([V7, 'update', 'events', 'e1', '-d', '{"title":"Fiesta"}', '--create-only', '-o', 'json']);
      ok(u); check(u.json().echo.inm === '*' && /created/.test(u.stderr), 'create-only', u);
      exit(await run([`${MOCK}/d6/`, 'update', 'pages', '1', '-d', '{}', '--create-only']), 3);
    });
    await test('upload with --file: type, name, size and declared media types (§5.1)', async () => {
      const png = join(tmp, 'portada ñ.png'), txt = join(tmp, 'nota.txt'), big = join(tmp, 'big.pdf'), bin = join(tmp, 'doc.bin');
      writeFileSync(png, 'not really a png'); writeFileSync(txt, 'hola'); writeFileSync(big, 'x'.repeat(101)); writeFileSync(bin, '%PDF');
      const u = await run([V7, 'create', 'files', '--file', png, '-o', 'json']);
      ok(u); const h = u.json().echo;
      check(h.type === 'image/png' && h.size === 16 && /filename="portada _.png"; filename\*=UTF-8''portada%20%C3%B1\.png/.test(h.disposition) && h.key, 'upload', u);
      const t = await run([V7, 'create', 'files', '--file', txt]);
      exit(t, 3); check(/does not accept text\/plain/.test(t.stderr), 'media type', t);
      const b = await run([V7, 'create', 'files', '--file', big]);
      exit(b, 3); check(/at most 100/.test(b.stderr), 'max_size', b);
      const o = await run([V7, 'create', 'files', '--file', bin, '--type', 'application/pdf', '-o', 'json']);
      ok(o); check(o.json().echo.type === 'application/pdf', '--type', o);
      exit(await run([V7, 'create', 'events', '--file', png]), 3);
      exit(await run([V7, 'create', 'files', '--file', png, '-d', '{}']), 2);
    });
    await test('params of a GET action: in the query, declared, required and typed (§11.1)', async () => {
      const r = await run([V7, 'action', 'events', 'e1', 'compare', '-P', 'with=2', '-P', 'ids=1,2', '-o', 'json']);
      ok(r); check(r.json().echo.url === '/v7/events/e1:compare?with=2&ids=1%2C2', 'query', r);
      for (const args of [['-P', 'ids=1'], ['-P', 'with=2', '-P', 'x=1'], ['-P', 'with=2', '-P', 'ids=1,a'], ['-P', 'with=2', '-P', 'with=3']])
        exit(await run([V7, 'action', 'events', 'e1', 'compare', ...args]), 3);
      exit(await run([V7, 'action', 'events', 'e1', 'notify', '-P', 'a=1']), 2);
    });
    await test('effects: asks before an operation with effects, never before one without (§11.1)', async () => {
      const env = { RESTEP_CONFIRM: 'always' };
      const n = await run([V7, 'action', 'events', 'e1', 'notify'], { env, input: 'n\n' });
      exit(n, 3); check(/effects external/.test(n.stderr) && /Cancelled/.test(n.stderr), 'asked and cancelled', n);
      ok(await run([V7, 'action', 'events', 'e1', 'notify'], { env, input: 'y\n' }), 'answered yes');
      ok(await run([V7, 'action', 'events', 'e1', 'notify', '--yes'], { env }), '--yes');
      const d = await run([V7, 'delete', 'events', 'e1'], { env });
      ok(d, 'DELETE declared with [] asks nothing'); check(!/Continue/.test(d.stderr), 'no question', d);
      const c = await run([V7, 'create', 'events', '-d', '{"id":"e2"}'], { env, input: 'n\n' });
      exit(c, 3); check(/effects destroys, external, charges/.test(c.stderr), 'an undeclared POST has all three', c);
      ok(await run([V7, 'action', 'events', 'e1', 'notify']), 'without a terminal it does not ask');
      // 11.1: a safe action without effects has none; one that declares charges, or an unknown value, is asked.
      const s = await run([V7, 'action', 'events', 'e1', 'compare', '-P', 'with=2'], { env });
      ok(s, 'a safe action without effects asks nothing'); check(!/Continue/.test(s.stderr), 'no question', s);
      const q = await run([V7, 'action', 'events', 'e1', 'quote'], { env, input: 'n\n' });
      exit(q, 3); check(/effects charges/.test(q.stderr), 'charges asked', q);
      const p = await run([V7, 'action', 'events', 'e1', 'peek'], { env, input: 'n\n' });
      exit(p, 3); check(/effects destroys, external, charges/.test(p.stderr), 'an unknown value counts as all three', p);
    });
    await test('null without quantifier on a to-many relationship or a list field is accepted and offered (§6.1)', async () => {
      for (const fl of ['reviews[null]=true', 'labels[null]=false']) {
        const r = await run([V7, 'get', 'events', '-f', fl, '--curl']);
        ok(r, `-f ${fl}`); check(r.stdout.includes('%5Bnull%5D='), `-f ${fl}`, r);
      }
      exit(await run([V7, 'get', 'events', '-f', 'reviews=x']), 3);
      const d = await run([V7, 'describe', 'events']);
      ok(d); check(/reviews/.test(d.stdout) && /labels/.test(d.stdout) && !/not use[d]?[^\n]*reviews/.test(d.stdout), 'describe lists them', d);
      const c = (await run(['__complete', '--', V7, 'get', 'events', '-f', ''])).stdout.split('\n');
      check(c.includes('reviews[null]=') && c.includes('labels[null]='), `completion: ${c.join(' ')}`);
      const v = (await run(['__complete', '--', V7, 'get', 'events', '-f', 'reviews[null]='])).stdout.trim().split('\n');
      check(v.includes('reviews[null]=true') && v.includes('reviews[null]=false'), `values: ${v.join(' ')}`);
    });
    await test('an integer operand with no fractional part is valid: 20.0 is 20; 20.5 is not (§6.1)', async () => {
      for (const fl of ['pages=20.0', 'pages>=20', 'pages[in]=1,2.00,3e1', 'pages=-0.0'])
        ok(await run([V7, 'get', 'events', '-f', fl, '--curl']), `-f ${fl}`);
      for (const fl of ['pages=20.5', 'pages[in]=1,2.5', 'pages=2e-1', 'pages=x']) {
        const r = await run([V7, 'get', 'events', '-f', fl]);
        exit(r, 3); check(/not an integer/.test(r.stderr), `-f ${fl}`, r);
      }
    });
    await test('a GET action without params takes no query parameter (§5.3, §11.1)', async () => {
      ok(await run([V7, 'action', 'events', 'e1', 'ping', '--curl']));
      const r = await run([V7, 'action', 'events', 'e1', 'ping', '-P', 'x=1']);
      exit(r, 3); check(/takes no parameters/.test(r.stderr), 'message', r);
    });
    await test('a singleton\'s PATCH: method_effects asks; [] asks nothing; undeclared is all three (§4.3, §5.9)', async () => {
      const env = { RESTEP_CONFIRM: 'always' };
      const p = await run([V7, 'update', 'prefs', '-d', '{"theme":"dark"}'], { env, input: 'n\n' });
      exit(p, 3); check(/effects external\b/.test(p.stderr) && !/destroys/.test(p.stderr), 'declared external', p);
      const q = await run([V7, 'update', 'quiet', '-d', '{"theme":"dark"}'], { env });
      ok(q); check(!/Continue/.test(q.stderr), 'no question', q);
      const l = await run([V7, 'update', 'loud', '-d', '{"theme":"dark"}'], { env, input: 'n\n' });
      exit(l, 3); check(/effects destroys, external, charges/.test(l.stderr), 'undeclared: all three', l);
      const d = await run([V7, 'describe', 'prefs']);
      ok(d); check(/Effects: PATCH external/.test(d.stdout), 'describe', d);
      const dl = await run([V7, 'describe', 'loud']);
      ok(dl); check(/Effects: PATCH destroys\+external\+charges \(undeclared: all three\)/.test(dl.stdout), 'describe undeclared', dl);
    });
    await test('a 415 shows Accept-Post (§5.1)', async () => {
      const r = await run([V7, 'create', 'files', '-d', '{"name":"x"}', '--raw']);
      check(r.code !== 0 && /415/.test(r.stderr) && /accepts here: image\/\*, application\/pdf \(send a file with --file\)/.test(r.stderr), 'hint', r);
    });
    await test('council round 3: numbers of RFC 8259, no leap second, null alone with some, upload and create, a replay without ETag', async () => {
      // 7 (§6.1, §11.1): integer and number operands, and a GET action's params, follow RFC 8259 with exponent.
      for (const fl of ['pages>=2e1', 'pages>=250e-1', 'pages>=-0', 'weight>=-0.5E+1', 'weight>=0.5']) ok(await run([V7, 'get', 'events', '-f', fl, '--curl']), `-f ${fl}`);
      for (const fl of ['pages>=020', 'pages>=+20', 'pages>=.5', 'pages>=0x14', 'pages>=25e-1', 'weight>=020', 'weight>=+20', 'weight>=.5', 'weight>=0x14', 'weight>=1e']) {
        const r = await run([V7, 'get', 'events', '-f', fl]);
        exit(r, 3); check(/RFC 8259|integer/.test(r.stderr), `-f ${fl}`, r);
      }
      ok(await run([V7, 'action', 'events', 'e1', 'compare', '-P', 'with=2', '-P', 'ids=2e1,3', '--curl']), 'params 2e1');
      for (const ids of ['020', '1,+2', '0x14', '1.5']) exit(await run([V7, 'action', 'events', 'e1', 'compare', '-P', 'with=2', '-P', `ids=${ids}`]), 3);
      // 3 (§3): a local date-time has no leap second.
      exit(await run([V7, 'get', 'events', '-f', 'starts>=2016-12-31T23:59:60']), 3);
      // 8 (§6.1): null alone on a group, with or without "quantifier": "some".
      const n = await run([V7, 'get', 'events', '-f', 'tags[null]=true', '-f', 'labels[null]=true', '--curl']);
      ok(n); check(n.stdout.includes('filter%5Btags%5D%5Bnull%5D=true') && n.stdout.includes('filter%5Blabels%5D%5Bnull%5D=true'), 'null with and without some', n);
      // 1 (§5.1): upload without create takes only files.
      const j = await run([V7, 'create', 'files', '-d', '{"name":"x"}']);
      exit(j, 3); check(/only files/.test(j.stderr) && /--file/.test(j.stderr), 'upload-only', j);
      const df = await run([V7, 'describe', 'files']), dd = await run([V7, 'describe', 'docs']);
      check(/only files, no JSON create/.test(df.stdout) && /multipart · also creates from JSON/.test(dd.stdout), 'describe', dd);
      // 2 (§5.1): with both, JSON is a creation and a JSON file goes as the file part of multipart/form-data.
      const c = await run([V7, 'create', 'docs', '-d', '{"title":"x"}', '-o', 'json']);
      ok(c); check(c.json().echo.type === 'application/json', 'JSON create', c);
      const jf = join(tmp, 'a "b".json'), tf = join(tmp, 'nota.txt');
      writeFileSync(jf, '{"a":1}'); writeFileSync(tf, 'hola');
      const u = await run([V7, 'create', 'docs', '--file', jf, '-o', 'json']);
      ok(u); const e = u.json().echo, boundary = /^multipart\/form-data; boundary=(.+)$/.exec(e.type)?.[1];
      check(boundary && e.disposition === null && e.body === `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a %22b%22.json"\r\n`
        + `Content-Type: application/json\r\n\r\n{"a":1}\r\n--${boundary}--\r\n`, 'multipart', u);
      const t = await run([V7, 'create', 'docs', '--file', tf, '-o', 'json']);
      ok(t); check(t.json().echo.type === 'text/plain' && t.json().echo.body === 'hola', 'another file goes as its bytes', t);
      const cu = await run([V7, 'create', 'docs', '--file', jf, '--curl']);
      ok(cu); check(/ -F 'file=@.*;type=application\/json'/.test(cu.stdout) && !/content-type/i.test(cu.stdout), 'curl -F', cu);
      const s = await run([V7, 'create', 'sheets', '--file', jf]);
      exit(s, 3); check(/does not declare multipart/.test(s.stderr), 'no multipart', s);
      // 5 (§7.3): a replayed 201 without body carries no ETag: read the item at Location.
      const r = await run([V7, 'create', 'replays', '-d', '{}']);
      ok(r); check(/no ETag in a replay without body: read the item at \/v7\/replays\/r1/.test(r.stderr), 'replay', r);
    });
    await test('council round 4: JSON files in upload-only collections, +json, multipart only where declared, filename, one null per group', async () => {
      const jf = join(tmp, 'r4.json'), lf = join(tmp, 'r4.jsonld'), mf = join(tmp, 'r4.form');
      writeFileSync(jf, '{"a":1}'); writeFileSync(lf, '{"@id":"x"}'); writeFileSync(mf, '--x--');
      // 1a, 4a (§5.1): in an upload-only collection whose media_types admit application/json, also by
      // */*, a JSON file goes as its bytes, never as multipart.
      const b = await run([V7, 'create', 'blobs', '--file', jf, '-o', 'json']);
      ok(b); check(b.json().echo.type === 'application/json' && b.json().echo.body === '{"a":1}', 'JSON file as bytes', b);
      // 1b (§5.1): a +json type is a file like any other, also beside create.
      const l = await run([V7, 'create', 'sheets', '--file', lf, '--type', 'application/ld+json', '-o', 'json']);
      ok(l); check(l.json().echo.type === 'application/ld+json', '+json as bytes', l);
      // 2 (§5.1): multipart/form-data never goes to a collection without upload.multipart, even with --raw.
      for (const extra of [[], ['--raw']]) {
        const m = await run([V7, 'create', 'blobs', '--file', mf, '--type', 'multipart/form-data', ...extra]);
        exit(m, 3); check(/does not declare multipart/.test(m.stderr), `multipart ${extra}`, m);
      }
      // 4b (§5.1): the file part always carries a filename: the CLI sends the file's own name.
      const u = await run([V7, 'create', 'docs', '--file', jf, '-o', 'json']);
      ok(u); check(/; filename="r4\.json"\r\n/.test(u.json().echo.body), 'filename', u);
      // 5a (§6.1): two null filters on the same to-many relationship, its own or a path's, even when they agree.
      for (const v of ['true', 'false']) {
        const r = await run([V7, 'get', 'events', '-f', 'reviews[null]=true', '-f', `reviews.id[null]=${v}`]);
        exit(r, 3); check(/only one null filter on reviews/.test(r.stderr), `two nulls ${v}`, r);
      }
      ok(await run([V7, 'get', 'events', '-f', 'reviews.id[null]=true', '-f', 'tags[null]=true', '-f', 'labels[null]=true', '--curl']), 'nulls on different groups');
      // 6 (§6.1): a huge operand goes as it is, never as an infinity or zero.
      const h = await run([V7, 'get', 'events', '-f', 'pages>=1e400', '-f', 'weight>=-1e400', '--curl']);
      ok(h); check(h.stdout.includes('filter%5Bpages%5D%5Bge%5D=1e400') && h.stdout.includes('filter%5Bweight%5D%5Bge%5D=-1e400'), 'huge operands', h);
    });
    await test('retries: with the key only within idempotency.ttl; DELETE with reusable_ids only with If-Match (§5.7, §5.1)', async () => {
      const s = await run([V7, 'create', 'slow', '-d', '{}', '--retry', '3']);
      exit(s, 11); check(/idempotency\.ttl/.test(s.stderr), 'message', s);
      const d = await run([V7, 'delete', 'events', 'gone', '--retry', '2']);
      exit(d, 11);
      const m = await run([V7, 'delete', 'events', 'gone', '--retry', '2', '--if-match', 'x']);
      exit(m, 11);
      const counts = await (await fetch(`${MOCK}/v7/count`)).json();
      check(counts['/v7/slow'] === 1 && counts['/v7/events/gone'] === 4, `attempts: ${JSON.stringify(counts)}`);
    });
    await test('singleton under an item: get, update and action with --parent (§5.9)', async () => {
      const g = await run([`${MOCK}/d6/`, 'get', 'settings', '-p', '7']);
      ok(g); check(g.json().echo.url === '/d6/things/7/settings', 'get', g);
      exit(await run([`${MOCK}/d6/`, 'get', 'settings']), 2);
      exit(await run([`${MOCK}/d6/`, 'get', 'prefs', '-p', '7']), 2);
      const a = await run([`${MOCK}/d6/`, 'action', 'settings', 'reset', '-p', '7']);
      ok(a); check(a.json().echo.url === '/d6/things/7/settings:reset', 'action', a);
      exit(await run([`${MOCK}/d6/`, 'action', 'settings', '7', 'reset']), 2);
    });
    await test('discovery: an error other than 404 is not core only; the first service-desc of Restep 1 (§4.2)', async () => {
      const e = await run([`${MOCK}/e400/`, 'get', 'books']);
      exit(e, 5); check(/Error 400/.test(e.stderr), 'message', e);
      const s = await run([`${MOCK}/sd/`, 'describe']);
      ok(s); check(/things/.test(s.stdout), 'second service-desc', s);
    });
    await test('reference: new collections of draft 7', async () => {
      const p = await run([REF, 'get', 'payments']);
      exit(p, 3); check(/does not support GET/.test(p.stderr), 'payments without GET', p);
      const o = await run([REF, 'get', 'orders', '--all', '--curl']);
      ok(o); check(o.stdout.includes('filter%5Bactive%5D=false'), 'orders full copy', o);
      const all = await run([REF, 'get', 'orders', '--all', '-o', 'json']);
      const page = await run([REF, 'get', 'orders', '--all', '-f', 'active', '-o', 'json']);
      ok(all); ok(page); check(all.json().items.length >= page.json().items.length, 'the full copy has the archived orders too', all);
      const st = await run([REF, 'get', 'settings', '-p', '1']);
      check(st.code === 0 || st.code === 7, 'child singleton of the reference', st);
    });

    console.log('completion');
    await test('zsh and bash scripts', async () => {
      const z = await run(['completion', 'zsh']);
      ok(z); check(/compdef _restep restep/.test(z.stdout) && /restep __complete/.test(z.stdout), 'zsh', z);
      const b = await run(['completion', 'bash']);
      ok(b); check(/complete -F _restep restep/.test(b.stdout), 'bash', b);
    });
    await test('commands, aliases and collections', async () => {
      check((await comp('')).includes('@tienda'), 'alias');
      check((await comp(REF, '')).includes('describe'), 'commands');
      // Draft 6: get also completes standalone resources (§5.9).
      // Collections and standalone resources are read from the reference's discovery, which grows.
      const refDoc = await (await fetch(`${REF}/`)).json();
      const want = [...Object.keys(refDoc.collections), ...Object.keys(refDoc.singletons ?? {})].join();
      check((await comp(REF, 'get', '')).join() === want, `collections and singletons (${want})`);
      check((await comp('@tienda', 'get', '')).includes('books'), 'collections with an alias');
    });
    await test('filters, enum values, sort and fields', async () => {
      const f = await comp(REF, 'get', 'books', '--filter', '');
      check(f.includes('category=') && f.includes('price[le]=') && f.includes('title[prefix]=') && f.includes('title[nin]='), `filters: ${f}`);
      const v = await comp(REF, 'get', 'books', '-f', 'category=');
      check(v.includes('category=novela-negra') && v.includes('category=poesia'), `values: ${v}`);
      const l = await comp(REF, 'get', 'books', '-f', 'category[in]=poesia,');
      check(l.includes('category[in]=poesia,ensayo') && !l.includes('category[in]=poesia,poesia'), `in: ${l}`);
      const s = await comp(REF, 'get', 'books', '--sort', '-price,');
      check(s.includes('-price,title') && s.includes('-price,-rating') && !s.includes('-price,price'), `sort: ${s}`);
      const c = await comp(REF, 'get', 'books', '--fields', '');
      check(c.includes('title') && c.includes('category'), `fields: ${c}`);
      const o = await comp(REF, 'get', 'books', '--fo');
      check(o.includes('--format'), 'options');
      const fm = await comp(REF, 'get', 'books', '--format', '');
      check(fm.join() === 'json,ndjson,csv,table', 'formats');
    });
    await test('actions and bash line', async () => {
      check((await comp(MOCK, 'action', 'orders', '')).join() === 'import', 'collection actions');
      check((await comp(MOCK, 'action', 'orders', '2001', '')).join() === 'cancel,preview', 'item actions');
      const r = await run(['__complete', '--line', `restep ${REF} get books --sort `]);
      check(r.stdout.split('\n').includes('-rating'), 'bash line', r);
    });
  } finally {
    for (const p of procs) p.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[2] !== '--mock') await main();
