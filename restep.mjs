#!/usr/bin/env node
// restep: generic CLI for any Restep 1 API (https://restep.wubytes.com/1/).
// Node 18 or later, no dependencies. It knows the API through its discovery document (§4.2):
// it validates collections, filters, order, fields and bodies before sending, and shows problem+json
// errors (§5.4) in a readable form. Help: restep --help
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '0.3.0';
const COMMANDS = ['describe', 'get', 'create', 'update', 'delete', 'action', 'completion'];
const FORMATS = ['json', 'ndjson', 'csv', 'table'];

// ── Exit codes ─────────────────────────────────────────────────────────
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

const HELP = `restep ${VERSION} · CLI for Restep 1 APIs

Usage:
  restep [<url> | @alias] <command> [arguments] [options]

Commands:
  describe [collection|resource]       What the API offers, or one collection or singleton
  get <collection>                     List (one page; --all walks them all)
  get <collection> <id>                One item
  get <resource>                       A singleton resource (§5.9), no id
  create <collection> --data <json>    Create (with an automatic Idempotency-Key)
  create <collection> --file <path>    Upload a file, where the collection declares upload (§5.1)
  update <collection> <id> --data ...  Update with JSON Merge Patch
  update <resource> --data ...         Update a singleton resource, no id
  delete <collection> <id>             Delete
  action <collection> [<id>] <name>    Run an action (actions extension)
  action <resource> <name>             Run an action of a singleton resource
  completion zsh|bash                  Completion script

Querying (get of a collection):
  -f, --filter field=value             Also field[op]=value, field<=value, field!=value...
                                       A named filter: -f name (switch) or -f name=value;
                                       -f name=false turns a default filter off
  -s, --sort -field,field              Sort; a leading "-" means descending
      --fields a,b                     Only those fields (also on get of an item)
  -i, --include rel,rel.rel            Include relations (relations profile, up to include_depth)
  -n, --limit N                        Page size
      --all                            Follow "next" to the end; without -f, a full copy
                                       (every default filter turned off, §5.2)
      --count                          Only the total
  -o, --format json|ndjson|csv|table   Output (default: table in a terminal, json otherwise)

Writing:
  -d, --data '<json>' | @file | -      Body (- reads standard input)
      --if-match <etag>                Write only if it has not changed
      --safe                           Read the current ETag and write with If-Match
      --idempotency-key <key>          Your own key instead of a random one
      --minimal                        Prefer: return=minimal
      --retry N                        Retry network errors, 429 and 5xx (same key, within
                                       idempotency.ttl)
      --file <path>                    The bytes of a file instead of JSON (create, upload)
      --type <media type>              Its Content-Type (default: from the extension)
      --create-only                    update creates or fails: If-None-Match: * (upsert, §5.1)
  -P, --param name=value               Parameter of a GET action (repeatable)
  -y, --yes                            Do not ask before an operation with effects (§11.1)

General:
  -p, --parent <id>                    Parent id in a subcollection (repeatable, in order)
  -H, --header 'Name: value'           Extra header (repeatable)
      --token <token>                  Bearer token (or RESTEP_TOKEN)
      --language <language>            Accept-Language (or RESTEP_LANGUAGE)
      --raw                            Do not validate against discovery: send anyway
      --no-cache                       Fetch discovery again
  -v, --verbose                        Show requests and responses
      --curl                           Print the equivalent curl without sending
  -h, --help | --version

Confirmation: in a terminal, it asks before an unsafe operation with effects (destroys, external,
  charges; all three where undeclared). RESTEP_CONFIRM=never|always|tty (default tty).

Profiles: RESTEP_URL, RESTEP_TOKEN, RESTEP_LANGUAGE, or aliases in ~/.config/restep/config.json:
  { "default": "tienda", "aliases": { "tienda": { "url": "https://api.example.com/", "token_env": "TIENDA_TOKEN" } } }

Exit codes: 0 ok · 2 usage · 3 rejected before sending · 4 network · 5 400 · 6 401/403
  · 7 404/410 · 8 409/412/428 · 9 422 · 10 other 4xx · 11 5xx · 1 other`;

// ── Arguments ────────────────────────────────────────────────────────────────
const VALUE_OPTS = {
  filter: 'filter', f: 'filter', sort: 'sort', s: 'sort', fields: 'fields', include: 'include', i: 'include', limit: 'limit', n: 'limit',
  format: 'format', o: 'format', data: 'data', d: 'data', 'if-match': 'ifMatch', 'idempotency-key': 'idempotencyKey',
  header: 'header', H: 'header', token: 'token', language: 'language', parent: 'parent', p: 'parent', retry: 'retry',
  file: 'file', type: 'type', param: 'param', P: 'param',
};
const BOOL_OPTS = {
  all: 'all', count: 'count', raw: 'raw', verbose: 'verbose', v: 'verbose', curl: 'curl', safe: 'safe',
  minimal: 'minimal', 'no-cache': 'noCache', help: 'help', h: 'help', version: 'version', yes: 'yes', y: 'yes', 'create-only': 'createOnly',
};
const REPEATABLE = ['filter', 'header', 'parent', 'param'];

function parseArgs(argv) {
  const opts = { filter: [], header: [], parent: [], param: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-') || /^-\d/.test(a)) { pos.push(a); continue; }
    const m = /^--?([^=]+)(?:=([\s\S]*))?$/.exec(a);
    const name = m[1];
    if (Object.hasOwn(BOOL_OPTS, name)) {
      if (m[2] !== undefined) throw usage(`Option ${a.split('=')[0]} takes no value.`);
      opts[BOOL_OPTS[name]] = true;
    } else if (Object.hasOwn(VALUE_OPTS, name)) {
      const key = VALUE_OPTS[name];
      let v = m[2];
      if (v === undefined) {
        if (i + 1 >= argv.length) throw usage(`Missing value for ${a}.`);
        v = argv[++i];
      }
      if (REPEATABLE.includes(key)) opts[key].push(v);
      else if (opts[key] !== undefined) throw usage(`${a} appears twice.`);
      else opts[key] = v;
    } else {
      const known = [...Object.keys(VALUE_OPTS), ...Object.keys(BOOL_OPTS)].filter((k) => k.length > 1);
      throw usage(`Unknown option: ${a}.`, didYouMean(name, known).map((s) => `Did you mean --${s}?`));
    }
  }
  return { opts, pos };
}

// ── "Did you mean...?" suggestions ─────────────────────────────────────────
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
  const hints = near.length ? [`Did you mean ${near.map((n) => `"${n}"`).join(' or ')}?`] : [];
  if (options.length) hints.push(`${what}: ${options.join(', ')}.`);
  return hints;
}

// ── Profiles: URL, token and language ─────────────────────────────────────────────
const configPath = () => process.env.RESTEP_CONFIG
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'restep', 'config.json');
function loadConfig() {
  let text;
  try { text = readFileSync(configPath(), 'utf8'); } catch { return {}; }
  try { return JSON.parse(text); } catch (e) { throw usage(`${configPath()} is not valid JSON: ${e.message}`); }
}
const isUrl = (s) => /^https?:\/\//i.test(s ?? '');

function resolveTarget(first, opts, config = loadConfig()) {
  const aliases = config.aliases ?? {};
  let alias = null, url = null, consumed = false;
  const pickAlias = (name) => {
    if (!Object.hasOwn(aliases, name)) throw usage(`There is no alias "${name}" in ${configPath()}.`, unknownHints(name, Object.keys(aliases), 'Alias'));
    const a = aliases[name];
    return typeof a === 'string' ? { url: a } : a;
  };
  if (first?.startsWith('@')) { alias = pickAlias(first.slice(1)); consumed = true; }
  else if (isUrl(first)) { url = first; consumed = true; }
  else if (process.env.RESTEP_URL) url = process.env.RESTEP_URL;
  else if (config.default) alias = pickAlias(config.default);
  if (alias) url = alias.url;
  if (!url) throw usage('Missing the API URL: pass it as the first argument, use @alias or set RESTEP_URL.');
  if (!isUrl(url)) throw usage(`"${url}" is not an http or https URL.`);
  const aliasToken = alias && (alias.token ?? (alias.token_env ? process.env[alias.token_env] : undefined));
  const token = opts.token ?? aliasToken ?? process.env.RESTEP_TOKEN ?? null;
  const language = opts.language ?? alias?.language ?? process.env.RESTEP_LANGUAGE ?? null;
  return { root: new URL(url.endsWith('/') ? url : `${url}/`), token: token || null, language: language || null, consumed };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'dpop'];
// If the request carries credentials (a token or a credentials header with -H): §7.1, anonymous.
const hasCredentials = (ctx) => Boolean(ctx.token) || ctx.opts.header.some((raw) => CREDENTIAL_HEADERS.includes(raw.slice(0, raw.indexOf(':')).trim().toLowerCase()));
// 3: an absolute link of the API is only followed if it is https or has the root's scheme.
function checkScheme(ctx, url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== ctx.root.protocol)
    throw new CliError(EXIT.other, `The API links to ${u.href}, with a scheme that is neither https nor the root's (${ctx.root.protocol}): not followed (§3).`);
  return u;
}

function baseHeaders(ctx, url) {
  const h = { accept: 'application/json, application/problem+json' };
  if (ctx.language) h['accept-language'] = ctx.language;
  // 4.3: credentials only go to the API origin.
  if (ctx.token && new URL(url).origin === ctx.root.origin) h.authorization = `Bearer ${ctx.token}`;
  const sameOrigin = new URL(url).origin === ctx.root.origin;
  for (const raw of ctx.opts.header) {
    const i = raw.indexOf(':');
    if (i < 1) throw usage(`Malformed header: "${raw}". Use "Name: value".`);
    const name = raw.slice(0, i).trim().toLowerCase();
    // 4.3: neither do credentials passed with -H leave the API origin.
    if (!sameOrigin && CREDENTIAL_HEADERS.includes(name)) continue;
    h[name] = raw.slice(i + 1).trim();
  }
  return h;
}

function curlOf(method, url, headers, body) {
  const parts = ['curl -sS', ...(method === 'GET' ? [] : [`-X ${method}`]), shq(url)];
  for (const [k, v] of Object.entries(headers)) {
    // The token is never printed: curl takes it from the environment variable.
    if (k === 'authorization') parts.push('-H "Authorization: Bearer $RESTEP_TOKEN"');
    else parts.push(`-H ${shq(`${k}: ${v}`)}`);
  }
  if (body !== undefined) parts.push(`--data-raw ${shq(body)}`);
  return parts.join(' ');
}

