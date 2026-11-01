// The command tree: the generated commands under their words, and the CLI's own commands beside them. Finds which
// command a command line names, before its flags are parsed (they depend on the command).

import { GLOBAL_VALUE_FLAGS } from './args.ts';
import type { Command } from './types.ts';

export type Builtin = 'login' | 'logout' | 'auth status' | 'api' | 'help';

export interface Node {
  words: string[];
  children: Map<string, Node>;
  command?: Command;
  builtin?: Builtin;
}

const BUILTINS: Builtin[] = ['login', 'logout', 'auth status', 'api', 'help'];

export function buildTree(commands: Command[]): Node {
  const root: Node = { words: [], children: new Map() };
  const place = (words: string[]): Node => {
    let node = root;
    for (const w of words) {
      let child = node.children.get(w);
      if (!child) {
        child = { words: [...node.words, w], children: new Map() };
        node.children.set(w, child);
      }
      node = child;
    }
    return node;
  };
  for (const b of BUILTINS) place(b.split(' ')).builtin = b;
  for (const c of commands) place(c.words).command = c;
  return root;
}

export interface Resolved {
  node: Node;
  /** argv without the command's words. */
  rest: string[];
  /** A word that names nothing under `node`. */
  unknown?: string;
}

/**
 * Walks the leading words of argv down the tree. Global flags may come before the words; the words end at the first
 * one that is not a child (an argument, or a mistake) or at a command.
 */
export function resolve(argv: string[], root: Node): Resolved {
  let node = root;
  const rest: string[] = [];
  let unknown: string | undefined;
  let descending = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      rest.push(a);
      if (GLOBAL_VALUE_FLAGS.has(a) && i + 1 < argv.length) rest.push(argv[++i]!);
      continue;
    }
    if (descending && !node.command && !node.builtin) {
      const child = node.children.get(a);
      if (child) {
        node = child;
        continue;
      }
      unknown = a;
    }
    descending = false;
    rest.push(a);
  }
  return { node, rest, unknown };
}
