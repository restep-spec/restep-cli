#!/usr/bin/env node
// restep: CLI genérica para cualquier API Restep 1 (https://restep.wubytes.com/1/).
// Node 18 o posterior, sin dependencias. Conoce la API por su documento de descubrimiento (§4.2):
// valida colecciones, filtros, orden, campos y cuerpos antes de enviar, y muestra legibles los
// errores problem+json (§5.4). Ayuda: restep --help
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '0.1.0';
const COMMANDS = ['describe', 'get', 'create', 'update', 'delete', 'action', 'completion'];
const FORMATS = ['json', 'ndjson', 'csv', 'table'];

// ── Códigos de salida ─────────────────────────────────────────────────────────
const EXIT = {
  ok: 0, other: 1, usage: 2, local: 3, network: 4,
  badRequest: 5, auth: 6, notFound: 7, conflict: 8, invalid: 9, client: 10, server: 11,
};
function exitForStatus(status) {
  if (status === 400) return EXIT.badRequest;
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404 || status === 410) return EXIT.notFound;
  if (status === 409 || status === 412 || status === 428) return EXIT.conflict;
  if (status === 422) return EXIT.invalid;
  if (status >= 400 && status < 500) return EXIT.client;
  if (status >= 500) return EXIT.server;
  return EXIT.other;
}

class CliError extends Error {
  constructor(exit, message, hints = []) { super(message); this.exit = exit; this.hints = hints; }
}
const usage = (msg, hints) => new CliError(EXIT.usage, msg, hints);
const local = (msg, hints) => new CliError(EXIT.local, msg, hints);

const HELP = `restep ${VERSION} · CLI para APIs Restep 1

Uso:
  restep [<url> | @alias] <orden> [argumentos] [opciones]

Órdenes:
  describe [colección]                Qué ofrece la API, o una colección
  get <colección>                     Lista (una página; --all las recorre todas)
  get <colección> <id>                Un elemento
  create <colección> --data <json>    Crea (con Idempotency-Key automática)
  update <colección> <id> --data ...  Actualiza con JSON Merge Patch
  delete <colección> <id>             Borra
  action <colección> [<id>] <nombre>  Ejecuta una acción (extensión actions)
  completion zsh|bash                 Script de autocompletado

Consulta (get de una colección):
  -f, --filter campo=valor            También campo[op]=valor, campo<=valor, campo!=valor...
  -s, --sort -campo,campo             Orden; "-" delante es descendente
      --fields a,b                    Solo esos campos (también en get de un elemento)
  -n, --limit N                       Tamaño de página
      --all                           Sigue "next" hasta el final
      --count                         Solo el total
  -o, --format json|ndjson|csv|table  Salida (por defecto: table en terminal, json si no)

Escritura:
  -d, --data '<json>' | @archivo | -  Cuerpo (- lee la entrada estándar)
      --if-match <etag>               Escribe solo si no ha cambiado
      --safe                          Lee el ETag actual y escribe con If-Match
      --idempotency-key <clave>       Clave propia en vez de una aleatoria
      --minimal                       Prefer: return=minimal
      --retry N                       Reintenta errores de red, 429 y 5xx (misma clave)

Generales:
  -p, --parent <id>                   Id del padre en una subcolección (repetible, en orden)
  -H, --header 'Nombre: valor'        Cabecera adicional (repetible)
      --token <token>                 Token Bearer (o RESTEP_TOKEN)
      --language <idioma>             Accept-Language (o RESTEP_LANGUAGE)
      --raw                           No valida contra el descubrimiento: envía igual
      --no-cache                      Vuelve a pedir el descubrimiento
  -v, --verbose                       Muestra las peticiones y respuestas
      --curl                          Imprime el curl equivalente sin enviar
  -h, --help | --version

Perfiles: RESTEP_URL, RESTEP_TOKEN, RESTEP_LANGUAGE, o alias en ~/.config/restep/config.json:
  { "default": "tienda", "aliases": { "tienda": { "url": "https://api.example.com/", "token_env": "TIENDA_TOKEN" } } }

Códigos de salida: 0 bien · 2 uso · 3 rechazado antes de enviar · 4 red · 5 400 · 6 401/403
  · 7 404/410 · 8 409/412/428 · 9 422 · 10 otro 4xx · 11 5xx · 1 otro`;

// ── Argumentos ────────────────────────────────────────────────────────────────
const VALUE_OPTS = {
  filter: 'filter', f: 'filter', sort: 'sort', s: 'sort', fields: 'fields', limit: 'limit', n: 'limit',
  format: 'format', o: 'format', data: 'data', d: 'data', 'if-match': 'ifMatch', 'idempotency-key': 'idempotencyKey',
  header: 'header', H: 'header', token: 'token', language: 'language', parent: 'parent', p: 'parent', retry: 'retry',
};
const BOOL_OPTS = {
  all: 'all', count: 'count', raw: 'raw', verbose: 'verbose', v: 'verbose', curl: 'curl', safe: 'safe',
  minimal: 'minimal', 'no-cache': 'noCache', help: 'help', h: 'help', version: 'version',
};
const REPEATABLE = ['filter', 'header', 'parent'];

function parseArgs(argv) {
  const opts = { filter: [], header: [], parent: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-') || /^-\d/.test(a)) { pos.push(a); continue; }
    const m = /^--?([^=]+)(?:=([\s\S]*))?$/.exec(a);
    const name = m[1];
    if (Object.hasOwn(BOOL_OPTS, name)) {
      if (m[2] !== undefined) throw usage(`La opción ${a.split('=')[0]} no lleva valor.`);
      opts[BOOL_OPTS[name]] = true;
    } else if (Object.hasOwn(VALUE_OPTS, name)) {
      const key = VALUE_OPTS[name];
      let v = m[2];
      if (v === undefined) {
        if (i + 1 >= argv.length) throw usage(`Falta el valor de ${a}.`);
        v = argv[++i];
      }
      if (REPEATABLE.includes(key)) opts[key].push(v);
      else if (opts[key] !== undefined) throw usage(`${a} aparece dos veces.`);
      else opts[key] = v;
    } else {
      const known = [...Object.keys(VALUE_OPTS), ...Object.keys(BOOL_OPTS)].filter((k) => k.length > 1);
      throw usage(`Opción desconocida: ${a}.`, didYouMean(name, known).map((s) => `¿Quisiste decir --${s}?`));
    }
  }
  return { opts, pos };
}

// ── Sugerencias «¿quisiste decir...?» ─────────────────────────────────────────
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function didYouMean(word, options) {
  const w = word.toLowerCase();
  const scored = options.map((o) => ({ o, d: distance(w, o.toLowerCase()) }))
    .filter(({ o, d }) => d <= Math.max(2, Math.floor(o.length / 3)) || (w.length >= 3 && o.toLowerCase().includes(w)));
  return scored.sort((a, b) => a.d - b.d).slice(0, 3).map(({ o }) => o);
}
function unknownHints(word, options, what) {
  const near = didYouMean(word, options);
  const hints = near.length ? [`¿Quisiste decir ${near.map((n) => `«${n}»`).join(' o ')}?`] : [];
  if (options.length) hints.push(`${what}: ${options.join(', ')}.`);
  return hints;
}

