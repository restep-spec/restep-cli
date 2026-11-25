# restep (CLI)

Generic CLI for any [Restep 1](https://w3id.org/restep/1/) API, in the style of httpie but
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

With discovery in hand, the CLI rejects locally (exit code 3), with "did you mean…?"
suggestions:

- a collection, filter, operator, sort key, `--fields` field or action that does not exist;
- a value that does not fit the filter type (`integer`, `number`, `decimal`, `boolean`, `date`,
  `datetime`, `duration`, `enum` with its `values`; an `integer` operand is valid when it has no
  fractional part, so `20.0` is `20` and `20.5` is rejected, §6.1), `null` without `true`/`false`,
  an empty `in`, or the same filter twice;
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

### Draft 7: what it does as a client (§12.2)

- **Version (§1.1).** Accepts `restep` with a suffix (`1.0-draft.7`, `1.0-rc.1`, case-sensitive) and shows it in
  `describe`. A discovery whose `restep` does not follow the grammar or whose major version is
  not 1 is not Restep 1: the CLI stops with code 1, also with `--raw` or `--curl`, instead of
  assuming plain `core`.
- **Experimental parts (§1.2).** The only one it uses is `inherit` (the own-field hint and the
  inherited fields in `describe`), and only if the API announces the extension and declares
  `"restep": "1.0-draft.7"`, the text it knows. With another version, `describe` warns and does
  not use it. It never uses `sync`, `batch`, `filter-expr` or `query-method`.
- **Discovery (§4.2).** Only a `2xx` without `restep`, or a `404`, means plain `core`; any other
  error stops the CLI. Of several `service-desc` links it uses the first that is a discovery
  document of Restep 1.
- **Unknown values (§4.2).** A filter or named filter with a `type` it does not know, a filter
  with a `quantifier` other than `some`, an operator outside the list in §6.1 (only that
  operator), an inheritance with a member it does not know, and an action with an `on` or
  `method` it does not know are treated as undeclared: `describe` flags them, validation rejects
  them and completion does not offer them. An `effects` value it does not know counts as all
  three.
- **Filters (§6.1).** The operators `nin`, `prefix` and `contains`, and the types `localdatetime`
  and `timezone`; durations follow §3 (a fraction of up to nine digits in the seconds, letters in
  either case, no years or months in a filter). A list without a required filter is rejected
  locally. `null` as the only operator on a to-many relationship or a list field
  (`-f reviews[null]=true`), declared with `"quantifier": "some"` or without it, is accepted and
  offered like any other filter; under a `quantifier` it tests the whole group (alone, an empty,
  absent or `null` one; with `in` or another filter on the group, `true` means that no visible
  element matches). Operands of `integer` and `number` filters and `-P` params follow the number
  grammar of RFC 8259 with exponent (`2e1` is `20`; `+20`, `.5`, `020`, `0x14` are rejected), and
  a `localdatetime` never has a leap second (`:60`). `-f name=false` turns a default filter off, and `--all` without `-f` is the request for
  a full copy (§5.2): it turns off every default filter and says so on stderr.
- **Collections without `GET` (§4.3).** `get` of the collection is rejected locally, and
  `describe` says it cannot be listed.
- **Singletons (§5.9).** `get`, `update` and `action <resource> <name>` without an id;
  `create` and `delete` are rejected locally. One under an item (a template with `parent`) takes
  the parent ids with `--parent`. One whose `path` is a template without `parent`, or whose
  `parent` names nothing in the document, is ignored.
- **Localized fields (§3, §5.6).** It sends them as given: the server decides (§5.1 lets a write
  carry the value the item would have; a `read_only` error gets a hint naming its language map).
  A response with localized fields shows its `Content-Language` on stderr.
  `describe` shows `default_language`.
- **Upload (§5.1).** `create <collection> --file <path>` sends the bytes with their
  `Content-Type` (`--type`, or from the extension) and the name in `Content-Disposition`
  (RFC 6266, `filename*` when it is not ASCII), after checking `media_types` and `max_size`.
  `schemas.create` announces creation from JSON: in a collection with `upload` and without
  `create`, `create --data` is rejected locally (it takes only files). With both, `--data` always
  creates an item, and a JSON file (`application/json`) goes as the `file` part of
  `multipart/form-data` (RFC 7578; `-F` with `--curl`), where the collection declares
  `"multipart": true`; without it, it is rejected locally. `describe` says which. Only
  `application/json` itself selects creation: a `+json` type (`--type application/ld+json`) is a
  file like any other, and in a collection that only takes uploads a JSON file that `media_types`
  admits, also through `application/*` or `*/*`, goes as its bytes. A file of type
  `multipart/form-data` goes only as the `file` part, and never to a collection without
  `"multipart": true`, not even with `--raw`. The `file` part always carries the file's name as
  `filename`.
- **One `null` per group (§6.1).** Two `null` filters on the same to-many relationship or list
  field, its own or that of a path through it (`-f 'reviews[null]=true' -f 'reviews.id[null]=true'`),
  are rejected locally, even when they agree. Numeric operands go as written (`1e400` included).
- **`upsert` (§5.1).** A `201` to `update` is reported as created; `--create-only` sends
  `If-None-Match: *`.
- **Effects (§4.3, §11.1).** In a terminal (or with `RESTEP_CONFIRM=always`) it asks before an
  operation with effects: an action, a create, an update or a delete, using `effects`,
  `method_effects` and `item_method_effects` (an undeclared one counts as all three, a safe action
  without `effects` as none, an unknown value as all three, also on a safe action, an undeclared
  `DELETE` as `destroys`). A singleton's `PATCH` uses its `method_effects` (§5.9); undeclared, it
  counts as all three. `--yes` or `RESTEP_CONFIRM=never` skips it.
- **Actions (§11.1).** `-P name=value` gives the `params` of a `GET` action, checked against the
  declaration (undeclared, missing required, type, lists); a `GET` action without `params` takes
  none (§5.3: any one gives `unsupported_parameter`). `describe` shows params, `output` and
  effects.
- **`415` (§5.1).** Its `Accept-Post`, if any, is shown as a hint (a JSON body to a collection
  that only takes uploads, say).
- **Retries (§5.7, §5.1).** `--retry` repeats a request with `Idempotency-Key` only within
  `idempotency.ttl` (24 hours where undeclared) from the first attempt, and a `DELETE` or `PATCH`
  in a collection with `reusable_ids` only if it carries `If-Match`. Past the ttl it says that
  whether the first attempt took effect is unknown, to be found out another way before sending it
  again (§5.7).
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
validated locally), `find_or_create` (`201` then `204`) and `inherit_tax` (idempotent), plus
`payments` (no `GET`), the default filter of `orders` and the child singleton `settings`. A mock server on 8852 has
what the reference lacks or cannot trigger: actions that echo what was sent, an API without the
actions extension (`/sinext/`), discovery linked through `service-desc`, a `503` for retries and,
under other roots (`/d6/`, `/old/`, `/v7/`, `/v2/`, `/rara/`, `/xo/`, `/sd/`, `/e400/`),
discoveries with unknown values, unknown `id_from`, `anonymous: false`, ignored and child
singletons, another major version, a malformed `restep`, a `service-desc` to another origin, an
earlier draft, a discovery error, and the draft 7 items above (filters, default and required
filters, localized fields, upload, `upsert`, params, effects and the retries). Port 8859 is used as a port with
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
- `multipart/form-data` (`upload.multipart`, §5.1) only for a JSON file in a collection that also
  creates from JSON, or a file of type `multipart/form-data`; any other file goes as the bytes of
  the body.
- It keeps no copies of items, so revalidating after an action (§11.1) does not apply to it.
- Not implemented from drafts 6 and 7: creating or linking relations (it does not build relation
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
site, where the tool is developed alongside the [specification](https://w3id.org/restep/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
