---
name: rimonto
description: >
  Work with a phone repair shop's Rimonto from the terminal through the `rimonto`
  command line: find and check in repairs, move them along, add customers, look up
  stock, read sales, put parts on an order. Use when the user asks about their
  shop's repairs, tickets, customers, stock or sales in Rimonto, wants to script
  them, or asks to connect Rimonto to an AI agent. Load this before running
  `rimonto` commands: it has the command grammar, the output contract, and what to
  ask before doing something a customer sees or that moves money.
license: MIT
metadata:
  author: rimontohq
  homepage: https://rimonto.com
  source: https://github.com/rimontohq/rm-cli
---

# Rimonto CLI

`rimonto` calls a shop's Rimonto API. Its commands come from the API's own description, so they have the API's names and
can do what the API can do.

## Set up

If `rimonto --version` fails, install it. It needs Node.js 22 or later:

```sh
npm install -g rimonto
```

Or `brew install rimontohq/tap/rimonto`, which brings Node.js along.

It signs in with an API key that starts with `rimonto_sk_`. A shop owner makes one at
https://developers.rimonto.app/keys/. While Rimonto is in beta, that portal and the hosted API are open to invited
people only: if the key does not work or the address does not answer, the person may not have access yet.

- `rimonto login` asks for the key with hidden input, so an agent cannot answer it. Ask the person to run it themselves,
  or to set `RIMONTO_API_KEY` in the environment you run in.
- Never ask for a key in the conversation, print one, or write one to a file in a repository.

Then check what the key acts as:

```sh
rimonto whoami
```

It answers the company, the role and the stores. A key works only within them. If the API refuses for lack of rights, say
so, and leave it to the owner.

## The CLI, or a connection to the assistant

For someone who wants to ask about their shop in Claude or ChatGPT, not run commands, connect the assistant over MCP
instead. Claude Code takes:

```sh
claude mcp add --transport http Rimonto https://rimonto.app/core/mcp
```

Then `/mcp` to sign in. The owner first switches assistants on in Settings → AI assistants. Other assistants:
https://developers.rimonto.app/ai/.

The two differ in who the agent is. Over MCP it signs in as that person, has only the tools the owner allowed, and never
touches money. With the CLI it has whatever its key's role allows, money included, which is why the next parts matter.

## Commands

Do not guess a command or a flag: help is exact, and costs nothing.

```sh
rimonto --help
rimonto help repairs
rimonto tickets --help
rimonto tickets set-status --help
```

- Ids in the path are arguments: `rimonto tickets get <id>`.
- Simple fields are flags, the API's field in kebab-case: `store_id` is `--store-id`.
- Objects and lists of objects go in `--data` as JSON, as `@file.json`, or `-` for stdin. Flags override the same keys.
- Money is in minor units: `--price-minor 2500` is 25.00.
- A negative number is a value: `--delta -2`.
- In help, `*` marks a command that needs a person's own sign-in. An API key cannot run it, so do not retry it.
- `rimonto api GET /whoami` calls any path of the API, for what has no command of its own.

A repair's number (`T-2039`) is not its id. Find the id, then use it:

```sh
rimonto tickets list --q T-2039 | jq -r '.tickets[0].id'
```

## Output

When the output is not a terminal, the CLI prints the API's JSON as it came, so an agent gets JSON without asking.
`--json` forces it. Read it with `jq`, never by parsing the tables a terminal shows.

```sh
rimonto tickets list --status ready | jq -r '.tickets[].number'
```

- Lists come a page at a time. `--all` reads every page and `--limit 100` stops after 100 rows.
- Errors go to stderr, with the API's reason and code.
- Exit codes: 0 done, 1 the API refused or you are not signed in, 2 the API could not be reached, 64 a wrong command line.

## Ask first

Reading needs no permission. Before any of these, show what will happen and who will see it, then wait for a yes:

- **A customer gets a text.** `rimonto tickets set-status --status ready` when they agreed to updates, `rimonto tickets
  text-customer`, `rimonto tickets resend-ready`, `rimonto tickets resend-quote`, `rimonto customers text`.
- **Money moves.** `rimonto sales create`, `rimonto sales refund`, `rimonto tickets collect`, `rimonto tickets
  take-deposit`, `rimonto tickets return-deposit`, `rimonto tickets create-pay-link`, `rimonto registers
  start-card-payment`, `rimonto card-payments void`.
- **It is hard to take back.** `rimonto customers erase`, `rimonto customers import`, `rimonto tickets cancel`, `rimonto
  purchase-orders place`, `rimonto purchase-orders cancel`.
- **It reaches private data or access.** `rimonto tickets reveal-passcode`, `rimonto customers export`, `rimonto staff
  update`, `rimonto payment-providers stripe disconnect`.

Record only the consent a customer actually gave: `--data '{"consent": {"updates": true, "marketing": false}}'` on
`rimonto customers create` says what they said, so never assume a yes.

## When a command fails

The CLI retries a dropped connection, a 5xx and a 429 by itself, with the same idempotency key, so a sale is never made
twice. If every attempt fails it prints the key. Run the same command again with that key, never without it:

```sh
rimonto sales create --data @sale.json --idempotency-key <key>
```

If the first attempt went through, this answers its result; if not, it runs now. A plain second run could do the work twice.

`--verbose` shows each request and answer on stderr, with header values hidden.

## Common jobs

```sh
# What is ready for pickup, in every store the key can see
rimonto tickets list --status ready

# A store's id, then what runs low there
STORE=$(rimonto stores list | jq -r '.stores[] | select(.city == "Brooklyn") | .id')
rimonto products list --store-id "$STORE" --low-stock

# Find a customer by name, email or the last digits of a phone number
rimonto customers list --q 0142

# One repair in full
rimonto tickets get <id>

# Add an internal note, which no customer sees
rimonto tickets add-note <id> --text "Waiting for the screen from the supplier"

# Correct the stock count, with a reason
rimonto stores stock adjust "$STORE" --product-id <id> --delta -2 --reason Correction --note "Counted on the shelf"
```

Full reference: https://developers.rimonto.app/cli/.