// ── Perfiles: URL, token e idioma ─────────────────────────────────────────────
const configPath = () => process.env.RESTEP_CONFIG
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'restep', 'config.json');
function loadConfig() {
  let text;
  try { text = readFileSync(configPath(), 'utf8'); } catch { return {}; }
  try { return JSON.parse(text); } catch (e) { throw usage(`${configPath()} no es JSON válido: ${e.message}`); }
}
const isUrl = (s) => /^https?:\/\//i.test(s ?? '');

function resolveTarget(first, opts, config = loadConfig()) {
  const aliases = config.aliases ?? {};
  let alias = null, url = null, consumed = false;
  const pickAlias = (name) => {
    if (!Object.hasOwn(aliases, name)) throw usage(`No hay ningún alias «${name}» en ${configPath()}.`, unknownHints(name, Object.keys(aliases), 'Alias'));
    const a = aliases[name];
    return typeof a === 'string' ? { url: a } : a;
  };
  if (first?.startsWith('@')) { alias = pickAlias(first.slice(1)); consumed = true; }
  else if (isUrl(first)) { url = first; consumed = true; }
  else if (process.env.RESTEP_URL) url = process.env.RESTEP_URL;
  else if (config.default) alias = pickAlias(config.default);
  if (alias) url = alias.url;
  if (!url) throw usage('Falta la URL de la API: pásala como primer argumento, usa @alias o define RESTEP_URL.');
  if (!isUrl(url)) throw usage(`«${url}» no es una URL http o https.`);
  const aliasToken = alias && (alias.token ?? (alias.token_env ? process.env[alias.token_env] : undefined));
  const token = opts.token ?? aliasToken ?? process.env.RESTEP_TOKEN ?? null;
  const language = opts.language ?? alias?.language ?? process.env.RESTEP_LANGUAGE ?? null;
  return { root: new URL(url.endsWith('/') ? url : `${url}/`), token: token || null, language: language || null, consumed };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseHeaders(ctx, url) {
  const h = { accept: 'application/json, application/problem+json' };
  if (ctx.language) h['accept-language'] = ctx.language;
  // 4.3: las credenciales solo van al origen de la API.
  if (ctx.token && new URL(url).origin === ctx.root.origin) h.authorization = `Bearer ${ctx.token}`;
  for (const raw of ctx.opts.header) {
    const i = raw.indexOf(':');
    if (i < 1) throw usage(`Cabecera mal formada: «${raw}». Usa «Nombre: valor».`);
    h[raw.slice(0, i).trim().toLowerCase()] = raw.slice(i + 1).trim();
  }
  return h;
}

function curlOf(method, url, headers, body) {
  const parts = ['curl -sS', ...(method === 'GET' ? [] : [`-X ${method}`]), shq(url)];
  for (const [k, v] of Object.entries(headers)) {
    // Nunca se imprime el token: el curl lo toma de la variable de entorno.
    if (k === 'authorization') parts.push('-H "Authorization: Bearer $RESTEP_TOKEN"');
    else parts.push(`-H ${shq(`${k}: ${v}`)}`);
  }
  if (body !== undefined) parts.push(`--data-raw ${shq(body)}`);
  return parts.join(' ');
}

const RETRY_STATUS = [429, 502, 503, 504];
// Envía una petición. Con --curl la imprime y no la envía; con --verbose la muestra en stderr.
async function request(ctx, method, url, { body, headers = {}, quiet = false, timeout } = {}) {
  url = String(url);
  const h = { ...baseHeaders(ctx, url), ...headers };
  if (ctx.opts.curl && !quiet) { console.log(curlOf(method, url, h, body)); return { curl: true }; }
  // Se reintenta solo lo que no repite efectos: lecturas, DELETE y peticiones con Idempotency-Key (§7.1).
  const retriable = ['GET', 'HEAD', 'DELETE'].includes(method) || h['idempotency-key'] !== undefined;
  const tries = 1 + (retriable && !quiet ? ctx.retry : 0);
  for (let attempt = 1; ; attempt++) {
    if (ctx.opts.verbose) {
      console.error(`> ${method} ${url}${quiet ? '  (descubrimiento)' : ''}`);
      for (const [k, v] of Object.entries(h)) console.error(`> ${k}: ${k === 'authorization' ? 'Bearer ****' : v}`);
      if (body !== undefined && !quiet) console.error(`>\n> ${body}`);
    }
    let res;
    try {
      res = await fetch(url, { method, headers: h, body, signal: timeout ? AbortSignal.timeout(timeout) : undefined });
    } catch (e) {
      if (attempt < tries) { await sleep(backoff(attempt)); continue; }
      const cause = e.cause?.code ?? e.cause?.message ?? e.message;
      throw new CliError(EXIT.network, `No se pudo conectar con ${new URL(url).origin}: ${cause}.`);
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (ctx.opts.verbose) {
      console.error(`< ${res.status} ${res.statusText}`);
      for (const [k, v] of res.headers) console.error(`< ${k}: ${v}`);
      console.error('');
    }
    const replayable = RETRY_STATUS.includes(res.status) || (res.status === 409 && h['idempotency-key'] !== undefined);
    if (attempt < tries && replayable) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after >= 0 ? Math.min(after, 30) * 1000 : backoff(attempt));
      continue;
    }
    return { status: res.status, statusText: res.statusText, headers: res.headers, data, text, url: res.url || url };
  }
}
const backoff = (attempt) => Math.min(500 * 2 ** (attempt - 1), 10_000);

// ── Descubrimiento (§4.2), con caché local ────────────────────────────────────
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDiscovery = (d) => isObject(d) && typeof d.restep === 'string';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const cacheDir = () => process.env.RESTEP_CACHE_DIR
  || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'restep');
const MAX_CACHE = 300; // segundos: la caché es corta aunque el servidor diga más
const COMPLETION_CACHE = 300;

function cacheFile(ctx) {
  // Cada idioma y cada token pueden ver otro documento; el token no se guarda, solo su huella.
  const key = sha([ctx.root.href, ctx.language ?? '', ctx.token ? sha(ctx.token) : ''].join('\n')).slice(0, 32);
  return join(cacheDir(), `${key}.json`);
}
function readCache(ctx) {
  try { return JSON.parse(readFileSync(cacheFile(ctx), 'utf8')); } catch { return null; }
}
function writeCache(ctx, entry) {
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile(ctx), JSON.stringify(entry), { mode: 0o600 });
  } catch { /* sin caché no pasa nada */ }
}
function linkTargets(header, rel) {
  if (!header) return [];
  return header.split(/,(?=\s*<)/).flatMap((part) => {
    const m = part.match(/<([^>]*)>(.*)/);
    if (!m) return [];
    const rels = (m[2].match(/rel="?([^";]+)"?/)?.[1] ?? '').split(/\s+/);
    return rels.includes(rel) ? [m[1]] : [];
  });
}
function maxAge(headers) {
  const cc = headers.get('cache-control') ?? '';
  if (/no-store/i.test(cc)) return null;
  const m = /max-age=(\d+)/i.exec(cc);
  return Math.min(m ? Number(m[1]) : 0, MAX_CACHE);
}

