# restep (CLI)

Generic CLI for any [Restep 1](https://restep.wubytes.com/1/) API, in the style of httpie but
knowing up front what the API offers: it reads the discovery document (§4.2) and validates
collections, filters, sort, fields and bodies before sending anything. A single file, Node 18+,
no dependencies.

```bash
npx restep-cli http://localhost:8080 get books -f category=novela-negra -s -price
# or, installed (npm install -g restep-cli), with its `restep` command:
restep http://localhost:8080 get books -f category=novela-negra -s -price
```

## Commands

| Command | Request |
|---|---|
| `restep <url> describe [collection\|resource]` | `GET` of the root. Without a name: version, profiles, extensions, collections and singletons; with a collection: filters (type, operators, values), sort, page, fields, required fields and defaults on create (§4.3), who picks the `id` (`id_from`), `collations`, the parent of a subcollection, language maps, relations, inherited fields and actions |
| `restep <url> get <collection>` | `GET` of the collection, one page |
| `restep <url> get <collection> <id>` | `GET` of the item |
| `restep <url> get <resource>` | `GET` of a singleton (§5.9), such as `/me`; accepts `--fields` |
| `restep <url> update <resource> --data …` | `PATCH` of a singleton, no id |
| `restep <url> create <collection> --data …` | `POST` with a random `Idempotency-Key` if the API announces `writes` |
| `restep <url> update <collection> <id> --data …` | `PATCH` with `application/merge-patch+json` |
| `restep <url> delete <collection> <id>` | `DELETE` |
| `restep <url> action <collection> [<id>] <name>` | `POST /collection/id:name` or `/collection:name`; `GET` if the action declares it (§11.1) |
| `restep completion zsh\|bash` | completion script |

With no command, `restep <url>` is the same as `describe`.

### Querying

- `-f, --filter` (repeatable): `field=value` (that is `filter[field]`), `field[op]=value`, or the
  shortcuts `field!=v`, `field<v`, `field<=v`, `field>v`, `field>=v`. `in` takes commas:
  `-f 'category[in]=poesia,ensayo'`. Translations, as discovery declares them:
  `-f name.es-mx=Goma`. A named filter (§6.1) takes no operator: `-f featured` if it is a
  switch, or `-f search=niebla` if it takes a value; `describe` lists them with their description.
- `-s, --sort -rating,title`, `--fields title,price` (also on an item `get`),
  `-n, --limit N`.
- `-i, --include author,category.parent` (`relations` profile, §9), on the collection and on the
  item: each step is a relation declared with `"include": true`, no deeper than `include_depth`
  (1 if not declared). A relation to several collections (`to` as a list) can only come last in
  the path. Not allowed on a singleton (§5.9).
- `--all` follows `next` as is until `null` (§5.2); with `--limit` it sets the size of each page.
  With `ndjson` it writes each page as it arrives.
- `--count` prints only the total (it asks for `count=true` and `limit=1`); with `-o json`,
  `{"total": N}` plus `total_estimated` if the total is approximate.
- `-o, --format json|ndjson|csv|table`. By default, `table` for lists in a terminal and `json`
  everywhere else (and whenever output goes to a pipe). `csv` and `table` put one column per
  field, without members that start with `_`; objects go in as JSON.

### Writing

- `-d, --data '{...}'`, `--data @file.json` or `--data -` (standard input).
- `create` and non-idempotent actions carry a random `Idempotency-Key` (a Structured Fields
  string, §7.1). `--idempotency-key key` uses yours: repeating the command with the same key
  does not duplicate, and the CLI warns on stderr that the response is a replay.
- `--if-match <etag>` (with or without quotes). `--safe` first does a `GET` of the item and writes
  with `If-Match` set to its `_etag` or, if it has none, its `ETag` header (§7.2).
- `--minimal` sends `Prefer: return=minimal`; if the response has no body, it shows `status`,
  `location` and `etag`.
- `--retry N` retries network errors, `429`, `502`, `503` and `504` (and `409` with a key: an
  identical request still in progress), honouring `Retry-After`. Only on reads, `DELETE` and
  requests with `Idempotency-Key`, which are the ones that can be repeated without duplicating.

### Validation before sending

With discovery in hand, the CLI rejects locally (exit code 3), with «¿quisiste decir…?»
("did you mean…?") suggestions:

- a collection, filter, operator, sort key, `--fields` field or action that does not exist;
- a value that does not fit the filter type (`integer`, `number`, `decimal`, `boolean`, `date`,
  `datetime`, `duration`, `enum` with its `values`), `null` without `true`/`false`, an empty
  `in`, or the same filter twice;
- `--limit` beyond `max_limit`, `--count` without `count` declared, filters without the `query`
  profile;
- a method that `methods` or `item_methods` do not declare;
- a body that does not satisfy `schemas.create`, `schemas.update` or the action's `input`, when
  they are embedded (§4.3). The validator covers the usual JSON Schema: `type`, `enum`,
  `pattern`, `required`, `properties`, `patternProperties`, `additionalProperties`,
  `propertyNames`, `anyOf`, `oneOf`, `items`, `minimum`, `maximum` and `maxLength`.

`--raw` skips all of that and sends anyway (and, if the collection is not in discovery, uses
`/<collection>`). If the rejection was based on the cached discovery, the CLI fetches it again
before giving up, in case the API has changed.

### Errors and exit codes

`problem+json` responses (§5.4) are shown readably on stderr: status, `code`, `title`, `detail`,
`parameter`, `reason` and each `errors` entry with its pointer. It adds hints: the filters or
sort keys the collection does offer on `unsupported_parameter` (and that retrying is pointless),
the own field on a `read_only` over an inherited value (§11.6), `--safe` on `412`, how to pass
the token and the OAuth metadata URL on `401`. With `-o json` the problem also goes to stdout
as is.

| Code | When |
|---|---|
| 0 | success |
| 1 | other error (a response that is not Restep, a loop in `next`…) |
| 2 | wrong usage: arguments, malformed JSON, unknown alias |
| 3 | rejected locally against discovery |
| 4 | network error |
| 5 | `400` |
| 6 | `401`, `403` |
| 7 | `404`, `410` |
| 8 | `409`, `412`, `428` |
| 9 | `422` |
| 10 | other `4xx` |
| 11 | `5xx` |

### Debugging

- `-v, --verbose` writes each request and response with their headers to stderr (the token as
  `Bearer ****`), including the discovery one when it does not come from the cache.
- `--curl` prints the equivalent `curl` without sending it. The token is never printed: the curl
  uses `"Authorization: Bearer $RESTEP_TOKEN"`. With `--safe` it prints the `GET` and the `PATCH`
  with a placeholder for the ETag.

### Draft 6: what it does as a client (§12.2)

- **Version (§1.1).** Accepts `restep` with a suffix (`1.0-draft.6`, `1.0-rc.1`) and shows it in
  `describe`. A discovery whose `restep` does not follow the grammar or whose major version is
  not 1 is not Restep 1: the CLI stops with code 1, also with `--raw` or `--curl`, instead of
  assuming plain `core`.
- **Experimental parts (§1.2).** The only one it uses is `inherit` (the own-field hint and the
  inherited fields in `describe`), and only if the API announces the extension and declares
  `"restep": "1.0-draft.6"`, the text it knows. With another version, `describe` warns and does
  not use it. It never uses `sync`, `batch`, `filter-expr` or `query-method`.
- **Unknown values (§4.2).** A filter or named filter with a `type` it does not know, an operator
  outside the list in §6.1, and an action with an `on` or `method` it does not know are treated
  as undeclared: `describe` flags them, validation rejects them and completion does not offer
  them.
- **Singletons (§5.9).** `get` and `update` without an id; `create`, `delete` and `action` are
  rejected locally. A singleton with a template in `path` or with `parent` is ignored.
- **`id_from` (§5.1).** With a value it does not know, it does not send `id` on `create` (not
  even with `--raw`). It also warns locally about an `id` where the server assigns it, and about
  a missing one with `"client"`.
- **`idempotency.anonymous: false` (§7.1).** Without credentials (no token, no `-H Authorization`
  or `Cookie`) it does not add a random `Idempotency-Key`; `--idempotency-key` is rejected
  locally.
- **`Content-Type`** `application/json` on `create` and `POST` actions, and
  `application/merge-patch+json` on `update` (§3, §5.1). A literal `+` in a value goes as `%2B`
  (§5.2): the CLI builds the query with `URLSearchParams`.
- **Links (§3).** It does not follow a `next` or a `service-desc` whose scheme is neither `https`
  nor the root's. Credentials, including those passed with `-H` (`Authorization`, `Cookie`,
  `Proxy-Authorization`, `DPoP`), only go to the API's origin (§4.3).

