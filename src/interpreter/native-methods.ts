/**
 * Methodes natives des types de base.
 *
 * Chaque table est une `Map<nom, corps>`. L'interpreteur construit des
 * valeurs `UchiNativeFunction` a partir de ces tables lorsqu'il resout un
 * attribut sur une valeur de type `str`, `list`, `dict`, `set`, `tuple` ou
 * `range`.
 */

import {
  arityAtLeast,
  arityCheck,
  arg,
  checkNoExtraKeyword,
  expectInt,
  expectString,
  kwarg,
  type HostContext,
  type NativeCallArgs,
  type NativeFunctionBody,
} from './context.ts';
import { makeError } from './error-registry.ts';
import { applyFormat } from './format.ts';
import { contains, equals, iterate, toRepr, toStr, typeName } from './operations.ts';
import {
  UchiDict,
  UchiInstance,
  UchiRange,
  UchiSet,
  UchiTuple,
  isList,
  type UchiList,
  type UchiValue,
} from './values.ts';

export type MethodTable = Map<string, NativeFunctionBody>;

// ============================================================ arguments methodes

/**
 * Dans une table de methodes, `args.positional[0]` est le recepteur : les
 * arguments reels commencent a l'index 1. Ces deux fonctions rendent la
 * convention explicite plutot que de laisser un decalage se glisser.
 */
function extra(args: NativeCallArgs, index: number): UchiValue {
  return args.positional[index + 1] as UchiValue;
}

/** Nombre d'arguments fournis, recepteur exclu. */
function extraCount(args: NativeCallArgs): number {
  return args.positional.length - 1;
}

/**
 * Arguments reels d'une methode, recepteur exclu, avec les arguments nommes
 * ranges a leur place : `"a,b".split(sep=",")` doit se comporter comme
 * `"a,b".split(",")`.
 *
 * `params` nomme les parametres dans l'ordre de Python et `min` indique
 * combien sont obligatoires. Un parametre absent reste `undefined`, ce qui
 * permet de distinguer une valeur par defaut d'une valeur transmise.
 */
function extras(
  args: NativeCallArgs,
  name: string,
  params: readonly string[],
  min = 0,
): (UchiValue | undefined)[] {
  const slots: (UchiValue | undefined)[] = params.map(() => undefined);
  const given = args.positional.slice(1);

  for (const [key, value] of args.keyword) {
    const index = params.indexOf(key);
    if (index === -1) {
      throw makeError('TypeError', `${name}() ne accepte pas l'argument nomme '${key}'`);
    }
    if (slots[index] !== undefined) {
      throw makeError(
        'TypeError',
        `${name}() recoit plusieurs valeurs pour l'argument '${key}'`,
      );
    }
    slots[index] = value;
  }

  for (let i = 0; i < given.length; i++) {
    if (i >= params.length) {
      throw makeError(
        'TypeError',
        `${name}() attend au plus ${params.length} argument(s), ${given.length} recu(s)`,
      );
    }
    if (slots[i] !== undefined) {
      throw makeError(
        'TypeError',
        `${name}() recoit plusieurs valeurs pour l'argument '${params[i] as string}'`,
      );
    }
    slots[i] = given[i] as UchiValue;
  }

  if (given.length + args.keyword.size < min) {
    const missing = min - given.length - args.keyword.size;
    throw makeError(
      'TypeError',
      `il manque ${missing} argument(s) : ${name} attend ${min === params.length ? String(min) : `${min} a ${params.length}`}`,
    );
  }
  return slots;
}

// ================================================================ methodes str

function selfString(args: NativeCallArgs): string {
  return expectString(arg(args, 0), 'cette methode');
}