// Devuelve { doc, cached }. doc es null si la API no tiene descubrimiento: solo core (§4.2).
async function discover(ctx, { fresh = false, completion = false } = {}) {
  const cached = readCache(ctx);
  const age = cached ? (Date.now() - cached.saved) / 1000 : Infinity;
  if (cached && !fresh && (age < cached.maxAge || (completion && age < COMPLETION_CACHE))) return { doc: cached.doc, cached: true };
  const timeout = completion ? 2000 : undefined;
  const get = (url, etag) => request(ctx, 'GET', url, { quiet: true, timeout, headers: etag ? { 'if-none-match': etag } : {} });
  let res = await get(ctx.root, cached?.etag);
  if (res.status === 304 && cached) {
    writeCache(ctx, { ...cached, saved: Date.now(), maxAge: maxAge(res.headers) ?? 0 });
    return { doc: cached.doc, cached: false };
  }
  if (res.status === 401 || res.status === 403) {
    const err = new CliError(EXIT.auth, `La API ha respondido ${res.status} al pedir su descubrimiento.`);
    err.response = res;
    throw err;
  }
  if (!isDiscovery(res.data)) {
    // 4.2: con la raíz ocupada, el descubrimiento se enlaza con rel="service-desc"; vale el primero que lo sea.
    let found = null;
    for (const href of linkTargets(res.headers.get('link'), 'service-desc')) {
      const d = await get(new URL(href, res.url));
      if (isDiscovery(d.data)) { found = d; break; }
    }
    if (!found) return { doc: null, cached: false };
    res = found;
  }
  const ttl = maxAge(res.headers);
  if (ttl !== null) writeCache(ctx, { saved: Date.now(), maxAge: ttl, etag: res.headers.get('etag'), url: res.url, doc: res.data });
  return { doc: res.data, cached: false };
}

const has = (doc, kind, name) => Array.isArray(doc?.[kind]) && doc[kind].includes(name);

// ── Colecciones y rutas ───────────────────────────────────────────────────────
// Busca la colección en el descubrimiento. Sin descubrimiento (solo core) o con --raw, usa /<nombre>.
function collection(ctx, name) {
  if (!name) throw usage('Falta la colección.');
  const all = ctx.doc?.collections;
  if (isObject(all) && Object.hasOwn(all, name)) return { name, decl: all[name], path: all[name].path ?? `/${name}` };
  if (ctx.opts.raw || !ctx.doc) return { name, decl: null, path: `/${encodeURIComponent(name)}` };
  throw local(`La API no tiene ninguna colección «${name}».`, unknownHints(name, Object.keys(all ?? {}), 'Colecciones'));
}
// 5.1: la plantilla de URI de una subcolección se expande con los id de los padres, por orden.
function collectionPath(coll, parents) {
  let n = 0;
  const path = coll.path.replace(/\{([^}]+)\}/g, (_, v) => {
    const id = parents[n++];
    if (id === undefined) throw usage(`«${coll.name}» es una subcolección (${coll.path}): pasa el id de cada padre con --parent.`);
    return encodeURIComponent(id);
  });
  if (n < parents.length) throw usage(`«${coll.name}» no tiene tantos padres: sobra algún --parent.`);
  return path.replace(/\/$/, '');
}
// Las rutas son relativas a la raíz de la API (§2); «./» evita que «orders:import» se lea como esquema.
const apiUrl = (ctx, path) => new URL(`./${path.replace(/^\//, '')}`, ctx.root);
const itemPath = (ctx, coll, id) => `${collectionPath(coll, ctx.opts.parent)}/${encodeURIComponent(id)}`;

function requireMethod(ctx, coll, method, item) {
  if (ctx.opts.raw || !coll.decl) return;
  const list = coll.decl[item ? 'item_methods' : 'methods'];
  if (Array.isArray(list) && !list.includes(method))
    throw local(`${item ? 'Los elementos de' : 'La colección'} «${coll.name}» no admite${item ? 'n' : ''} ${method}.`, [`Admite: ${list.join(', ')}.`]);
}

