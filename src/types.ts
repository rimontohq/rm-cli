// The command table: what `npm run generate` writes to src/generated/commands.ts from the API's OpenAPI document,
// one entry per operation, and what the CLI reads at run time. It keeps only what the CLI uses.

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A JSON type as the CLI sees it. `any` is a value the CLI cannot type (a union of different types). */
export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'any';

/** A query parameter or a top-level body field. */
export interface Field {
  /** The name in the API: `price_minor`, `labourTaxable`. */
  name: string;
  /** The flag without its dashes (`price-minor`); absent when the field is set through --data only. */
  flag?: string;
  type: FieldType;
  /** An array's item type. */
  items?: FieldType;
  /** Allowed values (null left out: see `nullable`). */
  enum?: (string | number | boolean)[];
  nullable?: true;
  required?: true;
  format?: string;
  default?: unknown;
  /** The spec's example value, for help. */
  example?: string | number | boolean;
  description?: string;
}

/** A path parameter: a positional argument, in path order. */
export interface Arg {
  /** The name in the path: `id`, `store_id`. */
  name: string;
  /** How help shows it: `id`, `store-id`. */
  label: string;
  format?: string;
  description?: string;
}

export interface ListInfo {
  /** The response's array: `tickets` in `{ "tickets": [...], "next_page_token": "..." }`. */
  key: string;
  /** The query parameter that asks for the next page (`page_token`), when the list has pages. */
  pageToken?: string;
  /** The query parameter that caps a page (`max_page_size`). */
  pageSize?: string;
  /** The rows' scalar fields, in the schema's order: the candidates for table columns. */
  columns: string[];
}

export interface Command {
  /** The words after `rimonto`: `['tickets', 'set-status']`. */
  words: string[];
  operationId: string;
  method: Method;
  path: string;
  /** The operation's first tag: `Repairs`. */
  area: string;
  summary?: string;
  description?: string;
  args: Arg[];
  query: Field[];
  /** Absent when the operation takes no body. `open`: the body accepts more than its listed fields (or is not an object). */
  body?: { required: boolean; fields: Field[]; open: boolean };
  /** Whether the operation takes an Idempotency-Key header. */
  idempotency?: 'required' | 'optional';
  /** Whether an API key may call it; false means a person's own sign-in only. */
  apiKey: boolean;
  /** Whether it needs a sign-in at all. */
  auth: boolean;
  list?: ListInfo;
}

export interface Area {
  name: string;
  description?: string;
}

export interface CommandTable {
  /** The API document's info.version. */
  apiVersion: string;
  areas: Area[];
  commands: Command[];
}
