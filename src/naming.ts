// How an API path becomes the words of a command (AEP-style paths):
//   POST   /tickets                          tickets create
//   GET    /tickets                          tickets list
//   GET    /tickets/{id}                     tickets get <id>
//   PATCH  /tickets/{id}                     tickets update <id>
//   DELETE /tickets/{id}                     tickets delete <id>
//   POST   /tickets/{id}:set-status          tickets set-status <id>
//   POST   /stores/{id}/registers            stores registers create <store-id>
//   POST   /stores/{store_id}/stock:adjust   stores stock adjust <store-id>
//   GET    /whoami                           whoami                  (a singleton with nothing else under it)
// The generator (src/generate.ts) settles collisions: see `candidates` there.

/** The first words the CLI keeps for its own commands. */
export const BUILTIN_WORDS = ['login', 'logout', 'auth', 'api', 'help'] as const;

/** `labourTaxable`, `price_minor`, `Set status` → `labour-taxable`, `price-minor`, `set-status`. */
export function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[\s_.]+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** `stores` → `store`, `purchase-orders` → `purchase-order`, `staff` → `staff`. Good enough for argument names. */
export function singular(word: string): string {
  if (word.endsWith('ss') || !word.endsWith('s')) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  return word.slice(0, -1);
}

export interface PathParts {
  /** The literal segments, in kebab-case: `['stores', 'stock']`. */
  nouns: string[];
  /** The parameters in path order, each with the literal just before it. */
  params: { name: string; after?: string }[];
  /** The custom method after `:`, in kebab-case: `set-status`. */
  verb?: string;
  /** Whether the path (before any custom method) ends with a parameter. */
  endsWithParam: boolean;
}

export function splitPath(path: string): PathParts {
  const segments = path.split('/').filter(Boolean);
  const parts: PathParts = { nouns: [], params: [], endsWithParam: false };
  const last = segments.length - 1;
  segments.forEach((raw, i) => {
    let seg = raw;
    if (i === last) {
      const close = seg.lastIndexOf('}');
      const colon = seg.indexOf(':', close + 1);
      if (colon >= 0) {
        parts.verb = kebab(seg.slice(colon + 1));
        seg = seg.slice(0, colon);
      }
    }
    const param = /^\{(.+)\}$/.exec(seg);
    if (param) {
      parts.params.push({ name: param[1]!, after: parts.nouns[parts.nouns.length - 1] });
      if (i === last) parts.endsWithParam = true;
    } else if (seg) {
      parts.nouns.push(kebab(seg));
    }
  });
  return parts;
}

/** The standard verb of a method on a path, or undefined when there is none (a POST to `/things/{id}`). */
export function standardVerb(method: string, parts: PathParts, isList: boolean): string | undefined {
  if (parts.verb) return parts.verb;
  switch (method) {
    case 'GET':
      return parts.endsWithParam || !isList ? 'get' : 'list';
    case 'POST':
      return parts.endsWithParam ? undefined : 'create';
    case 'PATCH':
      return 'update';
    case 'PUT':
      return 'replace';
    case 'DELETE':
      return 'delete';
    default:
      return undefined;
  }
}

/** How help names a path parameter: `id` for the command's own resource, `store-id` for a parent's. */
export function argLabel(param: { name: string; after?: string }, parts: PathParts): string {
  if (param.name !== 'id') return kebab(param.name);
  const own = parts.nouns[parts.nouns.length - 1];
  const isLast = parts.params[parts.params.length - 1] === param;
  if (isLast && param.after === own) return 'id';
  return param.after ? `${singular(param.after)}-id` : 'id';
}