// ── Filtros, orden, campos (§6) ───────────────────────────────────────────────
const SYMBOLS = { '=': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
function parseFilter(raw) {
  const m = /^([^[\]=<>!]+)(?:\[([a-z]+)\])?(!=|<=|>=|=|<|>)([\s\S]*)$/.exec(raw);
  if (!m) throw usage(`Filtro mal formado: «${raw}».`, ['Usa campo=valor, campo[op]=valor o campo<=valor.']);
  const [, field, bracket, symbol, value] = m;
  if (bracket && symbol !== '=') throw usage(`Filtro mal formado: «${raw}». Con [op] va «=».`);
  const op = bracket ?? SYMBOLS[symbol];
  const key = bracket || symbol !== '=' ? `filter[${field}][${op}]` : `filter[${field}]`;
  return { field, op, value, key };
}

const TYPE_CHECKS = {
  integer: [/^-?\d+$/, 'un entero'],
  number: [/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/, 'un número'],
  decimal: [/^-?[0-9]+(\.[0-9]+)?$/, 'un decimal como 18.50'],
  boolean: [/^(true|false)$/, 'true o false'],
  date: [/^\d{4}-\d{2}-\d{2}$/, 'una fecha AAAA-MM-DD'],
  datetime: [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i, 'una fecha y hora RFC 3339'],
  duration: [/^-?P(?!$)(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/, 'una duración ISO 8601 sin años ni meses, como PT90M o P2D'],
};
function checkValue(decl, value, label) {
  if (decl.type === 'enum') {
    const values = decl.values ?? [];
    if (values.length && !values.includes(value)) throw local(`${label}: «${value}» no es un valor admitido.`, unknownHints(value, values, 'Valores'));
    return;
  }
  const check = TYPE_CHECKS[decl.type];
  if (check && !check[0].test(value)) throw local(`${label}: «${value}» no es ${check[1]}.`);
}

function validateFilters(ctx, coll, filters) {
  const decl = coll.decl;
  if (!decl || ctx.opts.raw) return;
  if (!has(ctx.doc, 'profiles', 'query')) throw local('La API no anuncia el perfil query: no admite filtros, orden, campos ni tamaño de página.');
  const declared = isObject(decl.filter) ? decl.filter : {};
  const seen = new Set();
  for (const f of filters) {
    const d = declared[f.field];
    if (!d) throw local(`La colección «${coll.name}» no admite filtrar por «${f.field}».`, unknownHints(f.field, Object.keys(declared), 'Filtros'));
    const ops = d.ops ?? [];
    if (!ops.includes(f.op)) throw local(`«${f.field}» no admite el operador ${f.op}.`, [`Operadores de ${f.field}: ${ops.join(', ') || 'ninguno'}.`]);
    const id = `${f.field}[${f.op}]`;
    if (seen.has(id)) throw local(`El filtro ${id} aparece dos veces.`);
    seen.add(id);
    const label = `Filtro ${f.field}[${f.op}]`;
    if (f.op === 'null') {
      if (f.value !== 'true' && f.value !== 'false') throw local(`${label}: el operador null lleva true o false.`);
    } else if (f.op === 'in') {
      const values = f.value.split(',');
      if (values.some((v) => v === '')) throw local(`${label}: in necesita una lista no vacía, separada por comas.`);
      for (const v of values) checkValue(d, v, label);
    } else checkValue(d, f.value, label);
  }
}

// Campos conocidos de una colección: las propiedades de su esquema item, si viene incrustado (§4.3).
function knownFields(decl) {
  const props = decl?.schemas?.item?.properties;
  return isObject(props) ? Object.keys(props) : null;
}

function buildQuery(ctx, coll, { list }) {
  const o = ctx.opts;
  const q = new URLSearchParams();
  const decl = ctx.opts.raw ? null : coll.decl;
  const needQuery = () => {
    if (decl && !has(ctx.doc, 'profiles', 'query')) throw local('La API no anuncia el perfil query: no admite filtros, orden, campos ni tamaño de página.');
  };
  if (!list && (o.filter.length || o.sort || o.limit || o.all || o.count))
    throw usage('--filter, --sort, --limit, --all y --count son para listar una colección, no un elemento.');
  if (list) {
    const filters = o.filter.map(parseFilter);
    validateFilters(ctx, coll, filters);
    for (const f of filters) q.append(f.key, f.value);
    if (o.sort !== undefined) {
      needQuery();
      const sortable = decl?.sort ?? [];
      for (const s of o.sort.split(',')) {
        const f = s.replace(/^-/, '');
        if (!f) throw local('--sort tiene una clave vacía.');
        if (decl && !sortable.includes(f)) throw local(`La colección «${coll.name}» no se puede ordenar por «${f}».`, unknownHints(f, sortable, 'Orden'));
      }
      q.set('sort', o.sort);
    }
  }
  if (o.fields !== undefined) {
    needQuery();
    const known = knownFields(decl);
    const maps = Object.keys(decl?.language_maps ?? {});
    for (const f of o.fields.split(',')) {
      if (!f) throw local('--fields tiene un campo vacío.');
      if (f.includes('.') && maps.includes(f.split('.')[0])) throw local(`«${f.split('.')[0]}» es un mapa de idioma: pídelo entero (--fields ${f.split('.')[0]}).`);
      if (known && !f.includes('.') && !known.includes(f)) throw local(`La colección «${coll.name}» no tiene el campo «${f}».`, unknownHints(f, known, 'Campos'));
    }
    q.set('fields', o.fields);
  }
  if (list && o.limit !== undefined) {
    needQuery();
    if (!/^\d+$/.test(o.limit) || Number(o.limit) < 1) throw usage('--limit tiene que ser un entero mayor que 0.');
    if (decl?.max_limit && Number(o.limit) > decl.max_limit) throw local(`--limit ${o.limit} supera el máximo de «${coll.name}», ${decl.max_limit}.`);
    q.set('limit', o.limit);
  }
  if (list && o.count) {
    needQuery();
    if (decl && !decl.count) throw local(`La colección «${coll.name}» no declara count: no da el total.`);
    q.set('count', 'true');
    if (o.limit === undefined) q.set('limit', '1'); // solo interesa el total
  }
  return q;
}

// ── Cuerpos: lectura y validación contra el esquema (§4.3) ────────────────────
function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch (e) { throw usage(`No se pudo leer la entrada estándar: ${e.message}`); }
}
function readBody(ctx, required) {
  const raw = ctx.opts.data;
  if (raw === undefined) {
    if (required) throw usage('Falta el cuerpo: pásalo con --data \'{...}\', --data @archivo o --data - (entrada estándar).');
    return undefined;
  }
  let text = raw;
  if (raw === '-' || raw === '@-') text = readStdin();
  else if (raw.startsWith('@')) {
    try { text = readFileSync(raw.slice(1), 'utf8'); } catch (e) { throw usage(`No se pudo leer ${raw.slice(1)}: ${e.code ?? e.message}.`); }
  }
  let value;
  try { value = JSON.parse(text); } catch (e) {
    if (ctx.opts.raw) return { text, value: undefined };
    throw usage(`El cuerpo no es JSON válido: ${e.message}`);
  }
  if (!ctx.opts.raw && !isObject(value)) throw local('El cuerpo tiene que ser un objeto JSON.');
  return { text: JSON.stringify(value), value };
}

// Validador mínimo de JSON Schema: lo que usan los esquemas de create, update e input habituales.
function schemaErrors(s, v, ptr = '') {
  if (!isObject(s)) return [];
  const errs = [];
  const at = ptr || '/';
  if (Array.isArray(s.anyOf) && !s.anyOf.some((x) => schemaErrors(x, v, ptr).length === 0))
    return schemaErrors(s.anyOf.find((x) => x.type !== 'null') ?? s.anyOf[0], v, ptr);
  if (Array.isArray(s.oneOf) && s.oneOf.filter((x) => schemaErrors(x, v, ptr).length === 0).length !== 1)
    errs.push({ pointer: at, code: 'type', detail: 'no encaja exactamente con una de las alternativas del esquema' });
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const ok = types.some((t) => (t === 'null' ? v === null : t === 'integer' ? Number.isInteger(v)
      : t === 'number' ? typeof v === 'number' : t === 'array' ? Array.isArray(v) : t === 'object' ? isObject(v) : typeof v === t));
    if (!ok) return [{ pointer: at, code: 'type', detail: `tiene que ser ${types.join(' o ')}` }];
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v)))
    errs.push({ pointer: at, code: 'format', detail: `tiene que ser uno de: ${s.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  if (typeof v === 'string' && typeof s.pattern === 'string') {
    let re = null;
    try { re = new RegExp(s.pattern, 'u'); } catch { /* patrón que JavaScript no entiende: no se comprueba */ }
    if (re && !re.test(v)) errs.push({ pointer: at, code: 'format', detail: `no cumple el patrón ${s.pattern}` });
  }
  if (typeof v === 'string' && Number.isInteger(s.maxLength) && [...v].length > s.maxLength)
    errs.push({ pointer: at, code: 'too_long', detail: `admite como mucho ${s.maxLength} caracteres` });
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) errs.push({ pointer: at, code: 'range', detail: `mínimo ${s.minimum}` });
    if (typeof s.maximum === 'number' && v > s.maximum) errs.push({ pointer: at, code: 'range', detail: `máximo ${s.maximum}` });
  }
  if (Array.isArray(v) && isObject(s.items)) v.forEach((x, i) => errs.push(...schemaErrors(s.items, x, `${ptr}/${i}`)));
  if (isObject(v)) {
    const esc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1');
    for (const r of s.required ?? []) if (!(r in v)) errs.push({ pointer: `${ptr}/${esc(r)}`, code: 'required', detail: 'es obligatorio' });
    const props = isObject(s.properties) ? s.properties : {};
    const patterns = isObject(s.patternProperties) ? Object.entries(s.patternProperties) : [];
    for (const [k, x] of Object.entries(v)) {
      const p = `${ptr}/${esc(k)}`;
      if (isObject(s.propertyNames) && typeof s.propertyNames.pattern === 'string') {
        try { if (!new RegExp(s.propertyNames.pattern, 'u').test(k)) errs.push({ pointer: p, code: 'format', detail: 'nombre de miembro no válido' }); } catch { /* sin comprobar */ }
      }
      let matched = false;
      if (Object.hasOwn(props, k)) { matched = true; errs.push(...schemaErrors(props[k], x, p)); }
      for (const [re, ps] of patterns) {
        let hit = false;
        try { hit = new RegExp(re, 'u').test(k); } catch { /* sin comprobar */ }
        if (hit) { matched = true; errs.push(...schemaErrors(ps, x, p)); }
      }
      if (!matched && s.additionalProperties === false) errs.push({ pointer: p, code: 'unknown', detail: 'no es un campo admitido' });
      else if (!matched && isObject(s.additionalProperties)) errs.push(...schemaErrors(s.additionalProperties, x, p));
    }
  }
  return errs;
}
function validateBody(ctx, schema, value, what) {
  if (ctx.opts.raw || !isObject(schema) || value === undefined) return; // un esquema enlazado no se valida aquí
  // 4.3: los miembros que empiezan por _ se quitan antes de validar.
  const body = Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith('_')));
  const errs = schemaErrors(schema, body);
  if (errs.length) throw local(`El cuerpo no cumple el esquema ${what}:`, [...errs.map((e) => `${e.pointer} (${e.code}): ${e.detail}.`)]);
}

// ── Salida ────────────────────────────────────────────────────────────────────
const out = (s) => { process.stdout.write(`${s}\n`); };
const cell = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function columns(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r ?? {})) if (!k.startsWith('_') && !cols.includes(k)) cols.push(k);
  return cols;
}
function table(rows, cols = columns(rows), max = 40) {
  const cut = (s) => { s = s.replace(/\s+/g, ' '); return [...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s; };
  const grid = [cols, ...rows.map((r) => cols.map((c) => cut(cell(r?.[c]))))];
  const widths = cols.map((_, i) => Math.max(...grid.map((row) => [...row[i]].length)));
  const line = (row) => row.map((v, i) => v + ' '.repeat(widths[i] - [...v].length)).join('  ').trimEnd();
  return [line(grid[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...grid.slice(1).map(line)].join('\n');
}
const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
function csv(rows, cols = columns(rows)) {
  return [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(cell(r?.[c]))).join(','))].join('\n');
}
const json = (v) => JSON.stringify(v, null, 2);

function format(ctx, list) {
  const f = ctx.opts.format ?? (list && process.stdout.isTTY ? 'table' : 'json');
  if (!FORMATS.includes(f)) throw usage(`Formato desconocido: ${f}.`, unknownHints(f, FORMATS, 'Formatos'));
  return f;
}
function printItem(ctx, item) {
  const f = format(ctx, false);
  if (f === 'json') out(json(item));
  else if (f === 'ndjson') out(JSON.stringify(item));
  else if (f === 'csv') out(csv([item]));
  else out(table(Object.entries(item ?? {}).map(([k, v]) => ({ campo: k, valor: v })), ['campo', 'valor'], 80));
}

// Error problem+json (§5.4) legible en stderr; con --format json, también en stdout tal cual.
function showProblem(ctx, res, coll) {
  const p = isObject(res.data) ? res.data : null;
  if (ctx.opts.format === 'json' && p) out(json(p));
  const lines = [];
  if (p && (p.code || p.title)) {
    lines.push(`Error ${res.status}${p.code ? ` ${p.code}` : ''}: ${p.title ?? res.statusText}`);
    if (p.detail) lines.push(`  ${p.detail}`);
    if (p.parameter !== undefined) lines.push(`  Parámetro: ${p.parameter}`);
    if (p.reason) lines.push(`  Motivo: ${p.reason}`);
    for (const e of Array.isArray(p.errors) ? p.errors : []) {
      const where = e.pointer ?? (e.parameter !== undefined ? `parámetro ${e.parameter}` : e.header !== undefined ? `cabecera ${e.header}` : '');
      lines.push(`  - ${where}${e.code ? ` (${e.code})` : ''}${e.detail ? `: ${e.detail}` : ''}`);
    }
  } else {
    lines.push(`Error ${res.status} ${res.statusText}`);
    if (res.text) lines.push(`  ${res.text.slice(0, 500)}`);
  }
  for (const h of problemHints(ctx, res, p, coll)) lines.push(`  Pista: ${h}`);
  console.error(lines.join('\n'));
  return exitForStatus(res.status);
}
function problemHints(ctx, res, p, coll) {
  const hints = [];
  const decl = coll?.decl;
  const code = p?.code;
  if (code === 'unsupported_parameter' && decl) {
    const param = String(p.parameter ?? '');
    if (param.startsWith('filter')) hints.push(`filtros de «${coll.name}»: ${Object.entries(decl.filter ?? {}).map(([f, d]) => `${f} (${(d.ops ?? []).join(', ')})`).join('; ') || 'ninguno'}.`);
    if (param === 'sort') hints.push(`orden de «${coll.name}»: ${(decl.sort ?? []).join(', ') || 'ninguno'}.`);
    hints.push('la API no ofrece eso: no sirve reintentarlo.');
  }
  if (code === 'invalid_parameter' && p.parameter === 'cursor') hints.push('vuelve a la primera página: el cursor no vale para esta consulta.');
  for (const e of Array.isArray(p?.errors) ? p.errors : []) {
    if (e.code !== 'read_only' || !isObject(decl?.inherit)) continue;
    const f = String(e.pointer ?? '').slice(1);
    if (decl.inherit[f]?.own) hints.push(`«${f}» es un valor heredado: escribe «${decl.inherit[f].own}» (null para volver a heredar).`);
  }
  if (res.status === 401) {
    const meta = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1];
    hints.push(ctx.token ? 'el token no vale: revisa --token o RESTEP_TOKEN.' : 'la API pide credenciales: pasa --token o define RESTEP_TOKEN.');
    if (meta) hints.push(`metadatos OAuth: ${meta}`);
  }
  if (res.status === 412) hints.push('alguien ha cambiado el elemento: vuelve a leerlo, o usa --safe.');
  if (res.status === 428) hints.push('la API exige If-Match: usa --if-match <etag> o --safe.');
  const after = res.headers.get('retry-after');
  if (after && (res.status === 429 || res.status === 503)) hints.push(`vuelve a probar dentro de ${after} s, o usa --retry.`);
  return hints;
}

// ── Órdenes ───────────────────────────────────────────────────────────────────
async function cmdDescribe(ctx, [name]) {
  const doc = ctx.doc;
  if (!doc) {
    if (ctx.opts.format === 'json') out(json(null));
    else out('La API no sirve documento de descubrimiento: se supone solo el perfil core (§4.2).');
    return;
  }
  if (name !== undefined) {
    const coll = collection({ ...ctx, opts: { ...ctx.opts, raw: false } }, name);
    if (ctx.opts.format === 'json') return out(json(coll.decl));
    return out(describeCollection(ctx, coll));
  }
  if (ctx.opts.format === 'json') return out(json(doc));
  const lines = [`Restep ${doc.restep}${doc.version ? ` · versión ${doc.version} de la API` : ''} · ${ctx.root.href}`];
  lines.push(`Perfiles: ${(doc.profiles ?? []).join(', ') || 'core'}`);
  if (doc.extensions?.length) lines.push(`Extensiones: ${doc.extensions.join(', ')}`);
  if (doc.status) lines.push(`Estado del servicio: ${doc.status}`);
  if (Array.isArray(doc.deprecations) && doc.deprecations.length) lines.push(`Retiradas anunciadas: ${doc.deprecations.length} (ver --format json)`);
  const colls = Object.entries(doc.collections ?? {});
  lines.push('');
  if (!colls.length) lines.push('No declara colecciones.');
  else lines.push(table(colls.map(([n, c]) => ({
    colección: n, ruta: c.path ?? '',
    métodos: [c.methods?.join(' '), c.item_methods ? `elemento: ${c.item_methods.join(' ')}` : ''].filter(Boolean).join(' · '),
    descripción: c.description ?? '',
  })), ['colección', 'ruta', 'métodos', 'descripción'], 60));
  out(lines.join('\n'));
}
function describeCollection(ctx, { name, decl: c }) {
  const L = [`${name}  ${c.path ?? ''}`];
  if (c.description) L.push(`  ${c.description}`);
  if (c.methods || c.item_methods) L.push(`  Métodos: ${(c.methods ?? ['?']).join(', ')}; elemento: ${(c.item_methods ?? ['?']).join(', ')}`);
  const filters = Object.entries(c.filter ?? {});
  if (filters.length) {
    L.push('  Filtros:');
    for (const line of table(filters.map(([f, d]) => ({ campo: f, tipo: d.type ?? '', operadores: (d.ops ?? []).join(', '),
      valores: (d.values ?? []).join(', '), descripción: d.description ?? '' })), undefined, 60).split('\n')) L.push(`    ${line}`);
  }
  if (c.sort?.length) L.push(`  Orden: ${c.sort.join(', ')}`);
  const page = [c.max_limit && `max_limit ${c.max_limit}`, c.count && `count ${c.count}`].filter(Boolean);
  if (page.length) L.push(`  Página: ${page.join(' · ')}`);
  const fields = knownFields(c);
  if (fields) L.push(`  Campos: ${fields.join(', ')}`);
  const create = c.schemas?.create;
  if (isObject(create) && create.required?.length) L.push(`  Obligatorios al crear: ${create.required.join(', ')}`);
  for (const k of ['item', 'create', 'update']) if (typeof c.schemas?.[k] === 'string') L.push(`  Esquema ${k}: ${c.schemas[k]}`);
  if (c.language_maps) L.push(`  Mapas de idioma: ${Object.keys(c.language_maps).join(', ')}`);
  for (const [r, d] of Object.entries(c.relations ?? {})) L.push(`  Relación ${r} → ${d.to}${d.many ? ' (a muchos)' : ''}${d.include ? ' · include' : ''}${d.description ? ` · ${d.description}` : ''}`);
  for (const [f, d] of Object.entries(c.inherit ?? {})) L.push(`  Heredado ${f}: se escribe en ${d.own}; de ${(d.from ?? []).join(', ') || '—'}${d.description ? ` · ${d.description}` : ''}`);
  for (const [a, d] of Object.entries(c.actions ?? {})) {
    const traits = [d.on === 'collection' ? 'colección' : 'elemento', d.method ?? 'POST', d.safe ? 'segura' : null, d.idempotent ? 'idempotente' : 'no idempotente'].filter(Boolean);
    L.push(`  Acción ${a} (${traits.join(', ')})${d.description ? `: ${d.description}` : ''}`);
  }
  if (c.sync) L.push(`  Sync: retención ${c.sync.retention ?? '?'} s`);
  return L.join('\n');
}

async function cmdGet(ctx, [name, id, ...extra]) {
  if (extra.length) throw usage(`Sobran argumentos: ${extra.join(' ')}.`);
  const coll = collection(ctx, name);
  const list = id === undefined;
  requireMethod(ctx, coll, 'GET', !list);
  const q = buildQuery(ctx, coll, { list });
  const path = list ? collectionPath(coll, ctx.opts.parent) : itemPath(ctx, coll, id);
  const url = apiUrl(ctx, path);
  url.search = q.toString();
  if (!list) {
    const res = await request(ctx, 'GET', url);
    if (res.curl) return EXIT.ok;
    if (res.status !== 200) return showProblem(ctx, res, coll);
    printItem(ctx, res.data);
    return EXIT.ok;
  }
  const fmt = format(ctx, true);
  let res = await request(ctx, 'GET', url);
  if (res.curl) return EXIT.ok;
  if (res.status !== 200) return showProblem(ctx, res, coll);
  if (!isObject(res.data) || !Array.isArray(res.data.items)) throw new CliError(EXIT.other, 'La respuesta no es una colección Restep (falta items).');
  if (ctx.opts.count) {
    const { total, total_estimated: est } = res.data;
    if (typeof total !== 'number') throw new CliError(EXIT.other, 'La respuesta no trae total.');
    if (ctx.opts.format === 'json') out(json(est ? { total, total_estimated: true } : { total }));
    else out(String(total));
    if (est && ctx.opts.format !== 'json') console.error('(total aproximado)');
    return EXIT.ok;
  }
  if (!ctx.opts.all) {
    if (fmt === 'json') out(json(res.data));
    else emitRows(fmt, res.data.items);
    if (fmt !== 'json' && res.data.next) console.error(`Hay más: --all las recorre todas (next: ${res.data.next})`);
    return EXIT.ok;
  }
  // --all: sigue next tal cual (§5.2) hasta null.
  const items = [];
  const seen = new Set([String(url)]);
  for (;;) {
    if (fmt === 'ndjson') emitRows(fmt, res.data.items); else items.push(...res.data.items);
    const next = res.data.next;
    if (next === null || next === undefined) break;
    const nextUrl = String(new URL(next, res.url));
    if (seen.has(nextUrl)) throw new CliError(EXIT.other, `La API repite la página ${nextUrl}: se para para no entrar en un bucle.`);
    seen.add(nextUrl);
    res = await request(ctx, 'GET', nextUrl);
    if (res.status !== 200) return showProblem(ctx, res, coll);
    if (!isObject(res.data) || !Array.isArray(res.data.items)) throw new CliError(EXIT.other, 'Una página no es una colección Restep (falta items).');
  }
  if (fmt === 'json') out(json({ items, next: null }));
  else if (fmt !== 'ndjson') emitRows(fmt, items);
  return EXIT.ok;
}
function emitRows(fmt, rows) {
  if (fmt === 'ndjson') { for (const r of rows) out(JSON.stringify(r)); return; }
  if (!rows.length) { if (fmt === 'table') console.error('(sin elementos)'); return; }
  out(fmt === 'csv' ? csv(rows) : table(rows));
}

function idempotencyHeader(ctx) {
  const key = ctx.opts.idempotencyKey;
  if (key !== undefined) {
    if (!/^[\x20\x21\x23-\x5b\x5d-\x7e]*$/.test(key)) throw usage('--idempotency-key solo admite caracteres ASCII visibles, sin comillas ni barras inversas.');
    return { 'idempotency-key': `"${key}"` };
  }
  // 7.1: el cliente no cuenta con la clave si el servidor no anuncia writes, pero enviarla no estorba.
  return ctx.opts.raw || has(ctx.doc, 'profiles', 'writes') ? { 'idempotency-key': `"${randomUUID()}"` } : {};
}
const preferHeader = (ctx) => (ctx.opts.minimal ? { prefer: 'return=minimal' } : {});
function printWrite(ctx, res) {
  if (res.data !== null && res.data !== undefined) return printItem(ctx, res.data);
  // Sin cuerpo (204, return=minimal): lo que importa va en las cabeceras.
  const info = { status: res.status };
  for (const h of ['location', 'etag']) if (res.headers.get(h)) info[h] = res.headers.get(h);
  if (res.status !== 204 || info.etag) printItem(ctx, info);
}

async function cmdCreate(ctx, [name, ...extra]) {
  if (extra.length) throw usage(`Sobran argumentos: ${extra.join(' ')}.`);
  const coll = collection(ctx, name);
  requireMethod(ctx, coll, 'POST', false);
  const body = readBody(ctx, true);
  validateBody(ctx, coll.decl?.schemas?.create, body.value, `create de «${coll.name}»`);
  const url = apiUrl(ctx, collectionPath(coll, ctx.opts.parent));
  const headers = { 'content-type': 'application/json', ...idempotencyHeader(ctx), ...preferHeader(ctx), ...ifMatchHeader(ctx) };
  const res = await request(ctx, 'POST', url, { body: body.text, headers });
  if (res.curl) return EXIT.ok;
  if (res.status >= 400) return showProblem(ctx, res, coll);
  if (res.headers.get('idempotent-replayed') === 'true') console.error('(repetición: la API devuelve la respuesta guardada para esta Idempotency-Key)');
  printWrite(ctx, res);
  return EXIT.ok;
}

const quoteEtag = (e) => (/^(W\/)?".*"$/.test(e) || e === '*' ? e : `"${e}"`);
function ifMatchHeader(ctx) {
  return ctx.opts.ifMatch !== undefined ? { 'if-match': quoteEtag(ctx.opts.ifMatch) } : {};
}
// --safe: lee el elemento para tomar su ETag (o su _etag) y escribir con If-Match (§7.2).
async function safeIfMatch(ctx, coll, url) {
  if (!ctx.opts.safe) return ifMatchHeader(ctx);
  if (ctx.opts.ifMatch !== undefined) throw usage('--safe y --if-match no van juntos: --safe ya pone If-Match.');
  if (ctx.opts.curl) {
    console.log(`# --safe: primero se lee el ETag actual\n${curlOf('GET', String(url), baseHeaders(ctx, String(url)))}`);
    return { 'if-match': '<ETag del GET anterior>' };
  }
  const res = await request(ctx, 'GET', url);
  if (res.status !== 200) return { problem: res };
  // 7.2: con codificación de contenido la cabecera ETag puede ser otra; entonces manda _etag.
  const tag = res.headers.get('etag');
  const etag = isObject(res.data) && typeof res.data._etag === 'string' ? res.data._etag : tag && !tag.startsWith('W/') ? tag : null;
  if (!etag) throw new CliError(EXIT.other, 'El elemento no trae una ETag fuerte: --safe no puede proteger la escritura.');
  return { 'if-match': etag };
}

