# rimonto

`rimonto` is the command line for Rimonto, point of sale and repair software for phone repair shops. It calls a
shop's API from a terminal: check in repairs, add customers, move stock, look things up. It is for shop owners who
like a terminal, and for developers who connect their own tools to a shop.

Every command comes from the API's own description (OpenAPI), so the CLI can do what the API can do, with the same
names.

## Install

You need Node.js 22 or later.

```sh
npm install -g rimonto
rimonto --version
```

Or run it without installing:

```sh
npx rimonto --help
```

With Homebrew (it brings Node.js along):

```sh
brew install rimontohq/tap/rimonto
```

Standalone downloads, with no Node.js at all, come later.

Once a day, in a terminal, `rimonto` asks npm whether a newer version is out and says so after the command, with how to
update (`npm install -g rimonto`, or `brew upgrade rimonto`). It never slows a command by more than a second, stays quiet
in CI and in pipes, and keeps only the time and the version number it saw (`update-check.json` beside the config file).
`RIMONTO_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER=1`) switches it off.

## With an AI agent

Install the agent skill, and Claude Code, Cursor, Codex and other coding agents know how to use this CLI: its commands,
its output, and what to ask you before something a customer sees or that moves money.

```sh
npx skills add rimontohq/rm-cli            # this project
npx skills add rimontohq/rm-cli --global   # every project
```

To ask about your shop in Claude or ChatGPT instead of running commands, connect the assistant:
https://developers.rimonto.app/ai/.

## Sign in

The CLI signs in with an API key. A shop owner makes one in the developer portal, https://developers.rimonto.app,
under **API keys**. The key is shown once; it starts with `rimonto_sk_`.

Rimonto is in beta. Until it launches, the developer portal and the hosted API are open to invited people only, so
without an invitation `rimonto login` cannot reach them. Ask the Rimonto team for access.

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
PINs, pairing a counter iPad, companies, AI assistants and supplier applications. Help marks them. Signing in as a person, in a browser, will come in a later version.

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
| `PATCH /customers/{id}` | `rimonto customers update <id>` |
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
- **A negative number** is a value, not a flag: `--delta -2`.

The CLI checks the required fields before it sends anything.

## Output and scripting

In a terminal, a list prints as a table and a single record as `key: value` lines. Money shows as a decimal with its
currency (`25.00 USD`), times in your time zone. When the output goes to a pipe or a file, the CLI prints the API's
JSON as it came, so you can use `jq`:

```sh
rimonto tickets list --status ready | jq -r '.tickets[].number'
```

A table starts with what you read (the number or name, the status, who, what, money, a date) and ends with the
id, always whole, so you can paste it into the next command. When it is wider than the terminal, long names are
shortened with `…`, then the last columns are left out. `--columns number,customer_name,amount_due_minor` picks the columns
yourself. `--json` and `--human` choose one output or the other anywhere.

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

### Releasing

A merge into `dev` that raises the version is the release; nobody publishes by hand.

1. A pull request that changes what users get (`src/`, `spec/`, the build) raises `version` in `package.json`:
   `npm version patch --no-git-tag-version` for a fix, `minor` for a new command, flag or behaviour, `major` for
   something that breaks how people use it. Woodpecker's check `version` fails a pull request that forgets; tests, CI,
   docs and dev dependencies need no new version.
2. On the merge into `dev`, GitHub Actions' `release` workflow (`.github/workflows/release.yml`) runs the checks,
   publishes that version to npm with provenance, tags `v<version>` and attaches the package to its GitHub release. npm
   trusts this workflow by OIDC (Trusted Publishing on npmjs.com), so no token or password is kept anywhere.
