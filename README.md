# rimonto

`rimonto` is the command line for Rimonto, point of sale and repair software for phone repair shops. It calls a
shop's API from a terminal: check in repairs, add customers, move stock, look things up. It is for shop owners who
like a terminal, and for developers who connect their own tools to a shop.

Every command comes from the API's own description (OpenAPI), so the CLI can do what the API can do, with the same
names.

## Install

You need Node.js 20 or later.

```sh
npm install -g rimonto
rimonto --version
```

Or run it without installing:

```sh
npx rimonto --help
```

Homebrew and standalone downloads (no Node.js needed) will come later.

## Sign in

The CLI signs in with an API key. A shop owner makes one in the developer portal, https://developers.rimonto.app,
under **API keys**. The key is shown once; it starts with `rimonto_sk_`.

```sh
rimonto login
```

`login` asks for the key without showing it, checks it, and tells you what it acts as: the company, the role and the
stores. It keeps the key in a config file only you can read:

| System | File |
|---|---|
| Linux, macOS | `$XDG_CONFIG_HOME/rimonto/config.json`, else `~/.config/rimonto/config.json` |
| Windows | `%APPDATA%\rimonto\config.json` |

In a script, pass the key on stdin, or set `RIMONTO_API_KEY` and skip `login`:

```sh
rimonto login --with-key < key.txt
RIMONTO_API_KEY=rimonto_sk_… rimonto whoami
```

`rimonto auth status` shows each profile's key (as `rimonto_sk_…1a2b`) and what it acts as. `rimonto logout` removes
the key from the file. The key itself works until the owner revokes it in the developer portal.

A key may do what its role may do. A few commands need a person's own sign-in and refuse a key: making API keys,
PINs, pairing a counter iPad. Help marks them. Signing in as a person, in a browser, will come in a later version.

## Examples

```sh
rimonto whoami
rimonto tickets list --status ready
rimonto tickets get 6f1c2a0e-6d8b-4a59-9d1f-3c1f6f3b8e21
rimonto tickets set-status 6f1c2a0e-6d8b-4a59-9d1f-3c1f6f3b8e21 --status ready
rimonto customers create --store-id 51a0… --first-name Ana --last-name Silva --phone "+1 415 555 0100" \
  --data '{"consent": {"updates": true, "marketing": false}}'
rimonto api GET /whoami
```

## Commands

`rimonto --help` lists the areas of the API and their commands. Then:

```sh
rimonto tickets --help              # the commands for repairs
rimonto tickets set-status --help   # one command: its arguments, flags, allowed values and an example
rimonto help repairs                # every command of an area
```

Command names follow the API's paths:

| API | Command |
|---|---|
| `POST /tickets` | `rimonto tickets create` |
| `GET /tickets` | `rimonto tickets list` |
| `GET /tickets/{id}` | `rimonto tickets get <id>` |
| `PATCH /tickets/{id}` | `rimonto tickets update <id>` |
| `POST /tickets/{id}:set-status` | `rimonto tickets set-status <id>` |
| `POST /stores/{store_id}/stock:adjust` | `rimonto stores stock adjust <store-id>` |
| `GET /whoami` | `rimonto whoami` |

`rimonto api <METHOD> <path>` calls any path, with the same sign-in, retries and output:

```sh
rimonto api GET /whoami
rimonto api POST /customers -d @customer.json
rimonto api /tickets -q status=ready --paginate
```

## Input

- **Ids in the path** are arguments: `rimonto tickets get <id>`.
- **Simple fields** are flags, named after the API's field in kebab-case: `store_id` is `--store-id`. They are
  typed: a number must be a number, an allowed value must be one of the list (help shows the list). A yes/no field
  has two flags: `--tax-exempt` and `--no-tax-exempt`. A list field takes the flag more than once.
- **Everything else** (objects, lists of objects) goes in `--data` as JSON: the JSON itself, `@file.json`, or `-` to
  read stdin. Flags override the same keys in `--data`.
- **Money** is in minor units, as the API takes it: `--price-minor 2500` is 25.00.

The CLI checks the required fields before it sends anything.

## Output and scripting

In a terminal, a list prints as a table and a single record as `key: value` lines. Money shows as a decimal with its
currency (`25.00 USD`), times in your time zone. When the output goes to a pipe or a file, the CLI prints the API's
JSON as it came, so you can use `jq`:

```sh
rimonto tickets list --status ready | jq -r '.tickets[].number'
```

`--json` and `--human` choose one or the other anywhere. `--columns number,status,total_minor` picks a table's
columns.

Lists come a page at a time. `--all` reads every page; `--limit 100` stops after 100 rows. `--page-size` and
`--page-token` work as in the API. The JSON keeps the shape of one page (`{"tickets": [...]}`), with
`next_page_token` when there are more rows.

Errors go to stderr, from the API's `application/problem+json`:

```text
rimonto: Not that many free units on hand (409 not-enough-stock)
  available: 2
```

`--verbose` shows each request and answer on stderr. Header values are never shown.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | The API refused the request, or you are not signed in |
| 2 | The API could not be reached |
| 64 | The command line is wrong: an unknown command or flag, a missing or invalid value |

## Retries and idempotency

Most commands that change data take an `Idempotency-Key`. The CLI sends a new one each time. If the connection
drops, the API answers 5xx (not 501) or 429, it tries again up to 3 times, with the same key, waiting as
`Retry-After` says. The API recognises the key and answers a retry with the first result, so a sale is never made
twice.

If every attempt fails, the CLI prints the key. Run the same command again with `--idempotency-key <key>`: if the
first attempt went through, you get its result; if not, it runs now.

A command without a key is sent once, because repeating it could do the work twice. Reads (`GET`) are retried.

## Profiles and settings

A profile is a key with its API address. Use several for several shops, or for a test account:

```sh
rimonto login --profile test --api-url https://example.com/core
rimonto tickets list --profile test
RIMONTO_PROFILE=test rimonto whoami
```

| Setting | Flag | Environment | Default |
|---|---|---|---|
| Profile | `--profile` | `RIMONTO_PROFILE` | `default` |
| API address | `--api-url` | `RIMONTO_API_URL` | the profile's, else `https://rimonto.app/core` |
| API key | | `RIMONTO_API_KEY` | the profile's |
| Extra headers | `-H "Name: value"` (repeat it) | `RIMONTO_HEADERS` (a JSON object, or one `Name: value` per line) | the profile's |
| Timeout per attempt | `--timeout <seconds>` | | 60 |

Extra headers are for a gateway or a proxy in front of the API. `login` keeps the address and the `-H` headers
you give it in the profile.

## Contributing

You need Node.js 22 or later (24 is what we use).

```sh
npm install
npm start -- --help          # run from source
npm run check                # lint, typecheck, tests, the command table is current, the build
npm run build                # dist/rimonto.js, one file with no dependencies
```

The commands are generated. `spec/openapi.json` is a copy of the API's OpenAPI document, and
`src/generated/commands.ts` is the command table made from it. When the API changes:

```sh
npm run spec                 # copy the document (from the API's checkout beside this one, or: npm run spec -- <path or URL>)
npm run generate             # rebuild the command table
```

Commit both files. A test fails when the table does not match the spec, and another when two operations would get
the same command.

`npm run compile` makes standalone executables with Bun, one per platform, in `dist/bin/`.

## License

MIT. See [LICENSE](LICENSE).