async function cmdUpdate(ctx, [name, id, ...extra]) {
  if (id === undefined) throw usage('Falta el id: restep update <colección> <id> --data \'{...}\'.');
  if (extra.length) throw usage(`Sobran argumentos: ${extra.join(' ')}.`);
  const coll = collection(ctx, name);
  requireMethod(ctx, coll, 'PATCH', true);
  const body = readBody(ctx, true);
  validateBody(ctx, coll.decl?.schemas?.update, body.value, `update de «${coll.name}»`);
  if (!ctx.opts.raw && body.value && 'id' in body.value && String(body.value.id) !== id)
    throw local('El parche trae un id distinto del elemento: el id no se puede cambiar (§5.1).');
  const url = apiUrl(ctx, itemPath(ctx, coll, id));
  const cond = await safeIfMatch(ctx, coll, url);
  if (cond.problem) return showProblem(ctx, cond.problem, coll);
  const headers = { 'content-type': 'application/merge-patch+json', ...cond, ...preferHeader(ctx) };
  const res = await request(ctx, 'PATCH', url, { body: body.text, headers });
  if (res.curl) return EXIT.ok;
  if (res.status >= 400) return showProblem(ctx, res, coll);
  printWrite(ctx, res);
  return EXIT.ok;
}

async function cmdDelete(ctx, [name, id, ...extra]) {
  if (id === undefined) throw usage('Falta el id: restep delete <colección> <id>.');
  if (extra.length) throw usage(`Sobran argumentos: ${extra.join(' ')}.`);
  const coll = collection(ctx, name);
  requireMethod(ctx, coll, 'DELETE', true);
  if (ctx.opts.data !== undefined) throw usage('delete no lleva cuerpo.');
  const url = apiUrl(ctx, itemPath(ctx, coll, id));
  const cond = await safeIfMatch(ctx, coll, url);
  if (cond.problem) return showProblem(ctx, cond.problem, coll);
  const res = await request(ctx, 'DELETE', url, { headers: cond });
  if (res.curl) return EXIT.ok;
  if (res.status >= 400) return showProblem(ctx, res, coll);
  if (ctx.opts.verbose || process.stderr.isTTY) console.error(`Borrado: ${coll.name}/${id}`);
  return EXIT.ok;
}