const RETRY_STATUS = [429, 502, 503, 504];
// Sends a request. With --curl it prints it and does not send it; with --verbose it shows it on stderr.
async function request(ctx, method, url, { body, headers = {}, quiet = false, timeout, repeatable = true } = {}) {
  url = String(url);
  const h = { ...baseHeaders(ctx, url), ...headers };
  if (ctx.opts.curl && !quiet) { console.log(curlOf(method, url, h, typeof body === 'string' || body === undefined ? body : undefined)); return { curl: true }; }
  // Only what does not repeat effects is retried: reads, DELETE and requests with Idempotency-Key (§7.1).
  const retriable = repeatable && (['GET', 'HEAD', 'DELETE'].includes(method) || h['idempotency-key'] !== undefined);
  const tries = 1 + (retriable && !quiet ? ctx.retry : 0);
  // 5.7: the same key is repeated only within idempotency.ttl of the first attempt (24 hours if undeclared).
  const ttl = Number.isInteger(ctx.doc?.idempotency?.ttl) && ctx.doc.idempotency.ttl > 0 ? ctx.doc.idempotency.ttl : 86400;
  const deadline = h['idempotency-key'] !== undefined ? Date.now() + ttl * 1000 : Infinity;
  const inTime = (wait) => Date.now() + wait < deadline;
  for (let attempt = 1; ; attempt++) {
    if (ctx.opts.verbose) {
      console.error(`> ${method} ${url}${quiet ? '  (discovery)' : ''}`);
      for (const [k, v] of Object.entries(h)) console.error(`> ${k}: ${k === 'authorization' ? 'Bearer ****' : v}`);
      if (body !== undefined && !quiet) console.error(`>\n> ${typeof body === 'string' ? body : `(${body.length} bytes)`}`);
    }
    let res;
    try {
      res = await fetch(url, { method, headers: h, body, signal: timeout ? AbortSignal.timeout(timeout) : undefined });
    } catch (e) {
      if (attempt < tries && inTime(backoff(attempt))) { await sleep(backoff(attempt)); continue; }
      const cause = e.cause?.code ?? e.cause?.message ?? e.message;
      throw new CliError(EXIT.network, `Could not connect to ${new URL(url).origin}: ${cause}.`);
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
      const wait = Number.isFinite(after) && after >= 0 ? Math.min(after, 30) * 1000 : backoff(attempt);
      if (inTime(wait)) { await sleep(wait); continue; }
      // 5.7: past the ttl, whether the first attempt took effect is unknown; a creation without an id
      // chosen by the client stays uncertain unless the client establishes it another way.
      console.error(`(not repeated: the Idempotency-Key would be older than idempotency.ttl, ${ttl} s, §5.7. Whether the first attempt took effect is unknown: find out before sending it again, e.g. with a filter by a unique field)`);
    }
    return { status: res.status, statusText: res.statusText, headers: res.headers, data, text, url: res.url || url };
  }
}
const backoff = (attempt) => Math.min(500 * 2 ** (attempt - 1), 10_000);

// ── Discovery (§4.2), with local cache ────────────────────────────────────
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDiscovery = (d) => isObject(d) && typeof d.restep === 'string';
// 1.1: version grammar; with another shape or a major other than 1 it is not Restep 1.
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(draft|rc)\.(0|[1-9][0-9]*))?$/;
function checkVersion(doc) {
  const m = VERSION_RE.exec(doc.restep);
  if (!m || m[1] !== '1') {
    const err = new CliError(EXIT.other, `The API declares "restep": ${JSON.stringify(doc.restep)}: it is not Restep 1 and this CLI cannot use it (§1.1).`,
      [m ? 'It is another major version of Restep: it needs a client for that version.' : 'The value does not follow the grammar of 1.1 (such as "1.0" or "1.0-draft.7").']);
    err.notRestep1 = true;
    throw err;
  }
}
// 1.2: experimental parts are only used if the server declares a version whose text this CLI
// implements; for a draft, that same draft.
const EXPERIMENTAL_TEXTS = ['1.0-draft.7'];
const experimentalOk = (doc, ext) => has(doc, 'extensions', ext) && EXPERIMENTAL_TEXTS.includes(doc?.restep);
// 4.2: types and values this CLI knows; a filter, action or notice with an unknown value
// is treated as if it were not declared.
const FILTER_TYPES = ['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'datetime', 'localdatetime', 'timezone', 'duration', 'enum'];
const FILTER_OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin', 'null', 'prefix', 'contains'];
// 6.1 and 4.2: a filter whose quantifier this CLI does not know is ignored.
const knownFilter = (d) => isObject(d) && FILTER_TYPES.includes(d.type) && (d.quantifier === undefined || d.quantifier === 'some');
const knownNamed = (d) => isObject(d) && (d.type === undefined || FILTER_TYPES.includes(d.type));
const knownAction = (d) => isObject(d) && ['item', 'collection'].includes(d.on) && [undefined, 'POST', 'GET'].includes(d.method);
const usableFilters = (decl) => Object.fromEntries(Object.entries(isObject(decl?.filter) ? decl.filter : {}).filter(([, d]) => knownFilter(d)));
const usableNamed = (decl) => Object.fromEntries(Object.entries(isObject(decl?.named_filters) ? decl.named_filters : {}).filter(([, d]) => knownNamed(d)));
// 5.9: a client ignores a singleton whose path is a template without parent, or whose parent names no
// collection or singleton of the document.
const usableSingletons = (doc) => {
  const all = isObject(doc?.singletons) ? doc.singletons : {};
  const named = (p) => typeof p === 'string' && (Object.hasOwn(isObject(doc?.collections) ? doc.collections : {}, p) || Object.hasOwn(all, p));
  return Object.fromEntries(Object.entries(all)
    .filter(([, d]) => isObject(d) && typeof d.path === 'string' && (d.parent === undefined ? !/[{}]/.test(d.path) : named(d.parent))));
};
// 11.1: the three effects; without effects, or with a value this CLI does not know, all three. An
// undeclared DELETE of an item has ["destroys"] (4.3).
const EFFECTS = ['destroys', 'external', 'charges'];
const effectsOf = (v, fallback = EFFECTS) => (!Array.isArray(v) ? fallback : v.some((x) => !EFFECTS.includes(x)) ? EFFECTS : v);
// 11.6 and 4.2: an inheritance whose declaration carries a member this CLI does not know is not inherited.
const INHERIT_MEMBERS = ['own', 'from', 'default', 'combine', 'switch', 'description'];
const usableInherit = (decl) => Object.fromEntries(Object.entries(isObject(decl?.inherit) ? decl.inherit : {})
  .filter(([, d]) => isObject(d) && Object.keys(d).every((k) => INHERIT_MEMBERS.includes(k) || k.startsWith('x-'))));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const cacheDir = () => process.env.RESTEP_CACHE_DIR
  || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'restep');
const MAX_CACHE = 300; // seconds: the cache is short even if the server says more
const COMPLETION_CACHE = 300;

function cacheFile(ctx) {
  // Each language and each token may see a different document; the token is not stored, only its fingerprint.
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
  } catch { /* no cache is no problem */ }
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

// Returns { doc, cached }. doc is null if the API has no discovery: core only (§4.2).
async function discover(ctx, { fresh = false, completion = false } = {}) {
  const cached = readCache(ctx);
  const age = cached ? (Date.now() - cached.saved) / 1000 : Infinity;
  if (cached && !fresh && (age < cached.maxAge || (completion && age < COMPLETION_CACHE))) { checkVersion(cached.doc); return { doc: cached.doc, cached: true }; }
  const timeout = completion ? 2000 : undefined;
  const get = (url, etag) => request(ctx, 'GET', url, { quiet: true, timeout, headers: etag ? { 'if-none-match': etag } : {} });
  let res = await get(ctx.root, cached?.etag);
  if (res.status === 304 && cached) {
    writeCache(ctx, { ...cached, saved: Date.now(), maxAge: maxAge(res.headers) ?? 0 });
    checkVersion(cached.doc);
    return { doc: cached.doc, cached: false };
  }
  if (res.status === 401 || res.status === 403) {
    const err = new CliError(EXIT.auth, `The API answered ${res.status} when asked for its discovery.`);
    err.response = res;
    throw err;
  }
  const restep1 = (d) => d.status >= 200 && d.status < 300 && isDiscovery(d.data) && VERSION_RE.exec(d.data.restep)?.[1] === '1';
  if (!(res.status >= 200 && res.status < 300 && isDiscovery(res.data))) {
    // 4.2: with the root taken, discovery is linked with rel="service-desc"; the first one that
    // is a Restep 1 discovery document is valid.
    let found = null;
    for (const href of linkTargets(res.headers.get('link'), 'service-desc')) {
      const target = new URL(href, res.url);
      if (!['https:', ctx.root.protocol].includes(target.protocol)) continue; // §3
      const d = await get(target);
      if (restep1(d)) { found = d; break; }
    }
    if (!found) {
      // 4.2: only a 2xx without restep, or a 404, means core only; any other error says nothing.
      if (!(res.status >= 200 && res.status < 300) && res.status !== 404) {
        const err = new CliError(exitForStatus(res.status), `The API answered ${res.status} when asked for its discovery: that says nothing about its profiles (§4.2).`);
        err.response = res;
        throw err;
      }
      return { doc: null, cached: false };
    }
    res = found;
  }
  checkVersion(res.data);
  const ttl = maxAge(res.headers);
  if (ttl !== null) writeCache(ctx, { saved: Date.now(), maxAge: ttl, etag: res.headers.get('etag'), url: res.url, doc: res.data });
  return { doc: res.data, cached: false };
}

const has = (doc, kind, name) => Array.isArray(doc?.[kind]) && doc[kind].includes(name);

// ── Collections and paths ───────────────────────────────────────────────────────
// Looks the collection up in the discovery. Without discovery (core only) or with --raw, uses /<name>.
function collection(ctx, name) {
  if (!name) throw usage('Missing the collection.');
  const all = ctx.doc?.collections;
  if (isObject(all) && Object.hasOwn(all, name)) return { name, decl: all[name], path: all[name].path ?? `/${name}` };
  const singles = usableSingletons(ctx.doc);
  if (Object.hasOwn(singles, name)) return { name, decl: singles[name], path: singles[name].path, singleton: true, templated: /[{}]/.test(singles[name].path) };
  if (ctx.opts.raw || !ctx.doc) return { name, decl: null, path: `/${encodeURIComponent(name)}` };
  throw local(`The API has no collection or singleton resource "${name}".`, unknownHints(name, [...Object.keys(all ?? {}), ...Object.keys(singles)], 'Collections and singleton resources'));
}
// 5.1: the URI template of a subcollection is expanded with the parents' ids, in order.
function collectionPath(coll, parents) {
  let n = 0;
  const path = coll.path.replace(/\{([^}]+)\}/g, (_, v) => {
    const id = parents[n++];
    if (id === undefined) throw usage(`"${coll.name}" ${coll.singleton ? 'hangs from an item' : 'is a subcollection'} (${coll.path}): pass the id of each parent with --parent.`);
    return encodeURIComponent(id);
  });
  if (n < parents.length) throw usage(`"${coll.name}" does not have that many parents: too many --parent.`);
  return path.replace(/\/$/, '');
}
// Paths are relative to the API root (§2); "./" keeps "orders:import" from being read as a scheme.
const apiUrl = (ctx, path) => new URL(`./${path.replace(/^\//, '')}`, ctx.root);
const itemPath = (ctx, coll, id) => `${collectionPath(coll, ctx.opts.parent)}/${encodeURIComponent(id)}`;