3. Within the hour, [rimontohq/homebrew-tap](https://github.com/rimontohq/homebrew-tap)'s `bump` pipeline moves the
   formula to it, after auditing, installing and testing it.

```sh
npm install
npm start -- --help          # run from source
npm run check                # lint, typecheck, tests, the command table is current, the build
npm test                     # the tests alone: unit, contract and smoke
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

### Tests

`npm test` needs no server:

- **Unit tests** of each part: arguments, output, paging, errors, sign-in.
- **Contract tests** (`test/contract.test.ts`): every command of the table, new ones included as soon as they are
  generated. Each one runs with a command line made from the spec's schemas (its required input, then every flag),
  and the request it sends is checked against its operation in `spec/openapi.json`: the method, the path, the query,
  the headers (`Authorization`, `Idempotency-Key` exactly where the operation takes one) and the body, by JSON Schema.
  The answer, made from the operation's success schema, must print as JSON and for people. A missing required input
  must stop the CLI before it sends anything.
- **Smoke test** (`test/smoke.test.ts`): builds `dist/rimonto.js` and runs it alone, as a separate process.

`npm run e2e` runs the CLI against a real core, as a person would: reads, paging, a customer it makes twice with one
idempotency key and then erases, a table, and the errors (a person-only command, a wrong key, no API). It prints one
line per check (`ok …` or `FAIL …`) and exits 0 when all pass, 1 when any fails, 2 when it cannot start.

```sh
RIMONTO_E2E_API_URL=http://localhost:5280 RIMONTO_E2E_KEY=rimonto_sk_… npm run e2e
```

| Variable | Required | What it is |
|---|---|---|
| `RIMONTO_E2E_API_URL` | yes | core's address |
| `RIMONTO_E2E_KEY` | yes | a manager API key of the demo company, Fix-It Lab, for all its stores |
| `RIMONTO_E2E_HEADERS` | no | extra headers, passed on as `RIMONTO_HEADERS` (a gate in front of core) |
| `RIMONTO_E2E_CLI` | no | the `rimonto.js` to test; by default this checkout is built and tested |

rm-cli's own CI does not run it: it has no core. The panel's api e2e does, on a fresh local backend with the demo
data. To run it on a computer, start the backend (rm-app-backend's README), sign in as the demo owner, make a
manager key with `POST /api-keys`, and revoke it afterwards.

## License

MIT. See [LICENSE](LICENSE).

## Git hooks

Git runs this repository's linters for you (`lefthook.yml`, installed by `npm install` or `npm ci`): before a commit on the files in it, and the lint and the types before a push, as the CI's check does. `LEFTHOOK=0 git …` skips them once.

Known vulnerabilities in the dependencies fail the check, in a step of its own (`known vulnerabilities`), as a new advisory can fail code nobody touched: `scripts/osv.mjs`, the same file in every Rimonto repository, has [OSV-Scanner](https://google.github.io/osv-scanner/) read `package-lock.json` and ask [osv.dev](https://osv.dev) about each version. A finding with a fixed version is moved to it; one with no fix yet, or that our code never reaches, is written down in `osv-scanner.toml` with why and until when, at most 90 days ahead. `node scripts/osv.mjs` runs it here with OSV-Scanner installed (`brew install osv-scanner`); without it, the scan is skipped.

Secrets are scanned the same way (`scripts/gitleaks.mjs`, gitleaks with `.gitleaks.toml`): what a commit adds, before it is made; the branch's commits, in `npm run lint` and so before a push and in the check. It downloads gitleaks once, checked against the release's SHA-256, on macOS, Linux and Windows. A finding shows its file and line, never its value. A real key comes out of the change and is rotated; something that only looks like one goes into `.gitleaks.toml` with why. `npm run lint:secrets` runs it by hand; `node scripts/gitleaks.mjs history` reads every commit.

The shell script and the pipeline are linted too (`scripts/lint-ops.mjs`, the same file in every Rimonto repository): shellcheck on `scripts/compile.sh`, `woodpecker-cli lint --strict` on `.woodpecker/*.yaml`, and hadolint on a Dockerfile once there is one; a warning or worse fails. What a commit adds, before it is made; all of them in `npm run lint:ops`, part of `npm run lint`, so before a push and in the check. The CI's image has the three; a computer without one skips it in the hook, with a line that says how to install it (`brew install shellcheck hadolint woodpecker-cli` on a Mac). Where a rule is wrong for a line, the line says so, with why: `# shellcheck disable=SC2034 # why`. Its tests: `node --test scripts/lint-ops.test.mjs`, in the check.

Dead code is found too: `npm run lint:unused`, part of `npm run lint`, runs [knip](https://knip.dev). A file nobody imports, an export nobody uses, or a dependency in `package.json` that no code needs fails it, so before a push and in the check. knip finds the entry points itself, from `package.json`'s scripts, `lefthook.yml` and `.github/workflows/`; what is used in a way it cannot see (a script only `.woodpecker/` runs) is in `knip.json`, with why.