// 10.1: POST /coleccion/id:accion o /coleccion:accion; GET si la acción lo declara.
async function cmdAction(ctx, [name, a, b, ...extra]) {
  if (extra.length) throw usage(`Sobran argumentos: ${extra.join(' ')}.`);
  if (a === undefined) throw usage('Uso: restep action <colección> [<id>] <acción>.');
  const [id, action] = b === undefined ? [undefined, a] : [a, b];
  const coll = collection(ctx, name);
  let decl = null;
  if (!ctx.opts.raw && coll.decl) {
    if (!has(ctx.doc, 'extensions', 'actions')) throw local('La API no anuncia la extensión actions.');
    const actions = isObject(coll.decl.actions) ? coll.decl.actions : {};
    decl = actions[action];
    if (!decl) throw local(`La colección «${coll.name}» no tiene la acción «${action}».`, unknownHints(action, Object.keys(actions), 'Acciones'));
    if (decl.on === 'item' && id === undefined) throw usage(`«${action}» es una acción de elemento: restep action ${coll.name} <id> ${action}.`);
    if (decl.on === 'collection' && id !== undefined) throw usage(`«${action}» es una acción de la colección: restep action ${coll.name} ${action}.`);
  }
  const method = decl?.method === 'GET' ? 'GET' : 'POST';
  const body = readBody(ctx, false);
  if (method === 'GET' && body !== undefined) throw local(`«${action}» usa GET: no lleva cuerpo.`);
  if (body) validateBody(ctx, decl?.input, body.value, `input de «${action}»`);
  const base = id === undefined ? collectionPath(coll, ctx.opts.parent) : itemPath(ctx, coll, id);
  const url = apiUrl(ctx, `${base}:${action}`);
  const headers = { ...preferHeader(ctx), ...ifMatchHeader(ctx) };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    // 7.1: las acciones no idempotentes aceptan Idempotency-Key, como cualquier POST no idempotente.
    if (!decl?.idempotent) Object.assign(headers, idempotencyHeader(ctx));
  }
  const res = await request(ctx, method, url, { body: method === 'POST' ? (body?.text ?? '{}') : undefined, headers });
  if (res.curl) return EXIT.ok;
  if (res.status >= 400) return showProblem(ctx, res, coll);
  printWrite(ctx, res);
  return EXIT.ok;
}