// 5.9: a standalone resource only admits GET and PATCH; it is neither created nor deleted, and has no items.
function notSingleton(coll, what) {
  if (coll.singleton) throw local(`"${coll.name}" is a singleton resource (${coll.path}): ${what}.`, ['It supports get and update, without an id.']);
}
// 5.9: a singleton's path, with its template expanded when it hangs from an item.
function singletonPath(ctx, coll) {
  if (!coll.templated && ctx.opts.parent.length) throw usage('This singleton resource has no parent: drop --parent.');
  return collectionPath(coll, ctx.opts.parent);
}

// 11.1: before an unsafe operation with effects, ask (in a terminal, or always with RESTEP_CONFIRM=always).
function readLine() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let done = false;
    rl.once('line', (l) => { done = true; rl.close(); resolve(l); });
    rl.once('close', () => { if (!done) resolve(''); });
  });
}
async function confirmEffects(ctx, effects, what) {
  if (ctx.opts.yes || ctx.opts.curl || ctx.opts.raw || !effects?.length) return;
  const mode = process.env.RESTEP_CONFIRM || 'tty';
  if (mode === 'never' || (mode !== 'always' && !(process.stdin.isTTY && process.stderr.isTTY))) return;
  process.stderr.write(`${what} has the effects ${effects.join(', ')} (§11.1). Continue? [y/N] `);
  const answer = await readLine();
  if (!/^y(es)?$/i.test(answer.trim())) throw local('Cancelled: nothing was sent.', ['--yes skips this question.']);
}
const methodEffects = (decl, method, item) => {
  if (!decl) return [];
  const map = decl[item ? 'item_method_effects' : 'method_effects'];
  return effectsOf(isObject(map) ? map[method] : undefined, method === 'DELETE' ? ['destroys'] : EFFECTS);
};
// 5.6: the language of a response with localized fields, on stderr.
function showLanguage(ctx, coll, res) {
  const lang = res.headers?.get?.('content-language');
  if (lang && (isObject(coll.decl?.localized) || ctx.doc?.default_language)) console.error(`(language: ${lang})`);
}
function requireMethod(ctx, coll, method, item) {
  if (ctx.opts.raw || !coll.decl) return;
  if (coll.singleton) {
    const list = coll.decl.methods;
    if (Array.isArray(list) && !list.includes(method)) throw local(`The singleton resource "${coll.name}" does not support ${method}.`, [`Supports: ${list.join(', ')}.`]);
    return;
  }
  const list = coll.decl[item ? 'item_methods' : 'methods'];
  if (Array.isArray(list) && !list.includes(method))
    throw local(`${item ? 'The items of' : 'The collection'} "${coll.name}" ${item ? 'do' : 'does'} not support ${method}.`, [`Supports: ${list.join(', ')}.`]);
}

// ── Filters, order, fields (§6) ───────────────────────────────────────────────
const SYMBOLS = { '=': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
function parseFilter(raw) {
  // Only a name: a named filter without a value, a switch (§6.1).
  if (/^[^[\]=<>!]+$/.test(raw)) return { field: raw, op: 'eq', value: '', key: `filter[${raw}]`, bare: true };
  const m = /^([^[\]=<>!]+)(?:\[([a-z]+)\])?(!=|<=|>=|=|<|>)([\s\S]*)$/.exec(raw);
  if (!m) throw usage(`Malformed filter: "${raw}".`, ['Use field=value, field[op]=value or field<=value.']);
  const [, field, bracket, symbol, value] = m;
  if (bracket && symbol !== '=') throw usage(`Malformed filter: "${raw}". With [op] use "=".`);
  const op = bracket ?? SYMBOLS[symbol];
  const key = bracket || symbol !== '=' ? `filter[${field}][${op}]` : `filter[${field}]`;
  return { field, op, value, key };
}

// 6.1, 11.1: an operand of an integer or number field (and a GET action's param of those types, each
// element of a list too) follows the number grammar of RFC 8259 (section 6), exponent included: +20,
// .5, 020 and 0x14 are not numbers. An integer one matches its type when its exact decimal value has
// no fractional part: 20.0 (or 2e1) is the same operand as 20; 20.5 is not an integer.
const JSON_NUMBER = /^-?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/;
const integral = (s) => {
  const m = JSON_NUMBER.exec(s);
  if (!m) return false;
  const digits = (m[1] + (m[2] ?? '')).replace(/^0+/, '');
  const significant = digits.replace(/0+$/, '');
  if (!significant) return true; // zero
  // Position of the decimal point within digits once the exponent is applied.
  const point = digits.length - (m[2] ?? '').length + Number(m[3] ?? 0);
  return significant.length <= point;
};
const TYPE_CHECKS = {
  integer: [{ test: integral }, 'an integer (20.0 and 2e1 count as 20; never +20, 020 or 0x14, §6.1)'],
  number: [JSON_NUMBER, 'a number of RFC 8259, such as 20, 20.5 or 2e1 (never +20, .5, 020 or 0x14, §6.1)'],
  decimal: [/^-?[0-9]+(\.[0-9]+)?$/, 'a decimal such as 18.50'],
  boolean: [/^(true|false)$/, 'true or false'],
  date: [/^\d{4}-\d{2}-\d{2}$/, 'a YYYY-MM-DD date'],
  datetime: [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i, 'an RFC 3339 date-time'],
  // 3: the duration grammar, without years or months (a filter gives invalid_parameter with them, 6.1),
  // a fraction of up to nine digits only in the seconds, and letters in either case.
  duration: [/^P(?:\d+W|(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d{1,9})?S)?)?)$/i, 'a duration without years or months, such as PT90M, PT1.5S or P2D'],
  // 3: never a leap second (:60).
  localdatetime: [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?$/i, 'a local date-time without offset or leap second, such as 2027-03-30T19:00:00'],
  timezone: [/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/, 'a time zone name, such as Europe/Madrid'],
};
function checkValue(decl, value, label) {
  if (decl.type === 'enum') {
    const values = decl.values ?? [];
    if (values.length && !values.includes(value)) throw local(`${label}: "${value}" is not an allowed value.`, unknownHints(value, values, 'Values'));
    return;
  }
  const check = TYPE_CHECKS[decl.type];
  if (check && !check[0].test(value)) throw local(`${label}: "${value}" is not ${check[1]}.`);
}

// 6.1: the to-many relationship or list field that a null filter on name tests, its own or that of a
// path through it, or null. A segment is followed through to-one relationships into their target; a
// to-many relationship (relations, "many": true) or a list field (an array in schemas.item) ends the
// group. Without either, a dotless filter declared with quantifier is itself a list or a relationship.
function nullGroup(doc, decl, name, d) {
  const parts = name.split('.');
  let cur = decl;
  for (let i = 0; i < parts.length && isObject(cur); i++) {
    const r = isObject(cur.relations) ? cur.relations[parts[i]] : undefined;
    if (isObject(r)) {
      if (r.many === true) return parts.slice(0, i + 1).join('.');
      cur = typeof r.to === 'string' ? doc?.collections?.[r.to] : null;
      continue;
    }
    const t = cur.schemas?.item?.properties?.[parts[i]]?.type;
    if (t === 'array' || (Array.isArray(t) && t.includes('array'))) return parts.slice(0, i + 1).join('.');
    break;
  }
  return parts.length === 1 && isObject(d) && 'quantifier' in d ? name : null;
}
function validateFilters(ctx, coll, filters) {
  const decl = coll.decl;
  if (!decl || ctx.opts.raw) return;
  if (!has(ctx.doc, 'profiles', 'query')) throw local('The API does not announce the query profile: no filters, sort, fields or page size.');
  const declared = usableFilters(decl);
  const named = usableNamed(decl);
  const seen = new Set(), nulls = new Map();
  for (const f of filters) {
    // §6.1: a named filter takes no operator; a switch, no value either.
    if (Object.hasOwn(named, f.field)) {
      const n = isObject(named[f.field]) ? named[f.field] : {};
      if (f.key !== `filter[${f.field}]`) throw local(`"${f.field}" is a named filter: it takes no operator.`, [n.type ? `Use -f ${f.field}=value.` : `Use -f ${f.field}.`]);
      if (seen.has(f.field)) throw local(`Filter ${f.field} appears twice.`);
      seen.add(f.field);
      // 6.1: false turns a default filter off; on any other switch, a value is invalid.
      if (!n.type && f.value === 'false' && n.default === true) continue;
      if (!n.type && f.value !== '') throw local(`"${f.field}" is a switch: it takes no value.`, [n.default === true ? `Use -f ${f.field}, or -f ${f.field}=false to turn the default filter off.` : `Use -f ${f.field}.`]);
      if (n.type && f.value === '') throw local(`"${f.field}" needs a ${n.type} value.`, [`Use -f ${f.field}=value.`]);
      if (n.type) checkValue(n, f.value, `Filter ${f.field}`);
      continue;
    }
    if (f.bare && Object.hasOwn(declared, f.field)) throw local(`"${f.field}" filters a field and needs a value.`, [`Use -f ${f.field}=value or -f ${f.field}[op]=value.`]);
    if (f.bare) throw local(`"${f.field}" is not a named filter of "${coll.name}".`, unknownHints(f.field, Object.keys(named), 'Named filters'));
    const d = declared[f.field];
    if (!d) throw local(`Collection "${coll.name}" cannot be filtered by "${f.field}".`, unknownHints(f.field, [...Object.keys(declared), ...Object.keys(named)], 'Filters'));
    const ops = (d.ops ?? []).filter((op) => FILTER_OPS.includes(op));
    if (!ops.includes(f.op)) throw local(`"${f.field}" does not support operator ${f.op}.`, [`Operators of ${f.field}: ${ops.join(', ') || 'none'}.`]);
    const id = `${f.field}[${f.op}]`;
    if (seen.has(id)) throw local(`Filter ${id} appears twice.`);
    seen.add(id);
    const label = `Filter ${f.field}[${f.op}]`;
    if (f.op === 'null') {
      if (f.value !== 'true' && f.value !== 'false') throw local(`${label}: the null operator takes true or false.`);
      // 6.1: only one null filter per to-many relationship or list field, its own or that of a path
      // through it, even when their values agree.
      const group = nullGroup(ctx.doc, decl, f.field, d);
      if (group !== null && nulls.has(group))
        throw local(`${label}: only one null filter on ${group}, its own or that of a path through it; there is also ${nulls.get(group)}[null] (§6.1).`);
      if (group !== null) nulls.set(group, f.field);
    } else if (f.op === 'in' || f.op === 'nin') {
      const values = f.value.split(',');
      if (values.some((v) => v === '')) throw local(`${label}: ${f.op} needs a non-empty, comma-separated list.`);
      for (const v of values) checkValue(d, v, label);
    } else if (f.op === 'prefix' || f.op === 'contains') {
      if (f.value === '') throw local(`${label}: ${f.op} needs a non-empty value (§6.1).`);
    } else checkValue(d, f.value, label);
  }
  // 6.1: a list request without a required filter gives invalid_parameter.
  const missing = requiredFilters(decl).filter((name) => !filters.some((f) => f.field === name));
  if (missing.length) throw local(`"${coll.name}" requires the filter ${missing.join(', ')}.`, missing.map((m) => (Object.hasOwn(named, m) ? `Use -f ${m}${named[m].type ? '=value' : ''}.` : `Use -f ${m}=value.`)));
}
// 6.1: required filters and default filters (switches declared "default": true).
const requiredFilters = (decl) => [...Object.entries(usableFilters(decl)), ...Object.entries(usableNamed(decl))].filter(([, d]) => d.required === true).map(([k]) => k);
const defaultFilters = (decl) => Object.entries(usableNamed(decl)).filter(([, d]) => d.default === true && d.type === undefined).map(([k]) => k);