## Profiles

In order of preference, the API comes from the first argument (a URL or `@alias`), from
`RESTEP_URL` or from the `default` alias in the config file. The token, from `--token`, from the
alias (`token` or `token_env`, the name of an environment variable) or from `RESTEP_TOKEN`. The
language (`Accept-Language`, §5.6), from `--language`, from the alias or from `RESTEP_LANGUAGE`.

`~/.config/restep/config.json` (or `$XDG_CONFIG_HOME/restep/config.json`, or `RESTEP_CONFIG`):

```json
{
  "default": "tienda",
  "aliases": {
    "tienda": { "url": "https://api.tienda.example/v1/", "token_env": "TIENDA_TOKEN", "language": "es" },
    "local": "http://localhost:8080/"
  }
}
```

```bash
restep @tienda get pedidos -f estado=pagado
```

Credentials only go to the API's origin (§4.3): a `next` or any other link to another origin is
fetched without them.

## Completion

```bash
eval "$(restep completion zsh)"    # in ~/.zshrc, after compinit
eval "$(restep completion bash)"   # in ~/.bashrc
```

Needs `restep` on the `PATH` (`npm link` in this folder, or an alias). It suggests commands,
aliases, collections, filters (`field=` and `field[op]=`), `enum` values (also inside an `in`),
sort keys with and without `-`, `--fields` fields, formats, options and actions. It reads them
from discovery with a short local cache.

