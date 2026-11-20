# restep (CLI)

CLI genérica para cualquier API [Restep 1](https://restep.wubytes.com/es/1/), al estilo de
httpie pero sabiendo de antemano qué ofrece la API: lee su documento de descubrimiento (§4.2)
y valida colecciones, filtros, orden, campos y cuerpos antes de enviar nada. Un solo archivo,
Node 18+, sin dependencias.

```bash
node tools/restep-cli/restep.mjs http://localhost:8080 get books -f category=novela-negra -s -price
# o, enlazado como binario (npm link en esta carpeta):
restep http://localhost:8080 get books -f category=novela-negra -s -price
```

## Órdenes

| Orden | Petición |
|---|---|
| `restep <url> describe [colección]` | `GET` de la raíz. Sin colección, perfiles, extensiones y colecciones; con ella, filtros (tipo, operadores, valores), orden, página, campos, obligatorios, mapas de idioma, relaciones, heredados y acciones |
| `restep <url> get <colección>` | `GET` de la colección, una página |
| `restep <url> get <colección> <id>` | `GET` del elemento |
| `restep <url> create <colección> --data …` | `POST` con `Idempotency-Key` aleatoria si la API anuncia `writes` |
| `restep <url> update <colección> <id> --data …` | `PATCH` con `application/merge-patch+json` |
| `restep <url> delete <colección> <id>` | `DELETE` |
| `restep <url> action <colección> [<id>] <nombre>` | `POST /colección/id:nombre` o `/colección:nombre`; `GET` si la acción lo declara (§10.1) |
| `restep completion zsh\|bash` | script de autocompletado |

Sin orden, `restep <url>` equivale a `describe`.

### Consulta

- `-f, --filter` (repetible): `campo=valor` (es `filter[campo]`), `campo[op]=valor`, o los atajos
  `campo!=v`, `campo<v`, `campo<=v`, `campo>v`, `campo>=v`. `in` va con comas:
  `-f 'category[in]=poesia,ensayo'`. Las traducciones, como el descubrimiento las declara:
  `-f name.es-mx=Goma`.
- `-s, --sort -rating,title`, `--fields title,price` (también en el `get` de un elemento),
  `-n, --limit N`.
- `--all` sigue `next` tal cual hasta `null` (§5.2); con `--limit` fija el tamaño de cada página.
  En `ndjson` escribe cada página según llega.
- `--count` imprime solo el total (pide `count=true` y `limit=1`); con `-o json`,
  `{"total": N}` y `total_estimated` si el total es aproximado.
- `-o, --format json|ndjson|csv|table`. Por defecto, `table` para listas en una terminal y
  `json` en lo demás (y siempre que la salida va a una tubería). `csv` y `table` ponen una
  columna por campo, sin los miembros que empiezan por `_`; los objetos van como JSON.

### Escritura

- `-d, --data '{...}'`, `--data @archivo.json` o `--data -` (entrada estándar).
- `create` y las acciones no idempotentes llevan `Idempotency-Key` aleatoria (una cadena de
  Structured Fields, §7.1). `--idempotency-key clave` usa la tuya: repetir la orden con la misma
  clave no duplica, y la CLI avisa en stderr de que la respuesta es una repetición.
- `--if-match <etag>` (con o sin comillas). `--safe` hace antes un `GET` del elemento y escribe
  con `If-Match` con su `_etag` o, si no lo trae, su cabecera `ETag` (§7.2).
- `--minimal` envía `Prefer: return=minimal`; si la respuesta llega sin cuerpo, se muestran
  `status`, `location` y `etag`.
- `--retry N` reintenta errores de red, `429`, `502`, `503` y `504` (y `409` con clave, una
  petición igual aún en curso), respetando `Retry-After`. Solo en lecturas, `DELETE` y
  peticiones con `Idempotency-Key`, que son las que se pueden repetir sin duplicar.

### Validación antes de enviar

Con el descubrimiento en la mano, la CLI rechaza en local (código de salida 3), con
sugerencias «¿quisiste decir…?»:

- una colección, filtro, operador, clave de orden, campo de `--fields` o acción que no existe;
- un valor que no encaja con el tipo del filtro (`integer`, `number`, `decimal`, `boolean`,
  `date`, `datetime`, `duration`, `enum` con sus `values`), `null` sin `true`/`false`, `in`
  vacío o el mismo filtro dos veces;
- `--limit` fuera de `max_limit`, `--count` sin `count` declarado, filtros sin el perfil `query`;
- un método que `methods` o `item_methods` no declaran;
- un cuerpo que no cumple `schemas.create`, `schemas.update` o el `input` de la acción, cuando
  vienen incrustados (§4.3). El validador cubre lo habitual de JSON Schema: `type`, `enum`,
  `pattern`, `required`, `properties`, `patternProperties`, `additionalProperties`,
  `propertyNames`, `anyOf`, `oneOf`, `items`, `minimum`, `maximum` y `maxLength`.

`--raw` se salta todo eso y envía igual (y, si la colección no está en el descubrimiento, usa
`/<colección>`). Si el rechazo se basó en el descubrimiento de la caché, la CLI lo vuelve a
pedir antes de rendirse, por si la API ha cambiado.

### Errores y códigos de salida

Los `problem+json` (§5.4) se muestran legibles en stderr: estado, `code`, `title`, `detail`,
`parameter`, `reason` y cada entrada de `errors` con su puntero. Añade pistas: los filtros u
orden que sí ofrece la colección ante `unsupported_parameter` (y que no sirve reintentar), el
campo propio ante un `read_only` sobre un valor heredado (§5.7), `--safe` ante `412`, cómo pasar
el token y la URL de los metadatos OAuth ante `401`. Con `-o json` el problema sale además tal
cual en stdout.

| Código | Cuándo |
|---|---|
| 0 | bien |
| 1 | otro error (respuesta que no es Restep, bucle en `next`…) |
| 2 | uso incorrecto: argumentos, JSON mal formado, alias inexistente |
| 3 | rechazado en local contra el descubrimiento |
| 4 | error de red |
| 5 | `400` |
| 6 | `401`, `403` |
| 7 | `404`, `410` |
| 8 | `409`, `412`, `428` |
| 9 | `422` |
| 10 | otro `4xx` |
| 11 | `5xx` |

### Depurar

- `-v, --verbose` escribe en stderr cada petición y respuesta con sus cabeceras (el token como
  `Bearer ****`), también la del descubrimiento cuando no sale de la caché.
- `--curl` imprime el `curl` equivalente sin enviarlo. El token nunca se imprime: el curl usa
  `"Authorization: Bearer $RESTEP_TOKEN"`. Con `--safe` imprime el `GET` y el `PATCH` con un
  hueco para el ETag.

## Perfiles

Por orden de preferencia, la API sale del primer argumento (una URL o `@alias`), de
`RESTEP_URL` o del alias `default` del archivo de configuración. El token, de `--token`, del
alias (`token` o `token_env`, el nombre de una variable de entorno) o de `RESTEP_TOKEN`. El
idioma (`Accept-Language`, §5.6), de `--language`, del alias o de `RESTEP_LANGUAGE`.

`~/.config/restep/config.json` (o `$XDG_CONFIG_HOME/restep/config.json`, o `RESTEP_CONFIG`):

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

Las credenciales solo van al origen de la API (§4.3): un `next` u otro enlace a otro origen se
pide sin ellas.

## Autocompletado

```bash
eval "$(restep completion zsh)"    # en ~/.zshrc, después de compinit
eval "$(restep completion bash)"   # en ~/.bashrc
```

Necesita `restep` en el `PATH` (`npm link` en esta carpeta, o un alias). Sugiere órdenes,
alias, colecciones, filtros (`campo=` y `campo[op]=`), valores de los `enum` (también dentro de
un `in`), claves de orden con y sin `-`, campos de `--fields`, formatos, opciones y acciones.
Lo lee del descubrimiento con una caché local corta.

## Caché del descubrimiento

En `~/.cache/restep/` (o `$XDG_CACHE_HOME/restep/`, o `RESTEP_CACHE_DIR`), un archivo por API,
idioma y token (del token solo se guarda la huella). Las órdenes respetan el `max-age` de la
respuesta, con 300 segundos como máximo, y revalidan con `If-None-Match`; una respuesta
`no-store` no se guarda. El autocompletado usa la copia guardada hasta 300 segundos aunque haya
caducado, y si tiene que pedirla espera como mucho 2 segundos. `--no-cache` la vuelve a pedir.

## Pruebas

```bash
node tools/restep-cli/test.mjs     # desde restep/
```

Arrancan el servidor de referencia en 8850 y en 8851 (con `RESTEP_TOKEN`), y un servidor
simulado en 8852 con lo que el de referencia no tiene: acciones, una subcolección, el
descubrimiento enlazado con `service-desc` y un `503` para los reintentos. El 8859 se usa como
puerto sin nadie, para el error de red.

## Límites

- No cubre `relations` (`include`), `sync`, `batch`, `filter-expr` ni `query-method`. Con
  `--raw` y `-H` se pueden mandar a mano algunos parámetros, pero `include` y `filter=` como
  expresión no tienen opción propia.
- Solo valida contra esquemas incrustados en el descubrimiento; un esquema enlazado no se
  descarga. `--fields` solo se comprueba si hay un `schemas.item` incrustado.
- `readOnly` no se valida (en Restep es solo una anotación, §4.3): escribir el campo efectivo
  de un valor heredado lo rechaza el servidor, y la CLI da la pista del campo propio.
- El autocompletado no sugiere ids de elementos.
- No hay flujo OAuth: el token se consigue fuera y se pasa con `--token` o `RESTEP_TOKEN`.

## Dudas sobre la spec

- **Cuerpo de una acción sin `input`.** §10.1 no dice si una acción `POST` sin `input`
  admite cuerpo vacío o espera `{}`. La CLI envía `{}`.
- **Idempotency-Key en acciones idempotentes.** §7.1 obliga a aceptarla en los `POST` no
  idempotentes; no dice qué hace un servidor que la recibe en una acción declarada
  `"idempotent": true`. La CLI no la envía en esas.
- **Qué campos tiene una colección.** El descubrimiento no lista los campos de un elemento
  salvo a través de `schemas.item`, que es opcional (§4.3). Sin él, un cliente no puede
  comprobar `fields` antes de enviar ni ofrecer autocompletado de campos.
- **Caché del descubrimiento.** La spec no dice cuánto puede un cliente guardar el
  descubrimiento ni cómo se entera de que ha cambiado, más allá de las cabeceras de caché
  normales. La CLI respeta `max-age` y revalida con ETag, y ante un rechazo local con la copia
  guardada la vuelve a pedir.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-cli>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