// Known fields of a collection: the properties of its item schema, if embedded (§4.3).
function knownFields(decl) {
  const props = decl?.schemas?.item?.properties;
  return isObject(props) ? Object.keys(props) : null;
}

function buildQuery(ctx, coll, { list }) {
  const o = ctx.opts;
  const q = new URLSearchParams();
  const decl = ctx.opts.raw ? null : coll.decl;
  const needQuery = () => {
    if (decl && !has(ctx.doc, 'profiles', 'query')) throw local('The API does not announce the query profile: no filters, sort, fields or page size.');
  };
  if (!list && (o.filter.length || o.sort || o.limit || o.all || o.count))
    throw usage('--filter, --sort, --limit, --all and --count are for listing a collection, not an item.');
  if (list) {
    const filters = o.filter.map(parseFilter);
    validateFilters(ctx, coll, filters);
    for (const f of filters) q.append(f.key, f.value);
    // 5.2: --all without filters is a full copy: it turns off every default filter.
    if (o.all && !filters.length && decl && !requiredFilters(decl).length) {
      const off = defaultFilters(decl);
      for (const k of off) q.append(`filter[${k}]`, 'false');
      if (off.length) console.error(`(full copy: default filters turned off: ${off.join(', ')}; -f ${off[0]} keeps it)`);
    }
    if (o.sort !== undefined) {
      needQuery();
      const sortable = decl?.sort ?? [];
      for (const s of o.sort.split(',')) {
        const f = s.replace(/^-/, '');
        if (!f) throw local('--sort has an empty key.');
        if (decl && !sortable.includes(f)) throw local(`Collection "${coll.name}" cannot be sorted by "${f}".`, unknownHints(f, sortable, 'Sort'));
      }
      q.set('sort', o.sort);
    }
  }
  if (o.fields !== undefined) {
    needQuery();
    const known = knownFields(decl);
    const maps = Object.keys(decl?.language_maps ?? {});
    for (const f of o.fields.split(',')) {
      if (!f) throw local('--fields has an empty field.');
      if (f.includes('.') && maps.includes(f.split('.')[0])) throw local(`"${f.split('.')[0]}" is a language map: ask for it whole (--fields ${f.split('.')[0]}).`);
      if (known && !f.includes('.') && !known.includes(f)) throw local(`Collection "${coll.name}" has no field "${f}".`, unknownHints(f, known, 'Fields'));
    }
    q.set('fields', o.fields);
  }
  // §9: include, only on reads, for relations declared with "include": true and not going beyond
  // include_depth (1 if not declared). A relation to several collections can only go last.
  if (o.include !== undefined) {
    if (decl) {
      if (coll.singleton) throw local(`"${coll.name}" is a singleton resource: it does not support include (§5.9).`);
      if (!has(ctx.doc, 'profiles', 'relations')) throw local('The API does not announce the relations profile: no include (§9).');
      const depth = Number.isInteger(decl.include_depth) && decl.include_depth > 0 ? decl.include_depth : 1;
      for (const path of o.include.split(',')) {
        if (!path) throw local('--include has an empty path.');
        const parts = path.split('.');
        if (parts.length > depth) throw local(`"${path}" goes beyond the include depth of "${coll.name}" (${depth}) (§9).`);
        let cur = decl, curName = coll.name;
        parts.forEach((rel, i) => {
          const rels = isObject(cur?.relations) ? cur.relations : {};
          const r = rels[rel];
          if (!isObject(r) || r.include !== true) {
            throw local(`"${rel}" is not a relation of "${curName}" that can be included.`,
              unknownHints(rel, Object.keys(rels).filter((k) => isObject(rels[k]) && rels[k].include === true), 'Relations with include'));
          }
          if (i < parts.length - 1) {
            if (typeof r.to !== 'string') throw local(`"${rel}" points to several collections (${[].concat(r.to).join(', ')}): this CLI does not follow include beyond it.`);
            cur = ctx.doc?.collections?.[r.to];
            curName = r.to;
          }
        });
      }
    }
    q.set('include', o.include);
  }
  if (list && o.limit !== undefined) {
    needQuery();
    if (!/^\d+$/.test(o.limit) || Number(o.limit) < 1) throw usage('--limit must be an integer greater than 0.');
    if (decl?.max_limit && Number(o.limit) > decl.max_limit) throw local(`--limit ${o.limit} exceeds the maximum of "${coll.name}", ${decl.max_limit}.`);
    q.set('limit', o.limit);
  }
  if (list && o.count) {
    needQuery();
    if (decl && !decl.count) throw local(`Collection "${coll.name}" does not declare count: it gives no total.`);
    q.set('count', 'true');
    if (o.limit === undefined) q.set('limit', '1'); // only the total matters
  }
  return q;
}

// ── Bodies: reading and validation against the schema (§4.3) ────────────────────
function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch (e) { throw usage(`Could not read standard input: ${e.message}`); }
}
function readBody(ctx, required) {
  const raw = ctx.opts.data;
  if (raw === undefined) {
    if (required) throw usage('Missing the body: pass it with --data \'{...}\', --data @file or --data - (standard input).');
    return undefined;
  }
  let text = raw;
  if (raw === '-' || raw === '@-') text = readStdin();
  else if (raw.startsWith('@')) {
    try { text = readFileSync(raw.slice(1), 'utf8'); } catch (e) { throw usage(`Could not read ${raw.slice(1)}: ${e.code ?? e.message}.`); }
  }
  let value;
  try { value = JSON.parse(text); } catch (e) {
    if (ctx.opts.raw) return { text, value: undefined };
    throw usage(`The body is not valid JSON: ${e.message}`);
  }
  if (!ctx.opts.raw && !isObject(value)) throw local('The body must be a JSON object.');
  return { text: JSON.stringify(value), value };
}