export function stringMethods(ctx: HostContext): MethodTable {
  const table: MethodTable = new Map();

  const simple = (name: string, arity: number, fn: (self: string, args: NativeCallArgs) => UchiValue) => {
    table.set(name, (args, context) => {
      arityCheck(args, name, arity + 1);
      return fn(selfString(args), args);
    });
  };

  simple('upper', 0, (s) => s.toUpperCase());
  simple('lower', 0, (s) => s.toLowerCase());
  simple('title', 0, (s) => s.replace(/\p{L}[\p{L}']*/gu, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()));
  simple('capitalize', 0, (s) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase()));
  simple('swapcase', 0, (s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''));
  simple('strip', 0, (s) => s.trim());
  simple('lstrip', 0, (s) => s.replace(/^\s+/, ''));
  simple('rstrip', 0, (s) => s.replace(/\s+$/, ''));
  simple('isdigit', 0, (s) => s.length > 0 && [...s].every((c) => c >= '0' && c <= '9'));
  simple('isalpha', 0, (s) => s.length > 0 && [...s].every((c) => /\p{L}/u.test(c)));
  simple('isalnum', 0, (s) => s.length > 0 && [...s].every((c) => /\p{L}|\p{N}/u.test(c)));
  simple('isspace', 0, (s) => s.length > 0 && [...s].every((c) => /\s/u.test(c)));
  simple('isupper', 0, (s) => s.length > 0 && s === s.toUpperCase() && /\p{L}/u.test(s));
  simple('islower', 0, (s) => s.length > 0 && s === s.toLowerCase() && /\p{L}/u.test(s));
  simple('splitlines', 0, (s) => s.split(/\r\n|\r|\n/).filter((line, i, all) => !(i === all.length - 1 && line === '')));

  table.set('strip', (args) => {
    const [chars] = extras(args, 'strip', ['chars']);
    const s = selfString(args);
    return chars === undefined ? s.trim() : trimChars(s, expectString(chars, 'strip'), true, true);
  });
  table.set('lstrip', (args) => {
    const [chars] = extras(args, 'lstrip', ['chars']);
    const s = selfString(args);
    return chars === undefined ? s.replace(/^\s+/, '') : trimChars(s, expectString(chars, 'lstrip'), true, false);
  });
  table.set('rstrip', (args) => {
    const [chars] = extras(args, 'rstrip', ['chars']);
    const s = selfString(args);
    return chars === undefined ? s.replace(/\s+$/, '') : trimChars(s, expectString(chars, 'rstrip'), false, true);
  });

  table.set('split', (args) => {
    const [sep, max] = extras(args, 'split', ['sep', 'maxsplit']);
    const s = selfString(args);
    const maxSplit = max === undefined ? -1 : expectInt(max, 'split');
    if (sep === undefined || sep === null) {
      return splitOn(s, /\s+/, maxSplit, false);
    }
    const separator = expectString(sep, 'split');
    if (separator === '') throw makeError('ValueError', "le separateur de 'split' ne peut pas etre vide");
    return splitOn(s, separator, maxSplit, false);
  });

  table.set('join', (args, context) => {
    arityCheck(args, 'join', 2);
    const s = selfString(args);
    const items = context.iterate(extra(args, 0));
    for (const item of items) {
      if (typeof item !== 'string') {
        throw makeError('TypeError', `'join' attend des chaines, recu '${typeName(item)}'`);
      }
    }
    return items.join(s);
  });

  table.set('rsplit', (args) => {
    const [sep, max] = extras(args, 'rsplit', ['sep', 'maxsplit']);
    const s = selfString(args);
    const maxSplit = max === undefined ? -1 : expectInt(max, 'rsplit');
    if (sep === undefined || sep === null) {
      return splitOn(s, /\s+/, maxSplit, true);
    }
    const separator = expectString(sep, 'rsplit');
    if (separator === '') throw makeError('ValueError', "le separateur de 'rsplit' ne peut pas etre vide");
    return splitOn(s, separator, maxSplit, true);
  });

  table.set('replace', (args) => {
    const [from, to, count] = extras(args, 'replace', ['old', 'new', 'count'], 2);
    const s = selfString(args);
    const search = expectString(from as UchiValue, 'replace');
    const replacement = expectString(to as UchiValue, 'replace');
    const limit = count === undefined ? -1 : expectInt(count, 'replace');
    if (search === '') throw makeError('ValueError', "'replace' ne peut pas remplacer la chaine vide");
    return limit < 0 ? s.split(search).join(replacement) : replaceLimited(s, search, replacement, limit);
  });

  table.set('startswith', (args) => {
    const [prefix, start, end] = extras(args, 'startswith', ['prefix', 'start', 'end'], 1);
    const s = selfString(args);
    const from = start === undefined ? 0 : expectInt(start, 'startswith');
    const to = end === undefined ? s.length : expectInt(end, 'startswith');
    if (prefix instanceof UchiTuple) {
      return prefix.items.some((p) => startsAt(s, expectString(p, 'startswith'), from, to));
    }
    return startsAt(s, expectString(prefix as UchiValue, 'startswith'), from, to);
  });

  table.set('endswith', (args) => {
    const [suffix, start, end] = extras(args, 'endswith', ['suffix', 'start', 'end'], 1);
    const s = selfString(args);
    const from = start === undefined ? 0 : expectInt(start, 'endswith');
    const to = end === undefined ? s.length : expectInt(end, 'endswith');
    const check = (p: string) => s.slice(from, to).endsWith(p);
    if (suffix instanceof UchiTuple) return suffix.items.some((p) => check(expectString(p, 'endswith')));
    return check(expectString(suffix as UchiValue, 'endswith'));
  });

  table.set('find', (args) => {
    const [needle, start] = extras(args, 'find', ['sub', 'start', 'end'], 1);
    const s = selfString(args);
    const from = start === undefined ? 0 : expectInt(start, 'find');
    return s.indexOf(expectString(needle as UchiValue, 'find'), from);
  });

  table.set('rfind', (args) => {
    const [needle, , end] = extras(args, 'rfind', ['sub', 'start', 'end'], 1);
    const s = selfString(args);
    const to = end === undefined ? s.length : expectInt(end, 'rfind');
    return s.lastIndexOf(expectString(needle as UchiValue, 'rfind'), to - 1 < 0 ? 0 : to - 1);
  });

  table.set('index', (args) => {
    const [needle, start] = extras(args, 'index', ['sub', 'start', 'end'], 1);
    const s = selfString(args);
    const search = expectString(needle as UchiValue, 'index');
    const from = start === undefined ? 0 : expectInt(start, 'index');
    const found = s.indexOf(search, from);
    if (found === -1) throw makeError('ValueError', `sous-chaine '${search}' introuvable`);
    return found;
  });

  table.set('count', (args) => {
    const [needle] = extras(args, 'count', ['sub', 'start', 'end'], 1);
    const s = selfString(args);
    const search = expectString(needle as UchiValue, 'count');
    if (search === '') return s.length + 1;
    return s.split(search).length - 1;
  });

  table.set('removeprefix', (args) => {
    const [prefix] = extras(args, 'removeprefix', ['prefix'], 1);
    const s = selfString(args);
    const text = expectString(prefix as UchiValue, 'removeprefix');
    return s.startsWith(text) ? s.slice(text.length) : s;
  });

  table.set('removesuffix', (args) => {
    const [suffix] = extras(args, 'removesuffix', ['suffix'], 1);
    const s = selfString(args);
    const text = expectString(suffix as UchiValue, 'removesuffix');
    return s.endsWith(text) && text !== '' ? s.slice(0, -text.length) : s;
  });

  const justify = (name: string, mode: '<' | '>' | '^') => {
    table.set(name, (args) => {
      const [width, fill] = extras(args, name, ['width', 'fillchar'], 1);
      const s = selfString(args);
      const target = expectInt(width as UchiValue, name);
      const filler = fill === undefined ? ' ' : expectString(fill, name).charAt(0);
      if (s.length >= target) return s;
      const missing = target - s.length;
      if (mode === '<') return s + filler.repeat(missing);
      if (mode === '>') return filler.repeat(missing) + s;
      const left = Math.floor(missing / 2);
      return filler.repeat(left) + s + filler.repeat(missing - left);
    });
  };
  justify('ljust', '<');
  justify('rjust', '>');
  justify('center', '^');

  table.set('zfill', (args) => {
    const [width] = extras(args, 'zfill', ['width'], 1);
    const s = selfString(args);
    const target = expectInt(width as UchiValue, 'zfill');
    if (s.length >= target) return s;
    const sign = /^[+-]/.test(s) ? s.charAt(0) : '';
    const body = sign === '' ? s : s.slice(1);
    return sign + '0'.repeat(target - s.length) + body;
  });

  // `format` accepte un nombre libre d'arguments : la validation se fait champ
  // par champ dans `formatString`, qui signale les index et noms manquants.
  table.set('format', (args, context) => {
    arityAtLeast(args, 'format', 1);
    return formatString(selfString(args), args, context);
  });
  table.set('partition', (args) => {
    const [sep] = extras(args, 'partition', ['sep'], 1);
    const s = selfString(args);
    const separator = expectString(sep as UchiValue, 'partition');
    if (separator === '') throw makeError('ValueError', "le separateur de 'partition' ne peut pas etre vide");
    const at = s.indexOf(separator);
    if (at === -1) return new UchiTuple([s, '', '']);
    return new UchiTuple([s.slice(0, at), separator, s.slice(at + separator.length)]);
  });

  table.set('rpartition', (args) => {
    const [sep] = extras(args, 'rpartition', ['sep'], 1);
    const s = selfString(args);
    const separator = expectString(sep as UchiValue, 'rpartition');
    if (separator === '') throw makeError('ValueError', "le separateur de 'rpartition' ne peut pas etre vide");
    const at = s.lastIndexOf(separator);
    if (at === -1) return new UchiTuple(['', '', s]);
    return new UchiTuple([s.slice(0, at), separator, s.slice(at + separator.length)]);
  });

  table.set('expandtabs', (args) => {
    arityCheck(args, 'expandtabs', 1, 2);
    const s = selfString(args);
    const size = extraCount(args) > 0 ? expectInt(extra(args, 0), 'expandtabs') : 8;
    if (size <= 0) return s.replace(/\t/g, '');
    return s.replace(/\t/g, ' '.repeat(size));
  });

  return table;
}

/**
 * Coupe `s` selon `separator`, avec la meme limite que `str.split` et
 * `str.rsplit` : `max` coupures au plus, depuis la gauche (`fromRight` faux) ou
 * depuis la droite (`fromRight` vrai).
 *
 * `'a-b-c'.rsplit('-', 1)` vaut `['a-b', 'c']`, pas `['a', 'b-c']`.
 */
function splitOn(
  s: string,
  separator: string | RegExp,
  max: number,
  fromRight: boolean,
): string[] {
  const cuts = separatorIndices(s, separator);
  const used =
    max < 0
      ? cuts
      : fromRight
        ? cuts.slice(Math.max(0, cuts.length - max))
        : cuts.slice(0, max);
  const parts: string[] = [];
  let start = 0;
  for (const cut of used) {
    parts.push(s.slice(start, cut));
    start = cut + separatorLength(separator, s, cut);
  }
  parts.push(s.slice(start));
  // Une expression reguliere peut produire des morceaux vides : Python les
  // supprime, un separateur litteral les conserve.
  return typeof separator === 'string' ? parts : parts.filter((p) => p.length > 0);
}

/** Coupe depuis la droite, comme `str.rsplit`. */
function rsplitOn(s: string, separator: string | RegExp, max: number): string[] {
  return splitOn(s, separator, max, true);
}

/** Indices de debut de chaque separateur, de gauche a droite. */
function separatorIndices(s: string, separator: string | RegExp): number[] {
  const found: number[] = [];
  if (typeof separator === 'string') {
    let at = s.indexOf(separator);
    while (at !== -1) {
      found.push(at);
      at = s.indexOf(separator, at + separator.length);
    }
    return found;
  }
  const pattern = new RegExp(separator.source, separator.flags.includes('g') ? separator.flags : `${separator.flags}g`);
  for (let match = pattern.exec(s); match !== null; match = pattern.exec(s)) {
    if (match[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    found.push(match.index);
  }
  return found;
}

/** Longueur du separateur a la position donnee (les groupes sont ignores). */
function separatorLength(separator: string | RegExp, s: string, at: number): number {
  if (typeof separator === 'string') return separator.length;
  return new RegExp(separator.source, separator.flags).exec(s.slice(at))?.[0].length ?? 0;
}

function replaceLimited(s: string, from: string, to: string, count: number): string {
  let out = '';
  let rest = s;
  let done = 0;
  for (;;) {
    if (done >= count) break;
    const at = rest.indexOf(from);
    if (at === -1) break;
    out += rest.slice(0, at) + to;
    rest = rest.slice(at + from.length);
    done++;
  }
  return out + rest;
}

function startsAt(s: string, prefix: string, start: number, end: number): boolean {
  return s.slice(start, end).startsWith(prefix);
}

function trimChars(s: string, chars: string, left: boolean, right: boolean): string {
  const set = new Set(chars);
  let start = 0;
  let stop = s.length;
  if (left) while (start < stop && set.has(s.charAt(start))) start++;
  if (right) while (stop > start && set.has(s.charAt(stop - 1))) stop--;
  return s.slice(start, stop);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/** Analyse `{0}`, `{nom}`, `{0.attr}`, `{cle[0]}`, `{x:spec}`. */
function formatString(
  template: string,
  args: NativeCallArgs,
  ctx: HostContext,
): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const c = template.charAt(i);
    if (c === '{') {
      if (template.charAt(i + 1) === '{') {
        out += '{';
        i += 2;
        continue;
      }
      const close = template.indexOf('}', i);
      if (close === -1) throw makeError('ValueError', "accolade '}' non fermee dans le gabarit");
      const field = template.slice(i + 1, close);
      out += formatField(field, args, ctx);
      i = close + 1;
      continue;
    }
    if (c === '}') {
      if (template.charAt(i + 1) === '}') {
        out += '}';
        i += 2;
        continue;
      }
      throw makeError('ValueError', "accolade '}' orpheline dans le gabarit");
    }
    out += c;
    i++;
  }
  return out;
}

function formatField(field: string, args: NativeCallArgs, ctx: HostContext): string {
  const colon = findSpecSeparator(field);
  const namePart = (colon === -1 ? field : field.slice(0, colon)).trim();
  const spec = colon === -1 ? '' : field.slice(colon + 1);

  const { root, rest } = splitField(namePart);
  let value: UchiValue;
  if (/^\d+$/.test(root)) {
    const position = Number.parseInt(root, 10);
    if (position >= extraCount(args)) {
      throw makeError('IndexError', `pas d'argument positionnel ${position} pour le gabarit`);
    }
    value = extra(args, position);
  } else {
    if (!args.keyword.has(root)) {
      throw makeError('KeyError', `pas d'argument nomme '${root}' pour le gabarit`);
    }
    value = args.keyword.get(root) as UchiValue;
  }

  for (const step of rest) {
    if (step.kind === 'attr') {
      value = readAttribute(value, step.name);
    } else {
      value = ctx.getItemOf(value, step.key);
    }
  }

  if (spec.includes('{')) {
    throw makeError('ValueError', 'les champs imbriques ne sont pas supportes dans un gabarit');
  }
  return applyFormat(value, spec);
}

/** Position du `:` de format, en ignorant ceux situes dans `[]` ou `()`. */
function findSpecSeparator(field: string): number {
  let depth = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field.charAt(i);
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

interface FieldStep {
  kind: 'attr' | 'index';
  name: string;
  key: UchiValue;
}

function splitField(namePart: string): { root: string; rest: FieldStep[] } {
  const rest: FieldStep[] = [];
  let i = 0;
  while (i < namePart.length && namePart.charAt(i) !== '.' && namePart.charAt(i) !== '[') i++;
  const root = namePart.slice(0, i);

  while (i < namePart.length) {
    if (namePart.charAt(i) === '.') {
      i++;
      let j = i;
      while (j < namePart.length && /[A-Za-z0-9_]/.test(namePart.charAt(j))) j++;
      if (j === i) throw makeError('ValueError', "nom d'attribut vide dans un gabarit");
      rest.push({ kind: 'attr', name: namePart.slice(i, j), key: null as never });
      i = j;
      continue;
    }
    if (namePart.charAt(i) === '[') {
      const close = namePart.indexOf(']', i);
      if (close === -1) throw makeError('ValueError', "crochet ']' non ferme dans un gabarit");
      const inner = namePart.slice(i + 1, close).trim();
      const key = /^-?\d+$/.test(inner) ? Number.parseInt(inner, 10) : inner;
      rest.push({ kind: 'index', name: '', key });
      i = close + 1;
      continue;
    }
    throw makeError('ValueError', `gabarit invalide : '${namePart}'`);
  }
  return { root, rest };
}

function readAttribute(target: UchiValue, name: string): UchiValue {
  if (target instanceof UchiInstance) {
    const field = target.get(name);
    if (field !== undefined) return field;
  }
  if (target instanceof UchiDict) {
    const value = target.get(name);
    if (value !== undefined) return value;
  }
  throw makeError('AttributeError', `l'objet de type '${typeName(target)}' n'a pas d'attribut '${name}'`);
}

// =============================================================== methodes list

export function listMethods(ctx: HostContext): MethodTable {
  const table: MethodTable = new Map();
  const self = (args: NativeCallArgs): UchiList => {
    if (!isList(arg(args, 0))) {
      throw makeError('TypeError', `methode de liste appelee sur '${typeName(arg(args, 0))}'`);
    }
    return arg(args, 0) as UchiList;
  };

  table.set('append', (args) => {
    arityCheck(args, 'append', 2);
    self(args).push(arg(args, 1));
    return null;
  });

  table.set('extend', (args, context) => {
    arityCheck(args, 'extend', 2);
    self(args).push(...context.iterate(arg(args, 1)));
    return null;
  });

  table.set('insert', (args) => {
    arityCheck(args, 'insert', 3);
    const items = self(args);
    const raw = expectInt(arg(args, 1), 'insert');
    const position = raw < 0 ? Math.max(0, items.length + raw) : Math.min(raw, items.length);
    items.splice(position, 0, arg(args, 2));
    return null;
  });

  table.set('pop', (args) => {
    arityCheck(args, 'pop', 1, 2);
    const items = self(args);
    if (items.length === 0) throw makeError('IndexError', "pop() sur une liste vide");
    const raw = args.positional.length > 1 ? expectInt(arg(args, 1), 'pop') : items.length - 1;
    const position = raw < 0 ? raw + items.length : raw;
    if (position < 0 || position >= items.length) {
      throw makeError('IndexError', `pop(): index ${raw} hors limites (longueur ${items.length})`);
    }
    return items.splice(position, 1)[0] as UchiValue;
  });

  table.set('remove', (args) => {
    arityCheck(args, 'remove', 2);
    const items = self(args);
    const needle = arg(args, 1);
    const at = items.findIndex((item) => equals(item, needle));
    if (at === -1) throw makeError('ValueError', `${toRepr(needle)} n'est pas dans la liste`);
    items.splice(at, 1);
    return null;
  });

  table.set('clear', (args) => {
    arityCheck(args, 'clear', 1);
    self(args).length = 0;
    return null;
  });

  table.set('copy', (args) => {
    arityCheck(args, 'copy', 1);
    return self(args).slice();
  });

  table.set('index', (args) => {
    arityCheck(args, 'index', 2, 3);
    const items = self(args);
    const needle = arg(args, 1);
    const start = args.positional.length > 2 ? expectInt(arg(args, 2), 'index') : 0;
    for (let i = Math.max(0, start); i < items.length; i++) {
      if (equals(items[i] as UchiValue, needle)) return i;
    }
    throw makeError('ValueError', `${toRepr(needle)} n'est pas dans la liste`);
  });

  const count = (items: UchiValue[], needle: UchiValue): number =>
    items.reduce<number>((total, item) => total + (equals(item, needle) ? 1 : 0), 0);

  table.set('count', (args) => {
    arityCheck(args, 'count', 2);
    return count(self(args), extra(args, 0));
  });

  table.set('reverse', (args) => {
    arityCheck(args, 'reverse', 1);
    self(args).reverse();
    return null;
  });

  table.set('sort', (args, context) => {
    arityCheck(args, 'sort', 1);
    const keyFn = kwarg(args, 'key', null);
    const reverse = truthyArg(kwarg(args, 'reverse', false), 'reverse');
    sortInPlace(self(args), keyFn, reverse, context);
    return null;
  });

  return table;
}

/** Tri stable, comme celui de Python. */
export function sortInPlace(
  items: UchiValue[],
  keyFn: UchiValue,
  reverse: boolean,
  ctx: HostContext,
): void {
  const decorated = items.map((value, index) => ({
    value,
    index,
    key: keyFn === null ? value : ctx.callValue(keyFn, [value]),
  }));
  decorated.sort((a, b) => {
    const order = compareKeys(a.key, b.key);
    if (order !== 0) return order;
    return a.index - b.index; // stabilite
  });
  const sorted = reverse ? decorated.reverse() : decorated;
  for (let i = 0; i < items.length; i++) items[i] = sorted[i]!.value;
}

function compareKeys(a: UchiValue, b: UchiValue): number {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (isList(a) && isList(b)) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const order = compareKeys(a[i] as UchiValue, b[i] as UchiValue);
      if (order !== 0) return order;
    }
    return a.length - b.length;
  }
  throw makeError(
    'TypeError',
    `les elements ne sont pas ordonnables entre '${typeName(a)}' et '${typeName(b)}'`,
  );
}

function truthyArg(value: UchiValue, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw makeError('TypeError', `'${name}' attend un booleen, recu '${typeName(value)}'`);
  }
  return value;
}

// ============================================================== methodes dict

export function dictMethods(): MethodTable {
  const table: MethodTable = new Map();
  const self = (args: NativeCallArgs): UchiDict => {
    if (!(arg(args, 0) instanceof UchiDict)) {
      throw makeError('TypeError', `methode de dict appelee sur '${typeName(arg(args, 0))}'`);
    }
    return arg(args, 0) as UchiDict;
  };

  table.set('keys', (args) => {
    arityCheck(args, 'keys', 1);
    return [...self(args).keys()];
  });

  table.set('values', (args) => {
    arityCheck(args, 'values', 1);
    return [...self(args).values()];
  });

  table.set('items', (args) => {
    arityCheck(args, 'items', 1);
    return [...self(args).entriesIterator()].map(([k, v]) => new UchiTuple([k, v]));
  });

  table.set('get', (args) => {
    arityCheck(args, 'get', 2, 3);
    const d = self(args);
    const key = arg(args, 1);
    if (d.has(key)) return d.get(key) as UchiValue;
    return args.positional.length > 2 ? arg(args, 2) : null;
  });

  table.set('pop', (args) => {
    arityCheck(args, 'pop', 2, 3);
    const d = self(args);
    const key = arg(args, 1);
    if (!d.has(key)) {
      if (args.positional.length > 2) return arg(args, 2);
      throw makeError('KeyError', toRepr(key));
    }
    const value = d.get(key) as UchiValue;
    d.delete(key);
    return value;
  });

  table.set('setdefault', (args) => {
    arityCheck(args, 'setdefault', 2, 3);
    const d = self(args);
    const key = arg(args, 1);
    if (d.has(key)) return d.get(key) as UchiValue;
    const fallback = args.positional.length > 2 ? arg(args, 2) : null;
    d.set(key, fallback);
    return fallback;
  });

  table.set('update', (args) => {
    arityCheck(args, 'update', 1, 2);
    const d = self(args);
    for (const source of args.positional.slice(1)) mergeInto(d, source);
    for (const [key, value] of args.keyword) d.set(key, value);
    return null;
  });

  table.set('clear', (args) => {
    arityCheck(args, 'clear', 1);
    const d = self(args);
    for (const key of [...d.keys()]) d.delete(key);
    return null;
  });

  table.set('copy', (args) => {
    arityCheck(args, 'copy', 1);
    return new UchiDict(self(args).entriesIterator());
  });

  return table;
}

export function mergeInto(target: UchiDict, source: UchiValue): void {
  if (source instanceof UchiDict) {
    for (const [k, v] of source.entriesIterator()) target.set(k, v);
    return;
  }
  if (isList(source)) {
    for (const entry of source) {
      if (entry instanceof UchiTuple && entry.items.length === 2) {
        target.set(entry.items[0] as UchiValue, entry.items[1] as UchiValue);
        continue;
      }
      throw makeError('TypeError', "'update' attend des paires (cle, valeur)");
    }
    return;
  }
  throw makeError(
    'TypeError',
    `'update' attend un dictionnaire ou une liste de paires, recu '${typeName(source)}'`,
  );
}

// ============================================================== methodes set

export function setMethods(): MethodTable {
  const table: MethodTable = new Map();
  const self = (args: NativeCallArgs): UchiSet => {
    if (!(arg(args, 0) instanceof UchiSet)) {
      throw makeError('TypeError', `methode de set appelee sur '${typeName(arg(args, 0))}'`);
    }
    return arg(args, 0) as UchiSet;
  };
  const others = (args: NativeCallArgs): UchiValue[] => args.positional.slice(1);

  table.set('add', (args) => {
    arityCheck(args, 'add', 2);
    self(args).add(arg(args, 1));
    return null;
  });

  table.set('remove', (args) => {
    arityCheck(args, 'remove', 2);
    const s = self(args);
    const key = arg(args, 1);
    if (!s.delete(key)) throw makeError('KeyError', toRepr(key));
    return null;
  });

  table.set('discard', (args) => {
    arityCheck(args, 'discard', 2);
    self(args).delete(arg(args, 1));
    return null;
  });

  table.set('pop', (args) => {
    arityCheck(args, 'pop', 1);
    const s = self(args);
    for (const value of s.values()) {
      s.delete(value);
      return value;
    }
    throw makeError('KeyError', "pop() sur un ensemble vide");
  });

  table.set('clear', (args) => {
    arityCheck(args, 'clear', 1);
    const s = self(args);
    for (const value of [...s.values()]) s.delete(value);
    return null;
  });

  table.set('copy', (args) => {
    arityCheck(args, 'copy', 1);
    return new UchiSet(self(args).values());
  });

  const combine = (
    name: string,
    combine: (a: UchiSet, b: UchiSet) => UchiSet,
  ) => {
    table.set(name, (args) => {
      arityCheck(args, name, 1, -1);
      let result = new UchiSet(self(args).values());
      for (const other of others(args)) {
        if (!(other instanceof UchiSet)) {
          throw makeError('TypeError', `'${name}' attend des ensembles, recu '${typeName(other)}'`);
        }
        result = combine(result, other);
      }
      return result;
    });
  };

  combine('union', (a, b) => new UchiSet([...a.values(), ...b.values()]));
  combine('intersection', (a, b) => new UchiSet([...a.values()].filter((v) => b.has(v))));
  combine('difference', (a, b) => new UchiSet([...a.values()].filter((v) => !b.has(v))));
  combine('symmetric_difference', (a, b) =>
    new UchiSet(
      [...a.values()].filter((v) => !b.has(v)).concat([...b.values()].filter((v) => !a.has(v))),
    ),
  );

  const relation = (name: string, keep: (a: UchiSet, b: UchiSet) => boolean) => {
    table.set(name, (args) => {
      arityCheck(args, name, 1, -1);
      const a = self(args);
      for (const other of others(args)) {
        if (!(other instanceof UchiSet)) {
          throw makeError('TypeError', `'${name}' attend des ensembles, recu '${typeName(other)}'`);
        }
        if (!keep(a, other)) return false;
      }
      return true;
    });
  };

  relation('issubset', (a, b) => [...a.values()].every((v) => b.has(v)));
  relation('issuperset', (a, b) => [...b.values()].every((v) => a.has(v)));
  relation('isdisjoint', (a, b) => ![...a.values()].some((v) => b.has(v)));

  table.set('update', (args) => {
    arityCheck(args, 'update', 1, -1);
    const s = self(args);
    for (const other of others(args)) {
      if (!(other instanceof UchiSet)) {
        throw makeError('TypeError', `'update' attend des ensembles, recu '${typeName(other)}'`);
      }
      for (const value of other.values()) s.add(value);
    }
    return null;
  });

  return table;
}

// =========================================================== methodes tuple

export function tupleMethods(): MethodTable {
  const table: MethodTable = new Map();
  const self = (args: NativeCallArgs): UchiTuple => {
    if (!(arg(args, 0) instanceof UchiTuple)) {
      throw makeError('TypeError', `methode de tuple appelee sur '${typeName(arg(args, 0))}'`);
    }
    return arg(args, 0) as UchiTuple;
  };

  table.set('index', (args) => {
    arityCheck(args, 'index', 2, 3);
    const items = self(args).items;
    const needle = arg(args, 1);
    const start = args.positional.length > 2 ? expectInt(arg(args, 2), 'index') : 0;
    for (let i = Math.max(0, start); i < items.length; i++) {
      if (equals(items[i] as UchiValue, needle)) return i;
    }
    throw makeError('ValueError', `${toRepr(needle)} n'est pas dans le tuple`);
  });

  table.set('count', (args) => {
    arityCheck(args, 'count', 2);
    const items = self(args).items;
    const needle = arg(args, 1);
    return items.reduce<number>((total, item) => total + (equals(item, needle) ? 1 : 0), 0);
  });

  table.set('copy', (args) => {
    arityCheck(args, 'copy', 1);
    return new UchiTuple(self(args).items.slice());
  });

  return table;
}

// =========================================================== methodes range

export function rangeMethods(): MethodTable {
  const table: MethodTable = new Map();
  const self = (args: NativeCallArgs): UchiRange => {
    if (!(arg(args, 0) instanceof UchiRange)) {
      throw makeError('TypeError', `methode de range appelee sur '${typeName(arg(args, 0))}'`);
    }
    return arg(args, 0) as UchiRange;
  };

  table.set('index', (args) => {
    arityCheck(args, 'index', 2);
    const r = self(args);
    const needle = expectInt(arg(args, 1), 'index');
    for (let i = 0; i < r.length; i++) {
      if (r.at(i) === needle) return i;
    }
    throw makeError('ValueError', `${needle} n'est pas dans le range`);
  });

  table.set('count', (args) => {
    arityCheck(args, 'count', 2);
    const r = self(args);
    const needle = expectInt(arg(args, 1), 'count');
    return contains(r, needle) ? 1 : 0;
  });

  return table;
}

// ========================================================= methodes globales

export const STRING_METHODS: MethodTable = buildOnce(stringMethods);
export const LIST_METHODS: MethodTable = buildOnce(listMethods);
export const DICT_METHODS: MethodTable = buildOnce(dictMethods);
export const SET_METHODS: MethodTable = buildOnce(setMethods);
export const TUPLE_METHODS: MethodTable = buildOnce(tupleMethods);
export const RANGE_METHODS: MethodTable = buildOnce(rangeMethods);

/**
 * Les tables ne dependent pas du contexte (elles le recoivent a chaque appel),
 * elles peuvent donc etre construites une seule fois. `context` est fourni
 * par commodite pour les constructeurs qui en acceptent un.
 */
function buildOnce(build: (ctx: HostContext) => MethodTable): MethodTable {
  const inertContext: HostContext = {
    callValue: (callee) => {
      throw makeError('RuntimeError', `table de methodes non initialisee (${toStr(callee)})`);
    },
    throwError: (name, message) => {
      throw makeError(name, message);
    },
    toDisplayString: toStr,
    toInspectString: toRepr,
    iterate,
    lengthOf: (value) => (typeof value === 'string' ? value.length : 0),
    getItemOf: (value) => value as never,
    getAttribute: (value) => value as never,
    setAttribute: (target, name) => {
      throw makeError('RuntimeError', `table de methodes non initialisee (${toStr(target)}.${name})`);
    },
    instantiate: () => {
      throw makeError('RuntimeError', 'table de methodes non initialisee');
    },
  };
  return build(inertContext);
}
