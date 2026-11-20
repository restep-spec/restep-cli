// Pruebas de restep (la CLI) contra el servidor de referencia y un servidor simulado.
// Desde restep/:  node tools/restep-cli/test.mjs
// Puertos: 8850 servidor de referencia, 8851 el mismo con RESTEP_TOKEN (oauth), 8852 servidor
// simulado (acciones, subcolecciones, service-desc y reintentos), 8859 nada (error de red).
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

// ── Servidor simulado: lo que el de referencia no tiene ─────────────────────
if (process.argv[2] === '--mock') {
  let flaky = 0;
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
    const echo = { method: req.method, url: req.url, key: req.headers['idempotency-key'] ?? null, body: body ? JSON.parse(body) : null };
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
  }).listen(8852, () => console.log('listo'));
}

// ── Utilidades ──────────────────────────────────────────────────────────────
function start(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cmd, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.once('data', () => resolve(p));
    p.once('exit', (c) => reject(new Error(`${cmd} terminó con ${c}`)));
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
  try { await fn(); passed++; console.log(`  bien  ${name}`); }
  catch (e) { failed++; console.log(`  MAL   ${name}\n        ${e.message.replace(/\n/g, '\n        ')}`); }
}
function check(cond, msg, r) {
  if (!cond) throw new Error(`${msg}${r ? `\n código ${r.code}\n stdout: ${r.stdout.slice(0, 600)}\n stderr: ${r.stderr.slice(0, 600)}` : ''}`);
}
const ok = (r, msg = 'debería salir con 0') => check(r.code === 0, msg, r);
const exit = (r, code) => check(r.code === code, `debería salir con ${code}`, r);