// Minimal JSON Schema validator: what the usual create, update and input schemas use.
function schemaErrors(s, v, ptr = '') {
  if (!isObject(s)) return [];
  const errs = [];
  const at = ptr || '/';
  if (Array.isArray(s.anyOf) && !s.anyOf.some((x) => schemaErrors(x, v, ptr).length === 0))
    return schemaErrors(s.anyOf.find((x) => x.type !== 'null') ?? s.anyOf[0], v, ptr);
  if (Array.isArray(s.oneOf) && s.oneOf.filter((x) => schemaErrors(x, v, ptr).length === 0).length !== 1)
    errs.push({ pointer: at, code: 'type', detail: 'does not match exactly one of the schema alternatives' });
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const ok = types.some((t) => (t === 'null' ? v === null : t === 'integer' ? Number.isInteger(v)
      : t === 'number' ? typeof v === 'number' : t === 'array' ? Array.isArray(v) : t === 'object' ? isObject(v) : typeof v === t));
    if (!ok) return [{ pointer: at, code: 'type', detail: `must be ${types.join(' or ')}` }];
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v)))
    errs.push({ pointer: at, code: 'format', detail: `must be one of: ${s.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  if (typeof v === 'string' && typeof s.pattern === 'string') {
    let re = null;
    try { re = new RegExp(s.pattern, 'u'); } catch { /* a pattern JavaScript does not understand: not checked */ }
    if (re && !re.test(v)) errs.push({ pointer: at, code: 'format', detail: `does not match the pattern ${s.pattern}` });
  }
  if (typeof v === 'string' && Number.isInteger(s.maxLength) && [...v].length > s.maxLength)
    errs.push({ pointer: at, code: 'too_long', detail: `allows at most ${s.maxLength} characters` });
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) errs.push({ pointer: at, code: 'range', detail: `minimum ${s.minimum}` });
    if (typeof s.maximum === 'number' && v > s.maximum) errs.push({ pointer: at, code: 'range', detail: `maximum ${s.maximum}` });
  }
  if (Array.isArray(v) && isObject(s.items)) v.forEach((x, i) => errs.push(...schemaErrors(s.items, x, `${ptr}/${i}`)));
  if (isObject(v)) {
    const esc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1');
    for (const r of s.required ?? []) if (!(r in v)) errs.push({ pointer: `${ptr}/${esc(r)}`, code: 'required', detail: 'is required' });
    const props = isObject(s.properties) ? s.properties : {};
    const patterns = isObject(s.patternProperties) ? Object.entries(s.patternProperties) : [];
    for (const [k, x] of Object.entries(v)) {
      const p = `${ptr}/${esc(k)}`;
      if (isObject(s.propertyNames) && typeof s.propertyNames.pattern === 'string') {
        try { if (!new RegExp(s.propertyNames.pattern, 'u').test(k)) errs.push({ pointer: p, code: 'format', detail: 'invalid member name' }); } catch { /* not checked */ }
      }
      let matched = false;
      if (Object.hasOwn(props, k)) { matched = true; errs.push(...schemaErrors(props[k], x, p)); }
      for (const [re, ps] of patterns) {
        let hit = false;
        try { hit = new RegExp(re, 'u').test(k); } catch { /* not checked */ }
        if (hit) { matched = true; errs.push(...schemaErrors(ps, x, p)); }
      }
      if (!matched && s.additionalProperties === false) errs.push({ pointer: p, code: 'unknown', detail: 'is not an allowed field' });
      else if (!matched && isObject(s.additionalProperties)) errs.push(...schemaErrors(s.additionalProperties, x, p));
    }
  }
  return errs;
}
function validateBody(ctx, schema, value, what) {
  if (ctx.opts.raw || !isObject(schema) || value === undefined) return; // a linked schema is not validated here
  // 4.3: members that start with _ are removed before validating.
  const body = Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith('_')));
  const errs = schemaErrors(schema, body);
  if (errs.length) throw local(`The body does not satisfy the ${what}:`, [...errs.map((e) => `${e.pointer} (${e.code}): ${e.detail}.`)]);
}

// ── Output ────────────────────────────────────────────────────────────────────
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
  if (!FORMATS.includes(f)) throw usage(`Unknown format: ${f}.`, unknownHints(f, FORMATS, 'Formats'));
  return f;
}
function printItem(ctx, item) {
  const f = format(ctx, false);
  if (f === 'json') out(json(item));
  else if (f === 'ndjson') out(JSON.stringify(item));
  else if (f === 'csv') out(csv([item]));
  else out(table(Object.entries(item ?? {}).map(([k, v]) => ({ field: k, value: v })), ['field', 'value'], 80));
}

// problem+json error (§5.4) readable on stderr; with --format json, also on stdout as is.
function showProblem(ctx, res, coll) {
  const p = isObject(res.data) ? res.data : null;
  if (ctx.opts.format === 'json' && p) out(json(p));
  const lines = [];
  if (p && (p.code || p.title)) {
    lines.push(`Error ${res.status}${p.code ? ` ${p.code}` : ''}: ${p.title ?? res.statusText}`);
    if (p.detail) lines.push(`  ${p.detail}`);
    if (p.parameter !== undefined) lines.push(`  Parameter: ${p.parameter}`);
    if (p.reason) lines.push(`  Reason: ${p.reason}`);
    for (const e of Array.isArray(p.errors) ? p.errors : []) {
      const where = e.pointer ?? (e.parameter !== undefined ? `parameter ${e.parameter}` : e.header !== undefined ? `header ${e.header}` : '');
      lines.push(`  - ${where}${e.code ? ` (${e.code})` : ''}${e.detail ? `: ${e.detail}` : ''}`);
    }
  } else {
    lines.push(`Error ${res.status} ${res.statusText}`);
    if (res.text) lines.push(`  ${res.text.slice(0, 500)}`);
  }
  for (const h of problemHints(ctx, res, p, coll)) lines.push(`  Hint: ${h}`);
  console.error(lines.join('\n'));
  return exitForStatus(res.status);
}
function problemHints(ctx, res, p, coll) {
  const hints = [];
  const decl = coll?.decl;
  const code = p?.code;
  if (code === 'unsupported_parameter' && decl) {
    const param = String(p.parameter ?? '');
    if (param.startsWith('filter')) hints.push(`filters of "${coll.name}": ${Object.entries(decl.filter ?? {}).map(([f, d]) => `${f} (${(d.ops ?? []).join(', ')})`).join('; ') || 'none'}${isObject(decl.named_filters) && Object.keys(decl.named_filters).length ? `; named: ${Object.keys(decl.named_filters).join(', ')}` : ''}.`);
    if (param === 'sort') hints.push(`sort keys of "${coll.name}": ${(decl.sort ?? []).join(', ') || 'none'}.`);
    hints.push('the API does not offer that: retrying is pointless.');
  }
  if (code === 'invalid_parameter' && p.parameter === 'cursor') hints.push('go back to the first page: the cursor is not valid for this query.');
  for (const e of Array.isArray(p?.errors) ? p.errors : []) {
    if (e.code !== 'read_only') continue;
    const f = String(e.pointer ?? '').slice(1);
    // 3: a localized field is read-only; the server accepts only the value it would have.
    if (isObject(decl?.localized?.[f])) hints.push(`"${f}" is a localized field: write its language map, "${decl.localized[f].source}".`);
    if (!isObject(decl?.inherit) || !experimentalOk(ctx.doc, 'inherit')) continue;
    const inherit = usableInherit(decl);
    if (inherit[f]?.own) hints.push(`"${f}" is an inherited value: write "${inherit[f].own}" (null to inherit again).`);
  }
  if (res.status === 401) {
    const meta = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1];
    hints.push(ctx.token ? 'the token is not valid: check --token or RESTEP_TOKEN.' : 'the API asks for credentials: pass --token or set RESTEP_TOKEN.');
    if (meta) hints.push(`OAuth metadata: ${meta}`);
  }
  // 5.1: a 415 (a JSON body to a collection that only takes uploads, say) carries Accept-Post.
  const acceptPost = res.headers.get('accept-post');
  if (res.status === 415 && acceptPost) hints.push(`the API accepts here: ${acceptPost}${/application\/json/i.test(acceptPost) ? '' : ' (send a file with --file)'}.`);
  if (res.status === 412) hints.push('someone has changed the item: read it again, or use --safe.');
  if (res.status === 428) hints.push('the API requires If-Match: use --if-match <etag> or --safe.');
  const after = res.headers.get('retry-after');
  if (after && (res.status === 429 || res.status === 503)) hints.push(`try again in ${after} s, or use --retry.`);
  return hints;
}

// ── Commands ───────────────────────────────────────────────────────────────────
async function cmdDescribe(ctx, [name]) {
  const doc = ctx.doc;
  if (!doc) {
    if (ctx.opts.format === 'json') out(json(null));
    else out('The API serves no discovery document: only the core profile is assumed (§4.2).');
    return;
  }
  if (name !== undefined) {
    const coll = collection({ ...ctx, opts: { ...ctx.opts, raw: false } }, name);
    if (ctx.opts.format === 'json') return out(json(coll.decl));
    return out(coll.singleton ? describeSingleton(coll) : describeCollection(ctx, coll));
  }
  if (ctx.opts.format === 'json') return out(json(doc));
  const lines = [`Restep ${doc.restep}${doc.version ? ` · API version ${doc.version}` : ''} · ${ctx.root.href}`];
  lines.push(`Profiles: ${(doc.profiles ?? []).join(', ') || 'core'}`);
  if (doc.default_language) lines.push(`Default language: ${doc.default_language}${ctx.language ? ` · asking for ${ctx.language}` : ''} (§5.6)`);
  if (doc.extensions?.length) lines.push(`Extensions: ${doc.extensions.join(', ')}`);
  if (doc.status) lines.push(`Service status: ${doc.status}`);
  if (Array.isArray(doc.deprecations) && doc.deprecations.length) lines.push(`Announced deprecations: ${doc.deprecations.length} (see --format json)`);
  const colls = Object.entries(doc.collections ?? {});
  lines.push('');
  if (!colls.length) lines.push('It declares no collections.');
  else lines.push(table(colls.map(([n, c]) => ({
    collection: n, path: c.path ?? '',
    methods: [c.methods?.join(' '), c.item_methods ? `item: ${c.item_methods.join(' ')}` : ''].filter(Boolean).join(' · '),
    description: c.description ?? '',
  })), ['collection', 'path', 'methods', 'description'], 60));
  const singles = Object.entries(usableSingletons(doc));
  if (singles.length) {
    lines.push('', 'Singleton resources (§5.9; get and update without an id):');
    lines.push(table(singles.map(([n, c]) => ({ resource: n, path: c.path, methods: (c.methods ?? []).join(' '), description: c.description ?? '' })),
      ['resource', 'path', 'methods', 'description'], 60));
  }
  if (has(doc, 'extensions', 'inherit') && !experimentalOk(doc, 'inherit'))
    lines.push('', `The experimental inherit extension is the one of ${doc.restep}, whose text this CLI does not know: it does not use it (§1.2).`);
  out(lines.join('\n'));
}
function describeSingleton({ name, decl: c }) {
  const L = [`${name}  ${c.path}  (singleton resource, §5.9)`];
  if (c.description) L.push(`  ${c.description}`);
  if (c.parent) L.push(`  Hangs from ${c.parent}${/[{}]/.test(c.path) ? ': --parent with the id of each parent' : ''}`);
  if (c.methods) L.push(`  Methods: ${c.methods.join(', ')}`);
  // 4.3 and 5.9: the effects of its PATCH; undeclared, all three.
  if (!Array.isArray(c.methods) || c.methods.includes('PATCH'))
    L.push(`  Effects: PATCH ${methodEffects(c, 'PATCH', false).join('+') || 'none'}${isObject(c.method_effects) && Object.hasOwn(c.method_effects, 'PATCH') ? '' : ' (undeclared: all three)'}`);
  for (const [a, d] of Object.entries(isObject(c.actions) ? c.actions : {})) {
    if (!isObject(d) || d.on !== undefined || ![undefined, 'POST', 'GET'].includes(d.method)) { L.push(`  Action ${a}: declared with an on or method this CLI does not know; not used (§4.2)`); continue; }
    L.push(`  Action ${a} (${[d.method ?? 'POST', d.safe ? 'safe' : null, d.idempotent ? 'idempotent' : 'not idempotent', effectsText(d)].filter(Boolean).join(', ')})${d.description ? `: ${d.description}` : ''}`);
  }
  const fields = knownFields(c);
  if (fields) L.push(`  Fields: ${fields.join(', ')}`);
  for (const k of ['item', 'update']) if (typeof c.schemas?.[k] === 'string') L.push(`  Schema ${k}: ${c.schemas[k]}`);
  return L.join('\n');
}
// 11.1: what a client counts as the effects of an unsafe action.
const effectsText = (d) => {
  const e = effectsOf(d.effects, d.safe === true ? [] : EFFECTS);
  if (d.safe === true && !e.length) return null;
  return `effects: ${e.length ? e.join(', ') : 'none'}${Array.isArray(d.effects) && e === d.effects ? '' : ' (undeclared or unknown: all three)'}`;
};
function describeCollection(ctx, { name, decl: c }) {
  const L = [`${name}  ${c.path ?? ''}`];
  if (c.description) L.push(`  ${c.description}`);
  if (c.methods || c.item_methods) L.push(`  Methods: ${(c.methods ?? ['?']).join(', ')}; item: ${(c.item_methods ?? ['?']).join(', ')}`);
  if (Array.isArray(c.methods) && !c.methods.includes('GET')) L.push('  It cannot be listed: its methods leave out GET (§4.3)');
  // 4.3 and 11.1: the effects of its unsafe methods.
  const eff = [['POST', false], ['PATCH', true], ['DELETE', true]]
    .filter(([m, item]) => !Array.isArray(c[item ? 'item_methods' : 'methods']) || c[item ? 'item_methods' : 'methods'].includes(m))
    .map(([m, item]) => `${item ? 'item ' : ''}${m} ${methodEffects(c, m, item).join('+') || 'none'}`);
  if (eff.length && (c.method_effects || c.item_method_effects)) L.push(`  Effects: ${eff.join(' · ')}`);
  const filters = Object.entries(usableFilters(c));
  const ignored = [...Object.keys(isObject(c.filter) ? c.filter : {}).filter((f) => !knownFilter(c.filter[f])),
    ...Object.keys(isObject(c.named_filters) ? c.named_filters : {}).filter((f) => !knownNamed(c.named_filters[f]))];
  if (filters.length) {
    L.push('  Filters:');
    for (const line of table(filters.map(([f, d]) => ({ field: f, type: d.type ?? '', operators: (d.ops ?? []).filter((o) => FILTER_OPS.includes(o)).join(', '),
      values: (d.values ?? []).join(', '), notes: [d.required === true && 'required', d.quantifier === 'some' && 'some'].filter(Boolean).join(', '),
      description: d.description ?? '' })), undefined, 60).split('\n')) L.push(`    ${line}`);
  }
  const named = Object.entries(usableNamed(c));
  if (ignored.length) L.push(`  Filters with a type or quantifier this CLI does not know (not used, §4.2): ${ignored.join(', ')}`);
  if (named.length) {
    L.push('  Named filters (no operators; -f name or -f name=value):');
    for (const line of table(named.map(([f, d]) => ({ name: f, value: d?.type ?? 'none (switch)',
      values: (d?.values ?? []).join(', '), notes: [d.required === true && 'required', d.default === true && !d.type && 'default'].filter(Boolean).join(', '),
      description: d?.description ?? '' })), undefined, 60).split('\n')) L.push(`    ${line}`);
  }
  const defs = defaultFilters(c), reqs = requiredFilters(c);
  if (defs.length) L.push(`  Default filters (apply unless -f name=false; --all turns them off): ${defs.join(', ')}`);
  if (reqs.length) L.push(`  Required filters (every list needs them; no full copy): ${reqs.join(', ')}`);
  if (c.sort?.length) L.push(`  Sort: ${c.sort.join(', ')}`);
  const page = [c.max_limit && `max_limit ${c.max_limit}`, c.count && `count ${c.count}`].filter(Boolean);
  if (page.length) L.push(`  Page: ${page.join(' · ')}`);
  const fields = knownFields(c);
  if (fields) L.push(`  Fields: ${fields.join(', ')}`);
  const create = c.schemas?.create;
  if (isObject(create) && create.required?.length) L.push(`  Required on create: ${create.required.join(', ')}`);
  // §4.3: the value a field takes when the POST does not carry it.
  const defaults = Object.entries(isObject(create?.properties) ? create.properties : {}).filter(([, p]) => isObject(p) && Object.hasOwn(p, 'default'));
  if (defaults.length) L.push(`  Defaults on create: ${defaults.map(([f, p]) => `${f}=${JSON.stringify(p.default)}`).join(', ')}`);
  for (const k of ['item', 'create', 'update']) if (typeof c.schemas?.[k] === 'string') L.push(`  Schema ${k}: ${c.schemas[k]}`);
  if (c.language_maps) L.push(`  Language maps: ${Object.keys(c.language_maps).join(', ')}`);
  if (isObject(c.localized)) L.push(`  Localized fields (read-only, in the language of the response): ${Object.entries(c.localized).map(([f, d]) => `${f} from ${d?.source ?? '?'}`).join(', ')}`);
  if (isObject(c.local_times)) L.push(`  Local date-times: ${Object.entries(c.local_times).map(([f, d]) => `${f}${d?.zone ? ` in the zone of ${d.zone}` : ' (floating)'}`).join(', ')}`);
  if (isObject(c.upload)) L.push(`  Upload (create --file): ${(c.upload.media_types ?? []).join(', ')}${Number.isInteger(c.upload.max_size) ? ` · up to ${c.upload.max_size} bytes` : ''}${c.upload.multipart ? ' · multipart' : ''}${createsFromJson(c) ? ' · also creates from JSON (--data)' : ' · only files, no JSON create'}`);
  if (c.upsert === true) L.push('  upsert: update of a free id creates the item (--create-only: only create)');
  if (c.reusable_ids === true) L.push('  reusable_ids: an id can come back as another item after a delete');
  for (const [r, d] of Object.entries(c.relations ?? {})) L.push(`  Relation ${r} → ${d.to}${d.many ? ' (to many)' : ''}${d.include ? ' · include' : ''}${d.description ? ` · ${d.description}` : ''}`);
  if (c.id_from) L.push(`  id: ${({ server: 'assigned by the server', client: 'chosen by the client (required on create)', either: 'the client may choose it' })[c.id_from] ?? `unknown id_from (${c.id_from}): no id is sent on create`}`);
  if (isObject(c.collations)) L.push(`  Collation: ${Object.entries(c.collations).map(([f, v]) => `${f} ${v === 'codepoint' ? 'by code point' : 'the server\'s'}`).join(', ')}`);
  if (c.parent) L.push(`  Subcollection of ${c.parent}: --parent with the id of each parent`);
  if (experimentalOk(ctx.doc, 'inherit')) for (const [f, d] of Object.entries(usableInherit(c))) L.push(`  Inherited ${f}: written in ${d.own}; from ${(d.from ?? []).join(', ') || '—'}${d.description ? ` · ${d.description}` : ''}`);
  for (const [a, d] of Object.entries(c.actions ?? {})) {
    if (!knownAction(d)) { L.push(`  Action ${a}: declared with an on or method this CLI does not know; not used (§4.2)`); continue; }
    const traits = [d.on === 'collection' ? 'collection' : 'item', d.method ?? 'POST', d.safe ? 'safe' : null, d.idempotent ? 'idempotent' : 'not idempotent', effectsText(d)].filter(Boolean);
    L.push(`  Action ${a} (${traits.join(', ')})${d.description ? `: ${d.description}` : ''}`);
    const ps = Object.entries(isObject(d.params) ? d.params : {});
    if (ps.length) L.push(`    Parameters (-P name=value): ${ps.map(([k, p]) => `${k} ${p?.type ?? '?'}${p?.list ? ' list' : ''}${p?.required ? ' required' : ''}`).join(', ')}`);
    if (d.output !== undefined) L.push('    Returns its own result (output), not the item');
  }
  if (c.sync) L.push(`  Sync: retention ${c.sync.retention ?? '?'} s (experimental; this CLI does not use it)`);
  return L.join('\n');
}

async function cmdGet(ctx, [name, id, ...extra]) {
  if (extra.length) throw usage(`Too many arguments: ${extra.join(' ')}.`);
  const coll = collection(ctx, name);
  if (coll.singleton && id !== undefined) throw usage(`"${coll.name}" is a singleton resource: get ${coll.name}, without an id.`);
  const list = id === undefined && !coll.singleton;
  requireMethod(ctx, coll, 'GET', !list);
  const q = buildQuery(ctx, coll, { list });
  const path = coll.singleton ? singletonPath(ctx, coll) : list ? collectionPath(coll, ctx.opts.parent) : itemPath(ctx, coll, id);
  const url = apiUrl(ctx, path);
  url.search = q.toString();
  if (!list) {
    const res = await request(ctx, 'GET', url);
    if (res.curl) return EXIT.ok;
    if (res.status !== 200) return showProblem(ctx, res, coll);
    showLanguage(ctx, coll, res);
    printItem(ctx, res.data);
    return EXIT.ok;
  }
  const fmt = format(ctx, true);
  let res = await request(ctx, 'GET', url);
  if (res.curl) return EXIT.ok;
  if (res.status !== 200) return showProblem(ctx, res, coll);
  showLanguage(ctx, coll, res);
  if (!isObject(res.data) || !Array.isArray(res.data.items)) throw new CliError(EXIT.other, 'The response is not a Restep collection (items is missing).');
  if (ctx.opts.count) {
    const { total, total_estimated: est } = res.data;
    if (typeof total !== 'number') throw new CliError(EXIT.other, 'The response has no total.');
    if (ctx.opts.format === 'json') out(json(est ? { total, total_estimated: true } : { total }));
    else out(String(total));
    if (est && ctx.opts.format !== 'json') console.error('(approximate total)');
    return EXIT.ok;
  }
  if (!ctx.opts.all) {
    if (fmt === 'json') out(json(res.data));
    else emitRows(fmt, res.data.items);
    if (fmt !== 'json' && res.data.next) console.error(`There is more: --all walks all pages (next: ${res.data.next})`);
    return EXIT.ok;
  }
  // --all: follows next as is (§5.2) until null.
  const items = [];
  const seen = new Set([String(url)]);
  for (;;) {
    if (fmt === 'ndjson') emitRows(fmt, res.data.items); else items.push(...res.data.items);
    const next = res.data.next;
    if (next === null || next === undefined) break;
    const nextUrl = String(checkScheme(ctx, new URL(next, res.url)));
    if (seen.has(nextUrl)) throw new CliError(EXIT.other, `The API repeats page ${nextUrl}: stopping to avoid a loop.`);
    seen.add(nextUrl);
    res = await request(ctx, 'GET', nextUrl);
    if (res.status !== 200) return showProblem(ctx, res, coll);
    if (!isObject(res.data) || !Array.isArray(res.data.items)) throw new CliError(EXIT.other, 'A page is not a Restep collection (items is missing).');
  }
  if (fmt === 'json') out(json({ items, next: null }));
  else if (fmt !== 'ndjson') emitRows(fmt, items);
  return EXIT.ok;
}
function emitRows(fmt, rows) {
  if (fmt === 'ndjson') { for (const r of rows) out(JSON.stringify(r)); return; }
  if (!rows.length) { if (fmt === 'table') console.error('(no items)'); return; }
  out(fmt === 'csv' ? csv(rows) : table(rows));
}

function idempotencyHeader(ctx) {
  const key = ctx.opts.idempotencyKey;
  // 7.1: with "anonymous": false, a request without credentials carries no Idempotency-Key (it would give 400).
  const anonymousRefused = !ctx.opts.raw && ctx.doc?.idempotency?.anonymous === false && !hasCredentials(ctx);
  if (anonymousRefused) {
    if (key !== undefined) throw local('The API does not accept Idempotency-Key without credentials ("anonymous": false, §7.1): pass --token or drop --idempotency-key.');
    return {};
  }
  if (key !== undefined) {
    if (!/^[\x20\x21\x23-\x5b\x5d-\x7e]*$/.test(key)) throw usage('--idempotency-key only allows visible ASCII characters, without quotes or backslashes.');
    return { 'idempotency-key': `"${key}"` };
  }
  // 7.1: the client does not count on the key if the server does not announce writes, but sending it does no harm.
  return ctx.opts.raw || has(ctx.doc, 'profiles', 'writes') ? { 'idempotency-key': `"${randomUUID()}"` } : {};
}
const preferHeader = (ctx) => (ctx.opts.minimal ? { prefer: 'return=minimal' } : {});
function printWrite(ctx, res) {
  if (res.data !== null && res.data !== undefined) return printItem(ctx, res.data);
  // No body (204, return=minimal): what matters is in the headers.
  const info = { status: res.status };
  for (const h of ['location', 'etag']) if (res.headers.get(h)) info[h] = res.headers.get(h);
  if (res.status !== 204 || info.etag) printItem(ctx, info);
}

// 5.1: id_from says who chooses the id. With an unknown value, the client MUST NOT send id.
function checkIdFrom(ctx, coll, value) {
  if (!coll.decl || !isObject(value)) return;
  const from = coll.decl.id_from;
  const sent = Object.hasOwn(value, 'id');
  if (from !== undefined && !['server', 'client', 'either'].includes(from)) {
    if (sent) throw local(`"${coll.name}" declares id_from ${JSON.stringify(from)}, which this CLI does not know: id cannot be sent on create (§5.1).`);
    return;
  }
  if (ctx.opts.raw) return;
  if (sent && (from === undefined || from === 'server')) throw local(`In "${coll.name}" the server assigns the id: remove id from the body (§5.1).`);
  if (!sent && from === 'client') throw local(`In "${coll.name}" the client chooses the id: the body needs id (§5.1).`, ['Preferably a random one, such as a UUID (§13.6).']);
}
async function cmdCreate(ctx, [name, ...extra]) {
  if (extra.length) throw usage(`Too many arguments: ${extra.join(' ')}.`);
  const coll = collection(ctx, name);
  notSingleton(coll, 'it cannot be created');
  requireMethod(ctx, coll, 'POST', false);
  if (ctx.opts.file !== undefined) return cmdUpload(ctx, coll);
  if (ctx.opts.type !== undefined) throw usage('--type goes with --file.');
  // 5.1: a collection with upload and without schemas.create takes only files.
  if (!ctx.opts.raw && coll.decl && !createsFromJson(coll.decl))
    throw local(`"${coll.name}" declares upload without create: it takes only files, not JSON (§5.1).`, [`Use create ${coll.name} --file <path>.`]);
  const body = readBody(ctx, true);
  checkIdFrom(ctx, coll, body.value);
  validateBody(ctx, coll.decl?.schemas?.create, body.value, `create schema of "${coll.name}"`);
  const url = apiUrl(ctx, collectionPath(coll, ctx.opts.parent));
  await confirmEffects(ctx, methodEffects(coll.decl, 'POST', false), `Creating in "${coll.name}"`);
  const headers = { 'content-type': 'application/json', ...idempotencyHeader(ctx), ...preferHeader(ctx), ...ifMatchHeader(ctx) };
  const res = await request(ctx, 'POST', url, { body: body.text, headers });
  if (res.curl) return EXIT.ok;
  if (res.status >= 400) return showProblem(ctx, res, coll);
  if (res.headers.get('idempotent-replayed') === 'true') {
    console.error('(replay: the API returns the stored response for this Idempotency-Key)');
    // 7.3: a replayed 201 without body carries no ETag; a validator comes from reading the item.
    if (res.status === 201 && (res.data === null || res.data === undefined) && !res.headers.get('etag'))
      console.error(`(no ETag in a replay without body: read the item${res.headers.get('location') ? ` at ${res.headers.get('location')}` : ''} for one)`);
  }
  printWrite(ctx, res);
  return EXIT.ok;
}

// 5.1: create from a file in a collection that declares upload: its bytes, with their own Content-Type
// and the original name in Content-Disposition (RFC 6266).
const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.zip': 'application/zip' };
const typeMatches = (range, type) => range === type || (range.endsWith('/*') && type.startsWith(range.slice(0, -1))) || range === '*/*';
// 5.1: schemas.create announces creation from JSON; without upload, a collection always creates from JSON.
const createsFromJson = (decl) => !isObject(decl?.upload) || (decl.schemas?.create !== undefined && decl.schemas?.create !== null);
// 5.1, RFC 7578: a multipart/form-data body with exactly one part, file, that holds the bytes with their
// own Content-Type and original name (in UTF-8, with ", CR, LF and \ escaped as %XX, section 4.2). The
// client MUST send a filename (5.1): the CLI always has one, the file's own name.
function multipartBody(bytes, type, name) {
  const boundary = `restep-${randomUUID()}`;
  const filename = name.replace(/["\r\n\\]/g, (c) => encodeURIComponent(c));
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`;
  return { body: Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
}
async function cmdUpload(ctx, coll) {
  if (ctx.opts.data !== undefined) throw usage('--file and --data do not go together: a file is the whole body.');
  const upload = coll.decl?.upload;
  if (!ctx.opts.raw && coll.decl && !isObject(upload)) throw local(`"${coll.name}" does not declare upload: it creates only from JSON (§5.1).`);
  let bytes;
  try { bytes = readFileSync(ctx.opts.file); } catch (e) { throw usage(`Could not read ${ctx.opts.file}: ${e.code ?? e.message}.`); }
  const type = ctx.opts.type ?? MEDIA_TYPES[extname(ctx.opts.file).toLowerCase()] ?? 'application/octet-stream';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(type)) throw usage(`--type is not a media type: ${type}.`);
  if (!ctx.opts.raw && isObject(upload)) {
    const ranges = Array.isArray(upload.media_types) ? upload.media_types : [];
    if (!ranges.some((m) => typeMatches(String(m).toLowerCase(), type.toLowerCase())))
      throw local(`"${coll.name}" does not accept ${type} files (§5.1).`, [`Accepted: ${ranges.join(', ') || 'none'}. Use --type if the extension misleads.`]);
    if (Number.isInteger(upload.max_size) && bytes.length > upload.max_size)
      throw local(`The file has ${bytes.length} bytes and "${coll.name}" accepts at most ${upload.max_size} (§5.1).`);
  }
  const name = basename(ctx.opts.file);
  // 5.1: an outer Content-Type of multipart/form-data always selects multipart upload, so a file of that
  // type goes only as the file part of a multipart body, never to a collection without upload.multipart
  // (not even with --raw). Only application/json itself selects creation from JSON (a +json type is a
  // file like any other): where the collection also creates items from JSON, a JSON file goes only as
  // the file part of multipart/form-data, which it must declare; where it does not, a JSON file its
  // media_types admit goes as its bytes.
  const isForm = type.toLowerCase() === 'multipart/form-data';
  if (isForm && (!isObject(upload) || upload.multipart !== true) && (coll.decl || !ctx.opts.raw))
    throw local(`"${coll.name}" does not declare multipart: it takes no multipart/form-data body (§5.1).`);
  const asForm = isObject(upload) && (isForm || (createsFromJson(coll.decl) && type.toLowerCase() === 'application/json'));
  if (asForm && upload.multipart !== true)
    throw local(`"${coll.name}" also creates items from JSON and does not declare multipart: it cannot take a JSON file (§5.1).`);
  const url = apiUrl(ctx, collectionPath(coll, ctx.opts.parent));
  await confirmEffects(ctx, methodEffects(coll.decl, 'POST', false), `Uploading to "${coll.name}"`);
  if (asForm) {
    if (ctx.opts.curl) {
      console.log(`${curlOf('POST', String(url), { ...baseHeaders(ctx, String(url)), ...idempotencyHeader(ctx), ...preferHeader(ctx) })} -F ${shq(`file=@${ctx.opts.file};type=${type}`)}`);
      return EXIT.ok;
    }
    const form = multipartBody(bytes, type, name);
    const res = await request(ctx, 'POST', url, { body: form.body, headers: { 'content-type': form.type, ...idempotencyHeader(ctx), ...preferHeader(ctx) } });
    if (res.status >= 400) return showProblem(ctx, res, coll);
    printWrite(ctx, res);
    return EXIT.ok;
  }
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const disposition = `attachment; filename="${ascii}"${ascii === name ? '' : `; filename*=UTF-8''${encodeURIComponent(name)}`}`;
  const headers = { 'content-type': type, 'content-disposition': disposition, ...idempotencyHeader(ctx), ...preferHeader(ctx) };
  if (ctx.opts.curl) {
    const h = { ...baseHeaders(ctx, String(url)), ...headers };
    console.log(`${curlOf('POST', String(url), h)} --data-binary @${shq(ctx.opts.file)}`);
    return EXIT.ok;
  }
  const res = await request(ctx, 'POST', url, { body: bytes, headers });
  if (res.status >= 400) return showProblem(ctx, res, coll);
  printWrite(ctx, res);
  return EXIT.ok;
}

const quoteEtag = (e) => (/^(W\/)?".*"$/.test(e) || e === '*' ? e : `"${e}"`);
function ifMatchHeader(ctx) {
  return ctx.opts.ifMatch !== undefined ? { 'if-match': quoteEtag(ctx.opts.ifMatch) } : {};
}
// --safe: reads the item to take its ETag (or its _etag) and writes with If-Match (§7.2).
async function safeIfMatch(ctx, coll, url) {
  if (!ctx.opts.safe) return ifMatchHeader(ctx);
  if (ctx.opts.ifMatch !== undefined) throw usage('--safe and --if-match do not go together: --safe already sets If-Match.');
  if (ctx.opts.curl) {
    console.log(`# --safe: first the current ETag is read\n${curlOf('GET', String(url), baseHeaders(ctx, String(url)))}`);
    return { 'if-match': '<ETag from the GET above>' };
  }
  const res = await request(ctx, 'GET', url);
  if (res.status !== 200) return { problem: res };
  // 7.2: with content encoding the ETag header may differ; then _etag wins.
  const tag = res.headers.get('etag');
  const etag = isObject(res.data) && typeof res.data._etag === 'string' ? res.data._etag : tag && !tag.startsWith('W/') ? tag : null;
  if (!etag) throw new CliError(EXIT.other, 'The item has no strong ETag: --safe cannot protect the write.');
  return { 'if-match': etag };
}

async function cmdUpdate(ctx, [name, id, ...extra]) {
  if (extra.length) throw usage(`Too many arguments: ${extra.join(' ')}.`);
  const coll = collection(ctx, name);
  if (coll.singleton && id !== undefined) throw usage(`"${coll.name}" is a singleton resource: update ${coll.name} --data '{...}', without an id.`);
  if (!coll.singleton && id === undefined) throw usage('Missing the id: restep update <collection> <id> --data \'{...}\'.');
  requireMethod(ctx, coll, 'PATCH', true);
  const body = readBody(ctx, true);
  validateBody(ctx, coll.decl?.schemas?.update, body.value, `update schema of "${coll.name}"`);
  if (!coll.singleton && !ctx.opts.raw && body.value && 'id' in body.value && String(body.value.id) !== id)
    throw local('The patch has an id different from the item: the id cannot change (§5.1).');
  // 5.1: with upsert, a PATCH to a free id creates the item; If-None-Match: * makes it only create.
  if (ctx.opts.createOnly) {
    if (!ctx.opts.raw && coll.decl && coll.decl.upsert !== true) throw local(`"${coll.name}" does not declare upsert: a PATCH does not create (§5.1).`);
    if (ctx.opts.safe || ctx.opts.ifMatch !== undefined) throw usage('--create-only does not go with --safe or --if-match.');
  }
  const url = apiUrl(ctx, coll.singleton ? singletonPath(ctx, coll) : itemPath(ctx, coll, id));
  const cond = ctx.opts.createOnly ? { 'if-none-match': '*' } : await safeIfMatch(ctx, coll, url);
  if (cond.problem) return showProblem(ctx, cond.problem, coll);
  // 4.3 and 5.9: a singleton declares the effects of its PATCH in method_effects; undeclared, all three.
  await confirmEffects(ctx, methodEffects(coll.decl, 'PATCH', !coll.singleton), coll.singleton ? `Updating "${coll.name}"` : `Updating "${coll.name}/${id}"`);
  const headers = { 'content-type': 'application/merge-patch+json', ...cond, ...preferHeader(ctx) };
  // 5.1 and 5.7: with reusable_ids, a PATCH is safe to repeat only with If-Match.
  const res = await request(ctx, 'PATCH', url, { body: body.text, headers, repeatable: !(coll.decl?.reusable_ids === true && !cond['if-match']) });
  if (res.curl) return EXIT.ok;
  if (res.status >= 400) return showProblem(ctx, res, coll);
  if (res.status === 201) console.error(`(created: "${coll.name}" declares upsert, §5.1)`);
  printWrite(ctx, res);
  return EXIT.ok;
}

async function cmdDelete(ctx, [name, id, ...extra]) {
  if (id === undefined) throw usage('Missing the id: restep delete <collection> <id>.');
  if (extra.length) throw usage(`Too many arguments: ${extra.join(' ')}.`);
  const coll = collection(ctx, name);
  notSingleton(coll, 'it cannot be deleted');
  requireMethod(ctx, coll, 'DELETE', true);
  if (ctx.opts.data !== undefined) throw usage('delete takes no body.');
  const url = apiUrl(ctx, itemPath(ctx, coll, id));
  const cond = await safeIfMatch(ctx, coll, url);
  if (cond.problem) return showProblem(ctx, cond.problem, coll);
  await confirmEffects(ctx, methodEffects(coll.decl, 'DELETE', true), `Deleting "${coll.name}/${id}"`);
  // 5.1 and 5.7: with reusable_ids, a DELETE is safe to repeat only with If-Match (the id may be another item by then).
  const res = await request(ctx, 'DELETE', url, { headers: cond, repeatable: !(coll.decl?.reusable_ids === true && !cond['if-match']) });
  if (res.curl) return EXIT.ok;
  if (res.status >= 400) return showProblem(ctx, res, coll);
  if (ctx.opts.verbose || process.stderr.isTTY) console.error(`Deleted: ${coll.name}/${id}`);
  return EXIT.ok;
}

// 11.1: POST /collection/id:action or /collection:action; GET if the action declares it.
async function cmdAction(ctx, [name, a, b, ...extra]) {
  if (extra.length) throw usage(`Too many arguments: ${extra.join(' ')}.`);
  if (a === undefined) throw usage('Usage: restep action <collection> [<id>] <action>.');
  const [id, action] = b === undefined ? [undefined, a] : [a, b];
  const coll = collection(ctx, name);
  // 5.9 and 11.1: a singleton's actions carry no on, and are used at {path}:{name}.
  if (coll.singleton && id !== undefined) throw usage(`"${coll.name}" is a singleton resource: restep action ${coll.name} <action>, without an id.`);
  const known = (d) => (coll.singleton ? isObject(d) && d.on === undefined && [undefined, 'POST', 'GET'].includes(d.method) : knownAction(d));
  let decl = null;
  if (!ctx.opts.raw && coll.decl) {
    if (!has(ctx.doc, 'extensions', 'actions')) throw local('The API does not announce the actions extension.');
    const actions = isObject(coll.decl.actions) ? coll.decl.actions : {};
    decl = actions[action];
    const what = coll.singleton ? `Singleton resource "${coll.name}"` : `Collection "${coll.name}"`;
    if (!decl) throw local(`${what} has no action "${action}".`, unknownHints(action, Object.keys(actions).filter((a) => known(actions[a])), 'Actions'));
    if (!known(decl)) throw local(`Action "${action}" is declared with an on or method this CLI does not know (${JSON.stringify({ on: decl.on, method: decl.method })}): not used (§4.2).`);
    if (decl.on === 'item' && id === undefined) throw usage(`"${action}" is an item action: restep action ${coll.name} <id> ${action}.`);
    if (decl.on === 'collection' && id !== undefined) throw usage(`"${action}" is a collection action: restep action ${coll.name} ${action}.`);
  }
  const method = decl?.method === 'GET' ? 'GET' : 'POST';
  const body = readBody(ctx, false);
  if (method === 'GET' && body !== undefined) throw local(`"${action}" uses GET: it takes no body.`);
  if (body) validateBody(ctx, decl?.input, body.value, `input schema of "${action}"`);
  const base = coll.singleton ? singletonPath(ctx, coll) : id === undefined ? collectionPath(coll, ctx.opts.parent) : itemPath(ctx, coll, id);
  const url = apiUrl(ctx, `${base}:${action}`);
  // 11.1: the params of a GET action go in the query; undeclared ones give unsupported_parameter.
  if (ctx.opts.param.length && method !== 'GET') throw usage(`--param is for actions that use GET; "${action}" takes a body (--data).`);
  // 5.3 and 11.1: a GET action without params is "params": {}: it takes no query parameter at all.
  const params = !decl ? null : isObject(decl.params) ? decl.params : {};
  const given = new Set();
  for (const raw of ctx.opts.param) {
    const i = raw.indexOf('=');
    if (i < 1) throw usage(`Malformed parameter: "${raw}". Use name=value.`);
    const [k, v] = [raw.slice(0, i), raw.slice(i + 1)];
    if (given.has(k)) throw local(`Parameter ${k} appears twice.`);
    given.add(k);
    if (params && !ctx.opts.raw) {
      const p = params[k];
      if (!isObject(p)) {
        if (!Object.keys(params).length) throw local(`"${action}" takes no parameters: the API would answer unsupported_parameter (§11.1).`);
        throw local(`"${action}" has no parameter "${k}".`, unknownHints(k, Object.keys(params), 'Parameters'));
      }
      const values = p.list === true ? v.split(',') : [v];
      if (values.some((x) => x === '')) throw local(`Parameter ${k}: an empty value${p.list ? ' in the list' : ''}.`);
      if (FILTER_TYPES.includes(p.type)) for (const x of values) checkValue(p, x, `Parameter ${k}`);
    }
    url.searchParams.append(k, v);
  }
  if (params && !ctx.opts.raw) {
    const missing = Object.entries(params).filter(([k, p]) => isObject(p) && p.required === true && !given.has(k)).map(([k]) => k);
    if (missing.length) throw local(`"${action}" requires the parameter ${missing.join(', ')}.`, missing.map((m) => `Use -P ${m}=value.`));
  }
  // 11.1: without effects an unsafe action has all three and a safe one none; an unknown value counts as all three.
  if (decl) await confirmEffects(ctx, effectsOf(decl.effects, decl.safe === true ? [] : EFFECTS), `The action "${action}"`);
  const headers = { ...preferHeader(ctx), ...ifMatchHeader(ctx) };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    // 7.1: non-idempotent actions accept Idempotency-Key, like any non-idempotent POST.
    if (!decl?.idempotent) Object.assign(headers, idempotencyHeader(ctx));
  }
  const res = await request(ctx, method, url, { body: method === 'POST' ? (body?.text ?? '{}') : undefined, headers });
  if (res.curl) return EXIT.ok;
  if (res.status >= 400) return showProblem(ctx, res, coll);
  printWrite(ctx, res);
  return EXIT.ok;
}