// ── Autocompletado ────────────────────────────────────────────────────────────
const ZSH = `#compdef restep
# Autocompletado de restep para zsh. En ~/.zshrc, después de compinit:
#   eval "$(restep completion zsh)"
_restep() {
  local -a cands spaced bare
  cands=("\${(@f)$(restep __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  cands=(\${cands:#})
  bare=(\${(M)cands:#*[=,\\[]})
  spaced=(\${cands:#*[=,\\[]})
  (( \${#spaced} )) && compadd -- "\${spaced[@]}"
  (( \${#bare} )) && compadd -S '' -- "\${bare[@]}"
}
compdef _restep restep
`;
const BASH = `# Autocompletado de restep para bash. En ~/.bashrc:
#   eval "$(restep completion bash)"
_restep() {
  local line="\${COMP_LINE:0:COMP_POINT}" cur="\${COMP_WORDS[COMP_CWORD]}"
  local full="\${line##*[[:space:]]}"
  # bash parte la palabra en = y :, así que se quita lo que va antes de la parte actual
  local pre="\${full%"$cur"}" w
  COMPREPLY=()
  while IFS= read -r w; do
    [[ "$w" == "$full"* ]] || continue
    COMPREPLY+=("\${w#"$pre"}")
    [[ "$w" == *[=,[] ]] && compopt -o nospace 2>/dev/null
  done < <(restep __complete --line "$line" 2>/dev/null)
}
complete -F _restep restep
`;