// ── Pruebas ─────────────────────────────────────────────────────────────────
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
    await test('describe lista colecciones y perfiles', async () => {
      const r = await run([REF, 'describe']);
      ok(r);
      check(/books/.test(r.stdout) && /categories/.test(r.stdout) && /core, query, writes/.test(r.stdout), 'faltan colecciones o perfiles', r);
    });
    await test('sin orden, describe', async () => {
      const r = await run([REF]);
      ok(r); check(/products/.test(r.stdout), 'no describe', r);
    });
    await test('describe de una colección: filtros, orden, campos', async () => {
      const r = await run([REF, 'describe', 'books']);
      ok(r);
      check(/category\s+enum\s+eq, ne, in\s+novela-negra/.test(r.stdout), 'faltan filtros', r);
      check(/Orden: id, title, price, rating, year/.test(r.stdout) && /Obligatorios al crear: title, price/.test(r.stdout), 'faltan orden u obligatorios', r);
    });
    await test('describe --format json', async () => {
      const r = await run([REF, 'describe', 'products', '--format', 'json']);
      ok(r); check(r.json().path === '/products' && r.json().language_maps.name, 'no es la declaración', r);
    });
    await test('describe de colección inexistente sugiere', async () => {
      const r = await run([REF, 'describe', 'bokos']);
      exit(r, 3); check(/¿Quisiste decir «books»\?/.test(r.stderr), 'sin sugerencia', r);
    });
    await test('la caché guarda el descubrimiento y se salta con --no-cache', async () => {
      check(readdirSync(cache).some((f) => f.endsWith('.json')), 'no hay archivo de caché');
      const a = await run([REF, 'get', 'books', '7', '-v']);
      ok(a); check(!/\(descubrimiento\)/.test(a.stderr), 'pide el descubrimiento pese a la caché', a);
      const b = await run([REF, 'get', 'books', '7', '-v', '--no-cache']);
      ok(b); check(/> GET http:\/\/localhost:8850\/ {2}\(descubrimiento\)/.test(b.stderr), 'no vuelve a pedirlo', b);
    });

    console.log('get: consulta');
    await test('lista la colección (json)', async () => {
      const r = await run([REF, 'get', 'books']);
      ok(r); check(r.json().items.length === 7 && r.json().next === null, 'no son los 7 libros', r);
    });
    await test('--filter igual, símbolos y [op]', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'category=novela-negra', '--filter', 'price<=17', '-f', 'year[ge]=2023']);
      ok(r);
      const ids = r.json().items.map((i) => i.id);
      check(ids.join() === '12', `esperaba solo 12, no ${ids}`, r);
    });
    await test('--filter in y !=', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'category[in]=poesia,ensayo']);
      ok(r); check(r.json().items.length === 2, 'in no filtra', r);
      const n = await run([REF, 'get', 'books', '-f', 'category!=novela-negra']);
      ok(n); check(n.json().items.length === 4, 'ne no filtra', n);
    });
    await test('filtro inexistente: error local con sugerencia', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'categry=poesia']);
      exit(r, 3); check(/¿Quisiste decir «category»\?/.test(r.stderr) && /--raw/.test(r.stderr), 'sin sugerencia', r);
    });
    await test('--raw envía igual y muestra el problem+json legible', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'categry=poesia', '--raw']);
      exit(r, 5);
      check(/Error 400 unsupported_parameter/.test(r.stderr) && /Parámetro: filter\[categry\]/.test(r.stderr), 'problema mal mostrado', r);
      check(/Pista: filtros de «books»: id \(eq, in\)/.test(r.stderr), 'sin pista de filtros', r);
    });
    await test('--format json con error: el problem tal cual en stdout', async () => {
      const r = await run([REF, 'get', 'books', '-f', 'categry=poesia', '--raw', '-o', 'json']);
      exit(r, 5); check(r.json().code === 'unsupported_parameter', 'no está en stdout', r);
    });
    await test('operador no declarado y valores de tipo erróneo', async () => {
      const a = await run([REF, 'get', 'books', '-f', 'price!=10']);
      exit(a, 3); check(/no admite el operador ne/.test(a.stderr) && /eq, lt, le, gt, ge/.test(a.stderr), 'operador', a);
      const b = await run([REF, 'get', 'books', '-f', 'year>abc']);
      exit(b, 3); check(/no es un entero/.test(b.stderr), 'entero', b);
      const c = await run([REF, 'get', 'books', '-f', 'category=novela']);
      exit(c, 3); check(/«novela-negra»/.test(c.stderr), 'enum', c);
      const d = await run([REF, 'get', 'books', '-f', 'rating[null]=si']);
      exit(d, 3); check(/true o false/.test(d.stderr), 'null', d);
      const e = await run([REF, 'get', 'books', '-f', 'price=1', '-f', 'price[eq]=2']);
      exit(e, 3); check(/dos veces/.test(e.stderr), 'repetido', e);
      const f = await run([REF, 'get', 'books', '-f', 'price']);
      exit(f, 2);
    });
    await test('--sort y orden inexistente', async () => {
      const r = await run([REF, 'get', 'books', '--sort', '-price']);
      ok(r); check(r.json().items[0].id === '23', 'no ordena por precio descendente', r);
      const e = await run([REF, 'get', 'books', '-s', 'ratin']);
      exit(e, 3); check(/¿Quisiste decir «rating»\?/.test(e.stderr), 'sin sugerencia', e);
    });
    await test('--fields en lista y en elemento; campo inexistente', async () => {
      const r = await run([REF, 'get', 'books', '--fields', 'title,price']);
      ok(r); check(Object.keys(r.json().items[0]).sort().join() === 'id,price,title', 'campos', r);
      const i = await run([REF, 'get', 'books', '7', '--fields', 'title']);
      ok(i); check(i.json().title && !i.json().price && i.json()._etag, 'campos del elemento', i);
      const e = await run([REF, 'get', 'books', '--fields', 'titel']);
      exit(e, 3); check(/«title»/.test(e.stderr), 'sin sugerencia', e);
      const m = await run([REF, 'get', 'products', '--fields', 'name.es']);
      exit(m, 3); check(/mapa de idioma/.test(m.stderr), 'mapa de idioma', m);
    });
    await test('--limit, --all recorre next, límite fuera de rango', async () => {
      const r = await run([REF, 'get', 'books', '--limit', '2']);
      ok(r); check(r.json().items.length === 2 && r.json().next, 'página de 2', r);
      const all = await run([REF, 'get', 'books', '--limit', '2', '--all']);
      ok(all); check(all.json().items.length === 7 && new Set(all.json().items.map((i) => i.id)).size === 7, '--all no trae los 7', all);
      const e = await run([REF, 'get', 'books', '--limit', '99']);
      exit(e, 3); check(/máximo de «books», 50/.test(e.stderr), 'max_limit', e);
    });
    await test('--count', async () => {
      const r = await run([REF, 'get', 'books', '--count']);
      ok(r); check(r.stdout.trim() === '7', 'total', r);
      const f = await run([REF, 'get', 'books', '--count', '-f', 'category=novela-negra', '-o', 'json']);
      ok(f); check(f.json().total === 3, 'total filtrado', f);
    });
    await test('formatos ndjson, csv y table', async () => {
      const n = await run([REF, 'get', 'books', '-o', 'ndjson', '--all', '-n', '3']);
      ok(n); check(n.stdout.trim().split('\n').length === 7 && JSON.parse(n.stdout.split('\n')[0]).id, 'ndjson', n);
      const c = await run([REF, 'get', 'books', '-o', 'csv', '--fields', 'title,price']);
      ok(c); check(c.stdout.split('\n')[0] === 'id,title,price' && /^7,La niebla de Portugalete,18.50$/m.test(c.stdout), 'csv', c);
      const t = await run([REF, 'get', 'books', '-o', 'table', '-f', 'category=poesia']);
      ok(t); check(/^id\s+title\s+price/.test(t.stdout) && /Cuaderno de faros/.test(t.stdout), 'table', t);
      const e = await run([REF, 'get', 'books', '-o', 'yaml']);
      exit(e, 2);
    });
    await test('get de un elemento y 404', async () => {
      const r = await run([REF, 'get', 'books', '7']);
      ok(r); check(r.json().title === 'La niebla de Portugalete', 'elemento', r);
      const e = await run([REF, 'get', 'books', '999']);
      exit(e, 7); check(/Error 404 not_found/.test(e.stderr), '404', e);
    });

    console.log('escrituras');
    let id;
    await test('create con --data e Idempotency-Key automática', async () => {
      const r = await run([REF, 'create', 'books', '--data', '{"title":"Nuevo","price":"10.00"}', '-v']);
      ok(r); id = r.json().id;
      check(id && /> idempotency-key: "[0-9a-f-]{36}"/.test(r.stderr) && /< 201 Created/.test(r.stderr), 'sin clave o sin 201', r);
    });
    await test('create con @archivo y con - (entrada estándar)', async () => {
      const file = join(tmp, 'libro.json');
      writeFileSync(file, '{"title":"De archivo","price":"5.00"}');
      const a = await run([REF, 'create', 'books', '-d', `@${file}`]);
      ok(a); check(a.json().title === 'De archivo', 'archivo', a);
      const b = await run([REF, 'create', 'books', '-d', '-'], { input: '{"title":"De stdin","price":"6.00"}' });
      ok(b); check(b.json().title === 'De stdin', 'stdin', b);
    });
    await test('la misma --idempotency-key repite sin duplicar; con otro cuerpo, 422', async () => {
      const args = [REF, 'create', 'books', '-d', '{"title":"Una vez","price":"1.00"}', '--idempotency-key', 'clave-1'];
      const a = await run(args), b = await run(args);
      ok(a); ok(b);
      check(a.json().id === b.json().id && /repetición/.test(b.stderr), 'no es repetición', b);
      const c = await run([REF, 'create', 'books', '-d', '{"title":"Otra","price":"1.00"}', '--idempotency-key', 'clave-1']);
      exit(c, 9); check(/idempotency_mismatch/.test(c.stderr), 'mismatch', c);
    });
    await test('cuerpo validado contra schemas.create; --raw envía igual', async () => {
      const a = await run([REF, 'create', 'books', '-d', '{"title":"Sin precio"}']);
      exit(a, 3); check(/\/price \(required\)/.test(a.stderr), 'required', a);
      const b = await run([REF, 'create', 'books', '-d', '{"title":"X","price":18}']);
      exit(b, 3); check(/\/price \(type\)/.test(b.stderr), 'type', b);
      const c = await run([REF, 'create', 'books', '-d', '{"title":"X","price":"1","isbn":"1"}']);
      exit(c, 3); check(/\/isbn \(unknown\)/.test(c.stderr), 'unknown', c);
      const d = await run([REF, 'create', 'books', '-d', '{"title":"Sin precio"}', '--raw']);
      exit(d, 9); check(/Error 422 invalid/.test(d.stderr) && /- \/price \(required\)/.test(d.stderr), 'servidor', d);
      const e = await run([REF, 'create', 'books', '-d', '{nope']);
      exit(e, 2); check(/no es JSON válido/.test(e.stderr), 'json', e);
    });
    await test('--minimal: sin cuerpo, se muestran Location y ETag', async () => {
      const r = await run([REF, 'create', 'books', '-d', '{"title":"Mín","price":"1.00"}', '--minimal']);
      ok(r); check(r.json().status === 201 && /^\/books\/\d+$/.test(r.json().location) && r.json().etag, 'minimal', r);
    });
    await test('update con Merge Patch, --if-match y --safe', async () => {
      const a = await run([REF, 'update', 'books', id, '-d', '{"price":"12.00","rating":null}', '-v']);
      ok(a); check(a.json().price === '12.00' && /content-type: application\/merge-patch\+json/.test(a.stderr), 'patch', a);
      const b = await run([REF, 'update', 'books', id, '-d', '{"price":"13.00"}', '--if-match', 'viejo']);
      exit(b, 8); check(/412 precondition_failed/.test(b.stderr) && /--safe/.test(b.stderr), '412', b);
      const g = await run([REF, 'get', 'books', id, '-v']);
      const etag = /< etag: (.+)/.exec(g.stderr)[1];
      const c = await run([REF, 'update', 'books', id, '-d', '{"price":"13.00"}', '--if-match', etag.replace(/"/g, '')]);
      ok(c, '--if-match sin comillas debería valer'); check(c.json().price === '13.00', 'if-match', c);
      const d = await run([REF, 'update', 'books', id, '-d', '{"price":"14.00"}', '--safe', '-v']);
      ok(d); check(/> GET .*\/books\//.test(d.stderr) && /> if-match: "[0-9a-f]+"/.test(d.stderr) && d.json().price === '14.00', 'safe', d);
      const e = await run([REF, 'update', 'books', id, '-d', '{"id":"1"}']);
      exit(e, 3);
    });
    await test('pista de valor heredado (read_only)', async () => {
      const r = await run([REF, 'update', 'products', '1', '-d', '{"tax_rate":"3"}', '--raw']);
      exit(r, 9); check(/escribe «tax_rate_own»/.test(r.stderr), 'sin pista', r);
    });
    await test('delete con --safe y luego 404', async () => {
      const r = await run([REF, 'delete', 'books', id, '--safe']);
      ok(r);
      const g = await run([REF, 'get', 'books', id]);
      exit(g, 7);
    });
    await test('--curl imprime y no envía', async () => {
      const before = (await run([REF, 'get', 'books', '--count'])).stdout.trim();
      const r = await run([REF, 'create', 'books', '-d', '{"title":"Curl","price":"1.00"}', '--curl'], { env: { RESTEP_TOKEN: 'x' } });
      ok(r);
      check(/^curl -sS -X POST 'http:\/\/localhost:8850\/books' /.test(r.stdout) && /-H 'idempotency-key: "/.test(r.stdout)
        && /--data-raw '\{"title":"Curl","price":"1.00"\}'/.test(r.stdout) && /\$RESTEP_TOKEN/.test(r.stdout) && !/Bearer x/.test(r.stdout), 'curl', r);
      const after = (await run([REF, 'get', 'books', '--count'])).stdout.trim();
      check(before === after, `ha creado algo (${before} → ${after})`);
      const s = await run([REF, 'update', 'books', '7', '-d', '{"price":"1.00"}', '--safe', '--curl']);
      ok(s); check(/# --safe/.test(s.stdout) && /-X PATCH/.test(s.stdout), 'curl --safe', s);
      const q = await run([REF, 'get', 'books', '-f', 'price<=15', '--curl']);
      ok(q); check(q.stdout.includes("'http://localhost:8850/books?filter%5Bprice%5D%5Ble%5D=15'"), 'curl de consulta', q);
    });
    await test('métodos declarados: POST sobre un elemento no existe', async () => {
      const r = await run([MOCK, 'create', 'orders', '-d', '{}']);
      exit(r, 3); check(/no admite POST/.test(r.stderr), 'methods', r);
    });

    console.log('perfiles, token e idioma');
    await test('RESTEP_URL sin URL en la orden', async () => {
      const r = await run(['get', 'books', '7'], { env: { RESTEP_URL: REF } });
      ok(r); check(r.json().id === '7', 'env', r);
    });
    await test('alias @tienda con idioma; alias en cadena; alias desconocido', async () => {
      const r = await run(['@tienda', 'get', 'books', '999']);
      exit(r, 7); check(/No encontrado/.test(r.stderr) && /no existe/.test(r.stderr), 'no está en español', r);
      const c = await run(['@corta', 'get', 'books', '7']);
      ok(c);
      const u = await run(['@tiend', 'get', 'books']);
      exit(u, 2); check(/«tienda»/.test(u.stderr), 'sugerencia de alias', u);
    });
    await test('alias por defecto en el archivo de configuración', async () => {
      const file = join(tmp, 'config-default.json');
      writeFileSync(file, JSON.stringify({ default: 'tienda', aliases: { tienda: REF } }));
      const r = await run(['get', 'books', '7'], { env: { RESTEP_CONFIG: file } });
      ok(r); check(r.json().id === '7', 'default', r);
    });
    await test('RESTEP_LANGUAGE y --language', async () => {
      const r = await run([REF, 'get', 'books', '999'], { env: { RESTEP_LANGUAGE: 'es' } });
      exit(r, 7); check(/No encontrado/.test(r.stderr), 'env', r);
      const l = await run([REF, 'get', 'books', '999', '--language', 'es']);
      check(/No encontrado/.test(l.stderr), 'opción', l);
    });
    await test('sin URL: error de uso', async () => {
      const r = await run(['get', 'books']);
      exit(r, 2); check(/Falta la URL/.test(r.stderr), 'mensaje', r);
    });
    await test('token: 401 legible, RESTEP_TOKEN, --token y token_env del alias', async () => {
      const a = await run([AUTH, 'get', 'books']);
      exit(a, 6); check(/401 unauthenticated/.test(a.stderr) && /RESTEP_TOKEN/.test(a.stderr) && /oauth-protected-resource/.test(a.stderr), '401', a);
      const b = await run([AUTH, 'get', 'books', '--count'], { env: { RESTEP_TOKEN: 'secreto' } });
      ok(b); check(/^\d+$/.test(b.stdout.trim()), 'env', b);
      const c = await run([AUTH, 'get', 'books', '7', '--token', 'secreto', '-v']);
      ok(c); check(/authorization: Bearer \*\*\*\*/.test(c.stderr) && !c.stderr.includes('secreto'), 'el token se ve en verbose', c);
      const d = await run(['@privada', 'get', 'books', '7'], { env: { TOKEN_PRIVADA: 'secreto' } });
      ok(d);
      const e = await run([AUTH, 'get', 'books', '7', '--token', 'malo']);
      exit(e, 6); check(/el token no vale/.test(e.stderr), 'token malo', e);
    });

    console.log('acciones, subcolecciones, service-desc, reintentos');
    await test('descubrimiento por rel="service-desc"', async () => {
      const r = await run([MOCK, 'describe']);
      ok(r); check(/orders/.test(r.stdout) && /Extensiones: actions/.test(r.stdout), 'service-desc', r);
    });
    await test('acción de elemento con cuerpo e Idempotency-Key', async () => {
      const r = await run([MOCK, 'action', 'orders', '2001', 'cancel', '-d', '{"reason":"me equivoqué"}']);
      ok(r); const e = r.json().echo;
      check(e.method === 'POST' && e.url === '/orders/2001:cancel' && /^"[0-9a-f-]{36}"$/.test(e.key) && e.body.reason === 'me equivoqué', 'acción', r);
    });
    await test('acción: input validado, inexistente con sugerencia, on equivocado', async () => {
      const a = await run([MOCK, 'action', 'orders', '2001', 'cancel', '-d', '{"motivo":"x"}']);
      exit(a, 3); check(/\/motivo \(unknown\)/.test(a.stderr), 'input', a);
      const b = await run([MOCK, 'action', 'orders', '2001', 'cancle']);
      exit(b, 3); check(/¿Quisiste decir «cancel»\?/.test(b.stderr), 'sugerencia', b);
      const c = await run([MOCK, 'action', 'orders', 'cancel']);
      exit(c, 2); check(/acción de elemento/.test(c.stderr), 'on', c);
      const d = await run([REF, 'action', 'books', '7', 'reserve']);
      exit(d, 3); check(/extensión actions/.test(d.stderr), 'sin extensión', d);
    });
    await test('acción de colección (idempotente, sin clave) y acción GET', async () => {
      const a = await run([MOCK, 'action', 'orders', 'import', '-v']);
      ok(a); check(/> POST http:\/\/localhost:8852\/orders:import/.test(a.stderr) && !/idempotency-key/.test(a.stderr), 'colección', a);
      const b = await run([MOCK, 'action', 'orders', '2001', 'preview']);
      ok(b); check(b.json().echo.method === 'GET' && b.json().preview, 'GET', b);
    });
    await test('subcolección con --parent', async () => {
      const r = await run([MOCK, 'get', 'reviews', '--parent', '7', '--sort', 'id']);
      ok(r); check(r.json().echo.url === '/books/7/reviews?sort=id', 'ruta', r);
      const e = await run([MOCK, 'get', 'reviews']);
      exit(e, 2); check(/--parent/.test(e.stderr), 'falta padre', e);
    });
    await test('--retry reintenta un 503 con Retry-After', async () => {
      const r = await run([MOCK, 'get', 'flaky', '--retry', '2', '-v']);
      ok(r); check(/< 503/.test(r.stderr) && r.json().items[0].id === 'ok', 'retry', r);
    });
    await test('error de red: código 4', async () => {
      const r = await run(['http://localhost:8859', 'get', 'books']);
      exit(r, 4); check(/No se pudo conectar/.test(r.stderr), 'mensaje', r);
    });
    await test('orden y opción desconocidas: código 2 con sugerencia', async () => {
      const a = await run([REF, 'lsit', 'books']);
      exit(a, 2);
      const b = await run([REF, 'get', 'books', '--filtre', 'x=1']);
      exit(b, 2); check(/--filter/.test(b.stderr), 'sugerencia', b);
    });

    console.log('autocompletado');
    const comp = async (...words) => (await run(['__complete', '--', ...words])).stdout.trim().split('\n');
    await test('scripts de zsh y bash', async () => {
      const z = await run(['completion', 'zsh']);
      ok(z); check(/compdef _restep restep/.test(z.stdout) && /restep __complete/.test(z.stdout), 'zsh', z);
      const b = await run(['completion', 'bash']);
      ok(b); check(/complete -F _restep restep/.test(b.stdout), 'bash', b);
    });
    await test('órdenes, alias y colecciones', async () => {
      check((await comp('')).includes('@tienda'), 'alias');
      check((await comp(REF, '')).includes('describe'), 'órdenes');
      check((await comp(REF, 'get', '')).join() === 'books,products,categories', 'colecciones');
      check((await comp('@tienda', 'get', '')).includes('books'), 'colecciones con alias');
    });
    await test('filtros, valores de enum, orden y campos', async () => {
      const f = await comp(REF, 'get', 'books', '--filter', '');
      check(f.includes('category=') && f.includes('price[le]=') && !f.includes('title='), `filtros: ${f}`);
      const v = await comp(REF, 'get', 'books', '-f', 'category=');
      check(v.includes('category=novela-negra') && v.includes('category=poesia'), `valores: ${v}`);
      const l = await comp(REF, 'get', 'books', '-f', 'category[in]=poesia,');
      check(l.includes('category[in]=poesia,ensayo') && !l.includes('category[in]=poesia,poesia'), `in: ${l}`);
      const s = await comp(REF, 'get', 'books', '--sort', '-price,');
      check(s.includes('-price,title') && s.includes('-price,-rating') && !s.includes('-price,price'), `orden: ${s}`);
      const c = await comp(REF, 'get', 'books', '--fields', '');
      check(c.includes('title') && c.includes('category'), `campos: ${c}`);
      const o = await comp(REF, 'get', 'books', '--fo');
      check(o.includes('--format'), 'opciones');
      const fm = await comp(REF, 'get', 'books', '--format', '');
      check(fm.join() === 'json,ndjson,csv,table', 'formatos');
    });
    await test('acciones y línea de bash', async () => {
      check((await comp(MOCK, 'action', 'orders', '')).join() === 'import', 'acciones de colección');
      check((await comp(MOCK, 'action', 'orders', '2001', '')).join() === 'cancel,preview', 'acciones de elemento');
      const r = await run(['__complete', '--line', `restep ${REF} get books --sort `]);
      check(r.stdout.split('\n').includes('-rating'), 'línea de bash', r);
    });
  } finally {
    for (const p of procs) p.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed + failed} pruebas: ${passed} bien, ${failed} mal`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[2] !== '--mock') await main();