// ── Completion ────────────────────────────────────────────────────────────
const ZSH = `#compdef restep
# restep completion for zsh. In ~/.zshrc, after compinit:
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
const BASH = `# restep completion for bash. In ~/.bashrc:
#   eval "$(restep completion bash)"
_restep() {
  local line="\${COMP_LINE:0:COMP_POINT}" cur="\${COMP_WORDS[COMP_CWORD]}"
  local full="\${line##*[[:space:]]}"
  # bash splits the word at = and :, so whatever comes before the current part is removed
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
  // A trailing space leaves an empty word: the one being completed.
  return line.trimStart().split(/\s+/).slice(1); // without "restep"
}
async function complete(words) {
  const cur = words.length ? words[words.length - 1] : '';
  const before = words.slice(0, -1);
  const config = loadConfig();
  const aliases = Object.keys(config.aliases ?? {}).map((a) => `@${a}`);
  const optNames = [...Object.keys(VALUE_OPTS), ...Object.keys(BOOL_OPTS)].filter((k) => k.length > 1).map((k) => `--${k}`);
  // What comes before the cursor: positionals and the option that expects a value.
  let pending = null;
  const pos = [];
  const opts = { filter: [], header: [], parent: [], param: [] };
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
  const singles = ['get', 'update', 'describe'].includes(command) ? Object.keys(usableSingletons(doc)) : [];
  if (rest.length === 1 && !pending) return [...Object.keys(colls), ...singles.filter((n) => !Object.hasOwn(colls, n))];
  const c = colls[name] ?? usableSingletons(doc)[name];
  if (!c) return [];
  const listAfter = (prefixWord, options) => { // comma lists: completes the last piece
    const i = prefixWord.lastIndexOf(',');
    const head = prefixWord.slice(0, i + 1), used = head.split(',').map((u) => u.replace(/^-/, ''));
    return options.filter((o) => !used.includes(o.replace(/^-/, ''))).map((o) => head + o);
  };
  if (pending === 'filter') {
    const m = /^([^[\]=<>!]+)(\[[a-z]+\])?(=|!=|<=|>=|<|>)(.*)$/.exec(cur);
    const filters = usableFilters(c);
    if (m && filters[m[1]]) {
      const d = filters[m[1]], head = cur.slice(0, cur.length - m[4].length);
      const op = m[2]?.slice(1, -1);
      const values = op === 'null' || d.type === 'boolean' ? ['true', 'false'] : d.type === 'enum' ? d.values ?? [] : [];
      return op === 'in' ? listAfter(m[4], values).map((v) => head + v) : values.map((v) => head + v);
    }
    const named = Object.entries(usableNamed(c)).map(([f, d]) => (d?.type ? `${f}=` : f));
    return [...Object.entries(filters).flatMap(([f, d]) => [`${f}=`, ...(d.ops ?? []).filter((op) => FILTER_OPS.includes(op)).map((op) => `${f}[${op}]=`)]), ...named];
  }
  if (pending === 'sort') return listAfter(cur, (c.sort ?? []).flatMap((s) => [s, `-${s}`]));
  if (pending === 'fields') return listAfter(cur, knownFields(c) ?? []);
  if (pending) return [];
  if (command === 'action' && isObject(c.actions)) {
    const on = (kind) => Object.entries(c.actions).filter(([, d]) => knownAction(d) && d.on === kind).map(([a]) => a);
    if (args.length === 0) return on('collection');
    if (args.length === 1) return on('item');
  }
  return [];
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main(argv) {
  if (argv[0] === '__complete') {
    const words = argv[1] === '--line' ? splitLine(argv[2] ?? '') : argv.slice(argv[1] === '--' ? 2 : 1);
    try { for (const c of await complete(words)) out(c); } catch { /* completion never fails loudly */ }
    return EXIT.ok;
  }
  const { opts, pos } = parseArgs(argv);
  if (opts.version) { out(VERSION); return EXIT.ok; }
  if (opts.help || !pos.length) { out(HELP); return opts.help ? EXIT.ok : EXIT.usage; }
  if (pos[0] === 'completion') {
    const shell = pos[1];
    if (shell === 'zsh') process.stdout.write(ZSH);
    else if (shell === 'bash') process.stdout.write(BASH);
    else throw usage('Usage: restep completion zsh|bash');
    return EXIT.ok;
  }
  if (opts.retry !== undefined && !/^\d+$/.test(opts.retry)) throw usage('--retry must be an integer.');
  const target = resolveTarget(pos[0], opts);
  const [command = 'describe', ...args] = target.consumed ? pos.slice(1) : pos;
  if (!COMMANDS.includes(command)) throw usage(`Unknown command: ${command}.`, unknownHints(command, COMMANDS, 'Commands'));
  if (command === 'completion') throw usage('Usage: restep completion zsh|bash (without a URL).');
  const ctx = { ...target, opts, retry: Number(opts.retry ?? 0), doc: null, cached: false };
  const run = { describe: cmdDescribe, get: cmdGet, create: cmdCreate, update: cmdUpdate, delete: cmdDelete, action: cmdAction }[command];
  const load = async (fresh) => {
    try {
      const d = await discover(ctx, { fresh });
      ctx.doc = d.doc; ctx.cached = d.cached;
    } catch (e) {
      // With --raw or --curl it goes on without discovery; otherwise the error wins.
      if (!(ctx.opts.raw || ctx.opts.curl) || command === 'describe' || e.notRestep1) {
        if (e.response) return showProblem(ctx, e.response);
        throw e;
      }
      if (ctx.opts.verbose) console.error(`(no discovery: ${e.message})`);
    }
    return null;
  };
  const failed = await load(Boolean(opts.noCache));
  if (failed !== null) return failed;
  try {
    return await run(ctx, args);
  } catch (e) {
    // A local rejection with the cached discovery is checked against a freshly fetched one.
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
    if (e.exit === EXIT.local) console.error('  (rejected before sending; --raw sends it anyway)');
    process.exitCode = e.exit;
  } else {
    console.error(`restep: unexpected error: ${e.stack ?? e}`);
    process.exitCode = EXIT.other;
  }
});
