import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generate, renderModule } from '../src/generate.ts';
import { BUILTIN_WORDS, kebab, singular, splitPath } from '../src/naming.ts';
import { listsSpec, specTable } from './helpers.ts';

const spec = JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { operationId: string }>>;
};
const table = specTable();
const named = (words: string) => table.commands.find((c) => c.words.join(' ') === words);

describe('the generated command table', () => {
  it('is up to date with spec/openapi.json (npm run generate)', () => {
    const file = readFileSync(new URL('../src/generated/commands.ts', import.meta.url), 'utf8');
    expect(file).toBe(renderModule(table));
  });

  it('gives every operation of the spec one command', () => {
    const ops = Object.values(spec.paths).flatMap((item) =>
      Object.entries(item).filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(([, o]) => o.operationId));
    expect(table.commands.map((c) => c.operationId).toSorted()).toEqual(ops.toSorted());
  });

  it('names every command uniquely, and each name maps back to one operation', () => {
    const names = table.commands.map((c) => c.words.join(' '));
    expect(new Set(names).size).toBe(names.length);
    for (const c of table.commands) {
      expect(table.commands.filter((o) => o.words.join(' ') === c.words.join(' '))).toEqual([c]);
    }
  });

  it('never makes a command whose words are a group of another command, nor takes a built-in word', () => {
    for (const a of table.commands) {
      expect(BUILTIN_WORDS as readonly string[]).not.toContain(a.words[0]);
      for (const b of table.commands) {
        if (a === b) continue;
        const prefix = a.words.length < b.words.length && a.words.every((w, i) => b.words[i] === w);
        expect(prefix, `${a.words.join(' ')} shadows ${b.words.join(' ')}`).toBe(false);
      }
    }
  });

  it('uses kebab-case words and flags only', () => {
    const words = table.commands.flatMap((c) => c.words);
    const flags = table.commands.flatMap((c) => [...c.query, ...(c.body?.fields ?? [])].flatMap((f) => (f.flag ? [f.flag] : [])));
    for (const w of [...words, ...flags]) expect(w).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('names commands from AEP paths', () => {
    expect(named('tickets create')?.path).toBe('/tickets');
    expect(named('tickets set-status')?.path).toBe('/tickets/{id}:set-status');
    expect(named('tickets set-status')?.args.map((a) => a.label)).toEqual(['id']);
    expect(named('stores update')?.method).toBe('PATCH');
    expect(named('stores products update')?.args.map((a) => a.label)).toEqual(['store-id', 'product-id']);
    expect(named('stores stock adjust')?.path).toBe('/stores/{store_id}/stock:adjust');
    expect(named('stores settings update')?.args.map((a) => a.label)).toEqual(['store-id']);
    expect(named('stock transfer')?.path).toBe('/stock:transfer');
    expect(named('customers import')?.path).toBe('/customers:import');
    expect(named('payment-providers stripe connect')?.path).toBe('/payment-providers/stripe:connect');
    expect(named('ai requests get')?.path).toBe('/ai/requests/{id}');
    expect(named('whoami')?.path).toBe('/whoami');
    expect(named('ai-settings get')?.method).toBe('GET');
    expect(named('ai-settings update')?.method).toBe('PATCH');
    expect(named('device-models list')?.list?.key).toBe('models');
  });

  it('knows which commands take an Idempotency-Key and which need a person', () => {
    expect(named('tickets create')?.idempotency).toBe('required');
    expect(named('tickets set-status')?.idempotency).toBeUndefined();
    expect(named('tickets create')?.apiKey).toBe(true);
    expect(named('api-keys create')?.apiKey).toBe(false);
    expect(named('whoami')?.auth).toBe(true);
  });

  it('makes flags of scalar body fields, with their types and allowed values', () => {
    const status = named('tickets set-status')!.body!.fields.find((f) => f.name === 'status')!;
    expect(status).toMatchObject({ flag: 'status', type: 'string', required: true });
    expect(status.enum).toContain('ready');
    const consent = named('customers create')!.body!.fields.find((f) => f.name === 'consent')!;
    expect(consent.flag).toBeUndefined();
    const taxRate = named('stores update')!.body!.fields.find((f) => f.name === 'tax_rate')!;
    expect(taxRate).toMatchObject({ flag: 'tax-rate', type: 'number', nullable: true });
  });
});

describe('naming', () => {
  it('turns API names into kebab-case', () => {
    expect(kebab('price_minor')).toBe('price-minor');
    expect(kebab('labourTaxable')).toBe('labour-taxable');
    expect(kebab('vatId')).toBe('vat-id');
    expect(kebab('deletePoDraft')).toBe('delete-po-draft');
    expect(kebab('API keys')).toBe('api-keys');
  });

  it('makes a singular for argument names', () => {
    expect(singular('stores')).toBe('store');
    expect(singular('purchase-orders')).toBe('purchase-order');
    expect(singular('staff')).toBe('staff');
    expect(singular('companies')).toBe('company');
  });

  it('splits a path into nouns, parameters and a custom method', () => {
    expect(splitPath('/stores/{store_id}/stock:adjust')).toEqual({
      nouns: ['stores', 'stock'], params: [{ name: 'store_id', after: 'stores' }], verb: 'adjust', endsWithParam: false,
    });
    expect(splitPath('/tickets/{id}:set-status')).toMatchObject({ nouns: ['tickets'], verb: 'set-status', endsWithParam: true });
  });
});

const op = (operationId: string) => ({ operationId, responses: {} });

describe('generate on other documents', () => {
  it('picks up list endpoints: their array, pages and columns', () => {
    const t = generate(listsSpec());
    const list = t.commands.find((c) => c.operationId === 'listTickets')!;
    expect(list.words).toEqual(['tickets', 'list']);
    expect(list.list).toEqual({
      key: 'tickets', pageToken: 'page_token', pageSize: 'max_page_size',
      columns: ['id', 'store_id', 'number', 'status', 'currency', 'total_minor', 'created_at'],
    });
    // The paging parameters become --page-size/--page-token, not flags of their own.
    expect(list.query.map((q) => q.name)).toEqual(['status']);
    expect(list.query[0]).toMatchObject({ flag: 'status', type: 'array', items: 'string', enum: ['new', 'ready'] });
    expect(t.commands.find((c) => c.operationId === 'getTicket')!.words).toEqual(['tickets', 'get']);
    expect(t.apiVersion).toBe('9.9.9');
  });

  it('settles a collision with the operationId: the standard method keeps the plain name', () => {
    const t = generate({
      openapi: '3.1.0',
      info: { version: '1' },
      paths: {
        '/things/{id}:delete': { post: op('deleteThingDraft') },
        '/things/{id}': { delete: op('deleteThing') },
        '/help': { get: op('getHelp') },
        '/login': { post: op('makeLogin') },
      },
    });
    const words = Object.fromEntries(t.commands.map((c) => [c.operationId, c.words.join(' ')]));
    expect(words).toEqual({
      deleteThingDraft: 'things delete-thing-draft',
      deleteThing: 'things delete',
      getHelp: 'get-help',
      makeLogin: 'make-login',
    });
  });

  it('keeps a field off the flags when its name is taken, so it is set through --data', () => {
    const t = generate({
      openapi: '3.1.0',
      info: { version: '1' },
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'string' }, json: { type: 'boolean' }, name: { type: 'string' } } } } } },
            responses: {},
          },
        },
      },
    });
    const fields = t.commands[0]!.body!.fields;
    expect(fields.map((f) => [f.name, f.flag])).toEqual([['data', undefined], ['json', undefined], ['name', 'name']]);
  });

  it('reads nullable types, unions, $refs and allOf', () => {
    const t = generate({
      openapi: '3.1.0',
      info: { version: '1' },
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/Base' },
                      { type: 'object', properties: { email: { anyOf: [{ type: 'string', enum: [''] }, { type: 'string', format: 'email' }] } } },
                    ],
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
      components: {
        schemas: {
          Base: {
            type: 'object',
            properties: { role: { type: ['string', 'null'], enum: ['owner', 'staff', null] }, count: { type: ['integer', 'null'] } },
            required: ['role'],
          },
        },
      },
    });
    const byName = Object.fromEntries(t.commands[0]!.body!.fields.map((f) => [f.name, f]));
    expect(byName.role).toMatchObject({ type: 'string', enum: ['owner', 'staff'], nullable: true, required: true, flag: 'role' });
    expect(byName.count).toMatchObject({ type: 'integer', nullable: true });
    expect(byName.email).toMatchObject({ type: 'string', flag: 'email' });
  });
});