function splitLine(line) {
  // Un espacio al final deja una palabra vacía: la que se está completando.
  return line.trimStart().split(/\s+/).slice(1); // sin «restep»
}
async function complete(words) {
  const cur = words.length ? words[words.length - 1] : '';
  const before = words.slice(0, -1);
  const config = loadConfig();
  const aliases = Object.keys(config.aliases ?? {}).map((a) => `@${a}`);
  const optNames = [...Object.keys(VALUE_OPTS), ...Object.keys(BOOL_OPTS)].filter((k) => k.length > 1).map((k) => `--${k}`);
  // Qué hay antes del cursor: posicionales y la opción que espera valor.
  let pending = null;
  const pos = [];
  const opts = { filter: [], header: [], parent: [] };
  for (const w of before) {
    if (pending) { if (REPEATABLE.includes(pending)) opts[pending].push(w); else opts[pending] = w; pending = null; continue; }
    const m = /^--?([^=]+)(=.*)?$/.exec(w);
    if (m && w !== '-') {
      if (Object.hasOwn(VALUE_OPTS, m[1]) && m[2] === undefined) pending = VALUE_OPTS[m[1]];
      else if (Object.hasOwn(VALUE_OPTS, m[1])) {
        const k = VALUE_OPTS[m[1]], v = m[2].slice(1);
        if (REPEATABLE.includes(k)) opts[k].push(v); else opts[k] = v;
      }
      continue;
    }
    pos.push(w);
  }
  if (pending === 'format') return FORMATS;
  if (!pending && cur.startsWith('-')) return optNames;
  let target;
  try { target = resolveTarget(pos[0], opts, config); } catch { target = null; }
  if (!target) return pos.length === 0 ? aliases : [];
  const rest = target.consumed ? pos.slice(1) : pos;
  if (rest.length === 0 && !pending) return [...COMMANDS, ...(target.consumed || pos.length ? [] : aliases)];
  const [command, name, ...args] = rest;
  if (command === 'completion') return rest.length === 1 ? ['zsh', 'bash'] : [];
  const ctx = { ...target, opts: { ...opts, raw: false, curl: false, verbose: false }, retry: 0 };
  let doc = null;
  try { doc = (await discover(ctx, { completion: true })).doc; } catch { return []; }
  const colls = doc?.collections ?? {};
  if (rest.length === 1 && !pending) return Object.keys(colls);
  const c = colls[name];
  if (!c) return [];
  const listAfter = (prefixWord, options) => { // listas con comas: completa el último trozo
    const i = prefixWord.lastIndexOf(',');
    const head = prefixWord.slice(0, i + 1), used = head.split(',').map((u) => u.replace(/^-/, ''));
    return options.filter((o) => !used.includes(o.replace(/^-/, ''))).map((o) => head + o);
  };
  if (pending === 'filter') {
    const m = /^([^[\]=<>!]+)(\[[a-z]+\])?(=|!=|<=|>=|<|>)(.*)$/.exec(cur);
    const filters = isObject(c.filter) ? c.filter : {};
    if (m && filters[m[1]]) {
      const d = filters[m[1]], head = cur.slice(0, cur.length - m[4].length);
      const op = m[2]?.slice(1, -1);
      const values = op === 'null' || d.type === 'boolean' ? ['true', 'false'] : d.type === 'enum' ? d.values ?? [] : [];
      return op === 'in' ? listAfter(m[4], values).map((v) => head + v) : values.map((v) => head + v);
    }
    return Object.entries(filters).flatMap(([f, d]) => [`${f}=`, ...(d.ops ?? []).map((op) => `${f}[${op}]=`)]);
  }
  if (pending === 'sort') return listAfter(cur, (c.sort ?? []).flatMap((s) => [s, `-${s}`]));
  if (pending === 'fields') return listAfter(cur, knownFields(c) ?? []);
  if (pending) return [];
  if (command === 'action' && isObject(c.actions)) {
    const on = (kind) => Object.entries(c.actions).filter(([, d]) => d.on === kind).map(([a]) => a);
    if (args.length === 0) return on('collection');
    if (args.length === 1) return on('item');
  }
  return [];
}

// ── Principal ─────────────────────────────────────────────────────────────────
async function main(argv) {
  if (argv[0] === '__complete') {
    const words = argv[1] === '--line' ? splitLine(argv[2] ?? '') : argv.slice(argv[1] === '--' ? 2 : 1);
    try { for (const c of await complete(words)) out(c); } catch { /* el autocompletado nunca falla en voz alta */ }
    return EXIT.ok;
  }
  const { opts, pos } = parseArgs(argv);
  if (opts.version) { out(VERSION); return EXIT.ok; }
  if (opts.help || !pos.length) { out(HELP); return opts.help ? EXIT.ok : EXIT.usage; }
  if (pos[0] === 'completion') {
    const shell = pos[1];
    if (shell === 'zsh') process.stdout.write(ZSH);
    else if (shell === 'bash') process.stdout.write(BASH);
    else throw usage('Uso: restep completion zsh|bash');
    return EXIT.ok;
  }
  if (opts.retry !== undefined && !/^\d+$/.test(opts.retry)) throw usage('--retry tiene que ser un entero.');
  const target = resolveTarget(pos[0], opts);
  const [command = 'describe', ...args] = target.consumed ? pos.slice(1) : pos;
  if (!COMMANDS.includes(command)) throw usage(`Orden desconocida: ${command}.`, unknownHints(command, COMMANDS, 'Órdenes'));
  if (command === 'completion') throw usage('Uso: restep completion zsh|bash (sin URL).');
  const ctx = { ...target, opts, retry: Number(opts.retry ?? 0), doc: null, cached: false };
  const run = { describe: cmdDescribe, get: cmdGet, create: cmdCreate, update: cmdUpdate, delete: cmdDelete, action: cmdAction }[command];
  const load = async (fresh) => {
    try {
      const d = await discover(ctx, { fresh });
      ctx.doc = d.doc; ctx.cached = d.cached;
    } catch (e) {
      // Con --raw o --curl se sigue sin descubrimiento; si no, el error manda.
      if (!(ctx.opts.raw || ctx.opts.curl) || command === 'describe') {
        if (e.response) return showProblem(ctx, e.response);
        throw e;
      }
      if (ctx.opts.verbose) console.error(`(sin descubrimiento: ${e.message})`);
    }
    return null;
  };
  const failed = await load(Boolean(opts.noCache));
  if (failed !== null) return failed;
  try {
    return await run(ctx, args);
  } catch (e) {
    // Un rechazo local con el descubrimiento de la caché se comprueba con uno recién pedido.
    if (e instanceof CliError && e.exit === EXIT.local && ctx.cached) {
      const again = await load(true);
      if (again !== null) return again;
      return run(ctx, args);
    }
    throw e;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code ?? EXIT.ok; }, (e) => {
  if (e instanceof CliError) {
    console.error(`restep: ${e.message}`);
    for (const h of e.hints) console.error(`  ${h}`);
    if (e.exit === EXIT.local) console.error('  (rechazado antes de enviar; --raw lo envía igual)');
    process.exitCode = e.exit;
  } else {
    console.error(`restep: error inesperado: ${e.stack ?? e}`);
    process.exitCode = EXIT.other;
  }
});