## Discovery cache

In `~/.cache/restep/` (or `$XDG_CACHE_HOME/restep/`, or `RESTEP_CACHE_DIR`), one file per API,
language and token (only the token's fingerprint is stored). Commands honour the response's
`max-age`, capped at 300 seconds, and revalidate with `If-None-Match`; a `no-store` response is
not stored. Completion uses the stored copy for up to 300 seconds even if it has expired, and if
it has to fetch it, waits at most 2 seconds. `--no-cache` fetches it again.

## Tests

```bash
node tools/restep-cli/test.mjs     # from restep/
```

They start the reference server on 8850 and on 8851 (with `RESTEP_TOKEN`). Against it they test
the `reviews` subcollection with `--parent` (404 without its book, deleted along with it),
`--include` with depth 2, the `highlight` relation with `href` and the polymorphic `showcase`
with `type`, and the actions `low_stock` (collection `GET`), `restock` (item `POST` with `input`
validated locally), `find_or_create` and `inherit_tax` (idempotent). A mock server on 8852 has
what the reference lacks or cannot trigger: actions that echo what was sent, an API without the
actions extension (`/sinext/`), discovery linked through `service-desc`, a `503` for retries and,
under other roots (`/d6/`, `/d7/`, `/v2/`, `/rara/`, `/xo/`), draft 6 discoveries with unknown
values, unknown `id_from`, `anonymous: false`, reserved singletons, another major version, a
malformed `restep` and a `service-desc` to another origin. Port 8859 is used as a port with
nobody listening, for the network error.

## Limits

- Of `relations` it only reads (`--include`): it does not build relation objects when writing.
  It does not cover `sync`, `batch`, `filter-expr` or `query-method`; `filter=` as an expression
  has no option of its own (with `--raw` it can be sent by hand).
- It only validates against schemas embedded in discovery; a linked schema is not downloaded.
  `--fields` is only checked if there is an embedded `schemas.item`.
- `readOnly` is not validated (in Restep it is only an annotation, §4.3): writing the effective
  field of an inherited value is rejected by the server, and the CLI gives the own-field hint.
- Completion does not suggest item ids.
- There is no OAuth flow: get the token elsewhere and pass it with `--token` or `RESTEP_TOKEN`.
- Not implemented from draft 6: creating or linking relations (it does not build relation
  objects, so not the `href` of a subcollection item either, §5.1); `deprecations` are only
  counted in `describe` (their `kind`, `announced` and `sunset` are not shown, and there is no
  warning for the `Deprecation` header); `collations` and `parent` are only shown; warnings with
  an unknown `kind` are counted all the same; it does not read `reasons` (a `reason` is shown as
  is and the exit code comes from the status, as §5.4 requires); it does not retry a `PATCH`
  even though §5.7 allows it; it does not validate a singleton's `update` schema if it is
  linked; an item's `_inherited` is shown as is, without interpreting `from`.

## Open questions about the spec

- **Body of an action without `input`.** Resolved in draft 6 (§11.1: an empty body counts as
  `{}`). The CLI still sends `{}`.
- **Idempotency-Key on idempotent actions.** Resolved in draft 6 (§11.1: a well-formed key is not
  rejected). The CLI still does not send one on them.
- **Which fields a collection has.** Discovery does not list an item's fields except through
  `schemas.item`, which is optional (§4.3). Without it, a client cannot check `fields` before
  sending nor offer field completion.
- **Discovery cache.** Resolved in draft 6 (§4.2: store it as far as its `Cache-Control` allows
  and fetch it again on an `unsupported_parameter` or a `405`). The CLI honours `max-age` (300 s
  at most), revalidates with ETag and, on a local rejection with the stored copy, fetches it
  again; on a server error it does not.

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-cli>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://restep.wubytes.com/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
