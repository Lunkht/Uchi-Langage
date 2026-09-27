/**
 * Module `re` : expressions regulieres.
 *
 * Les motifs sont traduits vers la syntaxe JavaScript avant compilation. Les
 * ecarts les plus courants avec Python sont traites :
 *
 * - `(?P<nom>...)` devient `(?<nom>...)`, `(?P=nom)` et `\g<nom>` aussi ;
 * - les options `re.I`, `re.M`, `re.S`, `re.A` et `re.U` deviennent des
 *   drapeaux JavaScript, `re.X` etant implemente a la main ;
 * - `\A`, `\Z` et `\z` sont traduits en ancres equivalentes.
 *
 * Les objets exposes sont des instances de classes natives : leur etat vit
 * dans `payload` et leurs methodes sont des `UchiNativeFunction`.
 */

import {
  arityCheck,
  expectInt,
  expectString,
  type HostContext,
  type NativeCallArgs,
} from '../interpreter/context.ts';
import { errorClass, makeError } from '../interpreter/error-registry.ts';
import {
  UchiClass,
  UchiDict,
  UchiFunction,
  UchiInstance,
  UchiModule,
  UchiNativeFunction,
  UchiTuple,
  type UchiValue,
} from '../interpreter/values.ts';
import type { ModuleFactory } from '../interpreter/module-loader.ts';

// ==================================================================== options

/** Options de `re`, exposees comme constantes numeriques comme en Python. */
const I = 2;
const M = 8;
const S = 16;
const X = 64;
const A = 256;
const U = 32;
const KNOWN_FLAGS = I | M | S | X | A | U;

// ================================================================== traduction

/**
 * Convertit un motif Python en motif JavaScript.
 *
 * La conversion reste volontairement simple : elle ne pretend pas couvrir
 * toute la syntaxe CPython, mais les formes ecrites habituellement dans un
 * programme Uchi restent valides.
 */
export function translatePattern(pattern: string, options: number): string {
  const verbose = (options & X) !== 0;
  let out = '';
  let inClass = false;
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    // `re.X` : espaces et commentaires ignores, hors classe de caracteres.
    if (verbose && !inClass) {
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        index++;
        continue;
      }
      if (char === '#') {
        while (index < pattern.length && pattern[index] !== '\n') index++;
        continue;
      }
    }

    if (char === '\\' && index + 1 < pattern.length) {
      const next = pattern[index + 1] as string;
      // Ancres propres a Python.
      if (next === 'A') {
        out += '^';
        index += 2;
        continue;
      }
      if (next === 'Z') {
        out += '(?!\\n)$';
        index += 2;
        continue;
      }
      if (next === 'z') {
        out += '$';
        index += 2;
        continue;
      }
      // Reference nommee : `\g<nom>`.
      if (next === 'g' && pattern[index + 2] === '<') {
        const close = pattern.indexOf('>', index + 3);
        if (close !== -1) {
          out += `\\k<${pattern.slice(index + 3, close)}>`;
          index = close + 1;
          continue;
        }
      }
      out += char + next;
      index += 2;
      continue;
    }

    if (char === '[') {
      inClass = true;
      out += char;
      index++;
      continue;
    }
    if (char === ']') {
      inClass = false;
      out += char;
      index++;
      continue;
    }
    if (inClass) {
      out += char;
      index++;
      continue;
    }

    if (char === '(') {
      if (pattern.startsWith('(?P<', index)) {
        out += '(?<';
        index += 4;
        continue;
      }
      if (pattern.startsWith('(?P=', index)) {
        const close = pattern.indexOf(')', index + 4);
        if (close !== -1) {
          out += `\\k<${pattern.slice(index + 4, close)}>`;
          index = close + 1;
          continue;
        }
      }
      // Options inline `(?i)` : retirees, seule l'option du motif compte.
      const inline = /^\(\?[aiLmsux]+\)/.exec(pattern.slice(index));
      if (inline !== null) {
        index += inline[0].length;
        continue;
      }
      out += char;
      index++;
      continue;
    }

    out += char;
    index++;
  }

  return out;
}

/** Drapeaux JavaScript equivalents aux options Python. */
function jsFlags(options: number): string {
  // `d` est ajoute systematiquement : `match.indices` alimente `span()`.
  let flags = 'gd';
  if (options & I) flags += 'i';
  if (options & M) flags += 'm';
  if (options & S) flags += 's';
  return flags;
}

// ==================================================================== compilation

export interface CompiledPattern {
  /** Motif d'origine, tel qu'il a ete ecrit. */
  source: string;
  flags: number;
  /** Motif traduit, avec les options JavaScript. */
  translated: string;
  /** Toujours global : `lastIndex` permet de parcourir les occurrences. */
  regexp: RegExp;
  /** Nombre de groupes capturants. */
  groupCount: number;
  /** Noms des groupes nommes, dans l'ordre d'apparition. */
  groupNames: string[];
  /** Position de chaque groupe nomme. */
  groupIndex: Record<string, number>;
}

function regexpError(message: string): never {
  const base = errorClass('Exception');
  const klass = base === undefined ? null : new UchiClass('error', [base]);
  if (klass !== null) klass.set('__name__', 'error');
  throw makeError('re.error', `re.error : ${message}`, { klass });
}

/** Nombre de groupes capturants d'un motif traduit. */
function countGroups(translated: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < translated.length; i++) {
    const char = translated[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char !== '(') continue;
    // `(?<nom>...)` est capturant, contrairement a `(?<=...)` et `(?<!...)`.
    if (translated.startsWith('(?<', i) && !translated.startsWith('(?<=', i) && !translated.startsWith('(?<!', i)) {
      count++;
      continue;
    }
    if (translated[i + 1] !== '?') count++;
  }
  return count;
}

/** Compile un motif Python, avec memorisation des motifs identiques. */
export function compilePattern(source: string, flags: number): CompiledPattern {
  if (!Number.isInteger(flags) || flags < 0 || (flags & ~KNOWN_FLAGS) !== 0) {
    throw makeError('ValueError', `valeur d'option invalide pour re.compile : ${flags}`);
  }
  const translated = translatePattern(source, flags);
  let regexp: RegExp;
  try {
    regexp = new RegExp(translated, jsFlags(flags));
  } catch (error) {
    return regexpError(`motif invalide '${source}' : ${(error as Error).message}`);
  }

  // Les groupes nommes sont numerotes dans l'ordre de leur apparition, comme
  // le fait CPython.
  const groupNames: string[] = [];
  const groupIndex: Record<string, number> = {};
  const namePattern = /\(\?<([A-Za-z_][A-Za-z_0-9]*)>/g;
  let found = namePattern.exec(translated);
  while (found !== null) {
    const name = found[1] as string;
    if (groupIndex[name] !== undefined) {
      return regexpError(`le nom de groupe '${name}' est defini plusieurs fois`);
    }
    groupNames.push(name);
    groupIndex[name] = groupNames.length;
    found = namePattern.exec(translated);
  }

  return {
    source,
    flags,
    translated,
    regexp,
    groupCount: countGroups(translated),
    groupNames,
    groupIndex,
  };
}

// ============================================================== objets natifs

interface MatchState {
  pattern: CompiledPattern;
  match: RegExpExecArray;
  string: string;
}

/** Copie un motif pour repartir d'une position donnee. */
function seek(pattern: CompiledPattern, pos: number): RegExp {
  const copy = new RegExp(pattern.translated, pattern.regexp.flags);
  copy.lastIndex = pos;
  return copy;
}

function groupPosition(pattern: CompiledPattern, value: UchiValue | undefined): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const index = pattern.groupIndex[value];
    if (index === undefined) {
      throw makeError('IndexError', `le groupe nomme '${value}' n'existe pas`);
    }
    return index;
  }
  throw makeError('IndexError', 'un numero ou un nom de groupe est attendu');
}

/**
 * Pose des methodes natives sur une classe.
 *
 * Le runtime prepend le recepteur aux arguments(positionnels) : on le retire
 * ici pour que les corpsilient une signature naturelle (`group(0)`, `sub(x)`).
 */
function defineMethods(
  klass: UchiClass,
  methods: Array<[string, number, number, (args: NativeCallArgs, ctx: HostContext) => UchiValue]>,
): void {
  for (const [name, min, max, body] of methods) {
    klass.set(name, new UchiNativeFunction(name, (args, ctx) => {
      const visible: NativeCallArgs = { positional: args.positional.slice(1), keyword: args.keyword };
      arityCheck(visible, name, min, max);
      return body(visible, ctx);
    }));
  }
}

/** Construit un objet `re.Match` autonome, avec ses methodes natives. */
function matchObject(pattern: CompiledPattern, match: RegExpExecArray, text: string): UchiInstance {
  const klass = new UchiClass('re.Match', []);
  const instance = new UchiInstance(klass);
  const state: MatchState = { pattern, match, string: text };
  instance.payload = state;

  const group = (value: UchiValue | undefined): UchiValue => {
    const index = groupPosition(pattern, value);
    if (index >= match.length) {
      throw makeError('IndexError', `le groupe ${index} n'existe pas`);
    }
    return match[index] ?? null;
  };
  const bounds = (value: UchiValue | undefined): number[] => {
    const index = groupPosition(pattern, value);
    const pair = match.indices?.[index];
    return pair === undefined ? [-1, -1] : [pair[0] as number, pair[1] as number];
  };

  defineMethods(klass, [
    ['group', 0, 1, (args) => group(args.positional[0])],
    ['groups', 0, 1, (args) => {
      const fallback = args.positional[0] === undefined ? null : (args.positional[0] as UchiValue);
      const out: UchiValue[] = [];
      for (let i = 1; i < match.length; i++) out.push(match[i] ?? fallback);
      return new UchiTuple(out);
    }],
    ['groupdict', 0, 1, (args) => {
      const fallback = args.positional[0] === undefined ? null : (args.positional[0] as UchiValue);
      const dict = new UchiDict();
      for (const [name, position] of Object.entries(pattern.groupIndex)) {
        dict.set(name, match[position] ?? fallback);
      }
      return dict;
    }],
    ['start', 0, 1, (args) => bounds(args.positional[0])[0] as number],
    ['end', 0, 1, (args) => bounds(args.positional[0])[1] as number],
    ['span', 0, 1, (args) => bounds(args.positional[0])],
    ['__repr__', 0, 0, () => {
      const groups = pattern.groupNames
        .map((name) => `, ${name}=${JSON.stringify(match[pattern.groupIndex[name] as number] ?? null)}`)
        .join('');
      return `<re.Match object; span=${match.index}, match=${JSON.stringify(match[0] ?? '')}${groups}>`;
    }],
  ]);
  // Les donnees sont des attributs d'instance : en Python, `m.string` est une
  // valeur, pas une methode.
  instance.set('lastindex', match.index ?? 0);
  instance.set('lastgroup', null);
  instance.set('string', text);
  instance.set('re', patternObject(pattern));
  instance.set('pos', match.index ?? 0);
  instance.set('endpos', (match.index ?? 0) + (match[0] as string).length);
  return instance;
}

function patternObject(pattern: CompiledPattern): UchiInstance {
  const klass = new UchiClass('re.Pattern', []);
  const instance = new UchiInstance(klass);
  instance.payload = { pattern } satisfies { pattern: CompiledPattern };

  const text = (args: NativeCallArgs, who: string): string =>
    expectString(args.positional[0] as UchiValue, who);
  const start = (args: NativeCallArgs, who: string): number =>
    args.positional[1] === undefined ? 0 : expectInt(args.positional[1] as UchiValue, who);

  defineMethods(klass, [
    ['search', 1, 2, (args) => {
      const found = seek(pattern, start(args, 'search()')).exec(text(args, 'search()'));
      return found === null ? null : matchObject(pattern, found, args.positional[0] as string);
    }],
    ['match', 1, 2, (args) => {
      const source = text(args, 'match()');
      const from = start(args, 'match()');
      const found = seek(pattern, from).exec(source);
      // `match` ancre le debut : seule une occurrence a `from` convient.
      if (found === null || found.index !== from) return null;
      return matchObject(pattern, found, source);
    }],
    ['fullmatch', 1, 2, (args) => {
      const source = text(args, 'fullmatch()');
      const from = start(args, 'fullmatch()');
      const found = seek(pattern, from).exec(source);
      if (found === null || found.index !== from) return null;
      if ((found[0] as string).length !== source.length - from) return null;
      return matchObject(pattern, found, source);
    }],
    ['findall', 1, 2, (args) => findAll(pattern, text(args, 'findall()'), start(args, 'findall()'))],
    ['finditer', 1, 2, (args) => findIter(pattern, text(args, 'finditer()'), start(args, 'finditer()'))],
    ['sub', 2, 3, (args, ctx) => substitute(pattern, ...replacementArgs(args, 'sub()'), false, ctx)],
    ['subn', 2, 3, (args, ctx) => substitute(pattern, ...replacementArgs(args, 'subn()'), true, ctx)],
    ['split', 1, 3, (args) => {
      const maxsplit = args.positional[2] === undefined
        ? 0
        : expectInt(args.positional[2] as UchiValue, 'split()');
      return splitText(pattern, text(args, 'split()'), maxsplit);
    }],
    ['__repr__', 0, 0, () => `re.compile(${JSON.stringify(pattern.source)})`],
  ]);
  // `pattern`, `flags`, `groups` et `groupindex` sont des valeurs.
  instance.set('pattern', pattern.source);
  instance.set('flags', pattern.flags);
  instance.set('groups', pattern.groupCount);
  const named = new UchiDict();
  for (const [name, position] of Object.entries(pattern.groupIndex)) named.set(name, position);
  instance.set('groupindex', named);
  return instance;
}

// ======================================================================= operations

function findAll(pattern: CompiledPattern, text: string, pos: number): UchiValue {
  const regexp = seek(pattern, pos);
  const out: UchiValue[] = [];
  for (;;) {
    const found = regexp.exec(text);
    if (found === null) break;
    // Une occurrence vide avance d'un cran pour ne pas boucler.
    if (found[0] === '') regexp.lastIndex++;
    if (pattern.groupCount === 0) {
      out.push(found[0]);
    } else if (pattern.groupCount === 1) {
      out.push(found[1] ?? null);
    } else {
      const groups: UchiValue[] = [];
      for (let i = 1; i < found.length; i++) groups.push(found[i] ?? null);
      out.push(new UchiTuple(groups));
    }
  }
  return out;
}

function findIter(pattern: CompiledPattern, text: string, pos: number): UchiValue {
  const regexp = seek(pattern, pos);
  const out: UchiValue[] = [];
  for (;;) {
    const found = regexp.exec(text);
    if (found === null) break;
    if (found[0] === '') regexp.lastIndex++;
    out.push(matchObject(pattern, found, text));
  }
  return out;
}

/**
 * Remplace `\1`, `\g<nom>` et `\\` dans un gabarit Python. La substitution est
 * ecrite a la main pour reutiliser la syntaxe de Python plutot que celle,
 * differente, de `String.replace`.
 */
function expandTemplate(
  pattern: CompiledPattern,
  template: string,
  match: RegExpExecArray,
): string {
  let out = '';
  let index = 0;
  while (index < template.length) {
    const char = template[index] as string;
    if (char !== '\\') {
      out += char;
      index++;
      continue;
    }
    const next = template[index + 1];
    if (next === '\\') {
      out += '\\';
      index += 2;
      continue;
    }
    if (next === 'g' && template[index + 2] === '<') {
      const close = template.indexOf('>', index + 3);
      if (close !== -1) {
        const name = template.slice(index + 3, close);
        const position = pattern.groupIndex[name];
        const captured = position === undefined ? null : (match[position] ?? null);
        out += captured ?? '';
        index = close + 1;
        continue;
      }
    }
    const digits = /^\d+/.exec(template.slice(index + 1));
    if (digits !== null) {
      const number = Number(digits[0]);
      if (number > 0 && number < match.length) out += match[number] ?? '';
      index += 1 + digits[0].length;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

function substitute(
  pattern: CompiledPattern,
  replacement: UchiValue,
  text: string,
  limit: number,
  withCount: boolean,
  ctx: HostContext,
): UchiValue {
  const callable = isCallable(replacement);
  if (typeof replacement !== 'string' && !callable) {
    throw makeError('TypeError', 'sub() attend une chaine ou une fonction de remplacement');
  }
  const template = typeof replacement === 'string' ? replacement : '';

  const regexp = seek(pattern, 0);
  let out = '';
  let cursor = 0;
  let count = 0;
  for (;;) {
    if (limit > 0 && count >= limit) break;
    const found = regexp.exec(text);
    if (found === null) break;
    // Une occurrence vide avance d'un cran pour ne pas boucler.
    if (found[0] === '') regexp.lastIndex++;
    count++;
    out += text.slice(cursor, found.index);
    out += callable
      ? ctx.callValue(replacement, [matchObject(pattern, found, text)])
      : expandTemplate(pattern, template, found);
    cursor = found.index + (found[0] as string).length;
  }
  out += text.slice(cursor);
  return withCount ? new UchiTuple([out, count]) : out;
}

/** `motif.sub(remplacant, texte, count=0)` : les trois arguments de `sub`. */
function replacementArgs(args: NativeCallArgs, who: string): [UchiValue, string, number] {
  const replacement = args.positional[0] as UchiValue;
  const text = expectString(args.positional[1] as UchiValue, who);
  const count = args.positional[2] === undefined
    ? 0
    : expectInt(args.positional[2] as UchiValue, who);
  return [replacement, text, count];
}

function isCallable(value: UchiValue): boolean {
  return value instanceof UchiNativeFunction || value instanceof UchiFunction;
}

/**
 * `motif.split(texte, maxsplit)`. Comme en Python, les groupes capturants
 * participates sont intercales entre les morceaux, et `None` vient a la place
 * d'un groupe absent.
 */
function splitText(pattern: CompiledPattern, text: string, maxsplit: number): UchiValue {
  const regexp = seek(pattern, 0);
  const parts: UchiValue[] = [];
  let cursor = 0;
  let count = 0;
  for (;;) {
    if (maxsplit > 0 && count >= maxsplit) break;
    const found = regexp.exec(text);
    if (found === null) break;
    // Une occurrence vide avance d'un cran pour ne pas boucler.
    if (found[0] === '') regexp.lastIndex++;
    count++;
    parts.push(text.slice(cursor, found.index));
    for (let i = 1; i <= pattern.groupCount; i++) parts.push(found[i] ?? null);
    cursor = found.index + (found[0] as string).length;
  }
  parts.push(text.slice(cursor));
  // Avec une limite, Python ne conserve pas les morceaux vides finaux.
  return maxsplit > 0 ? parts.filter((part, index) => index < parts.length - 1 || part !== '') : parts;
}

// ======================================================================== module

export const reModule: ModuleFactory = () => {
  const module = new UchiModule('re');
  module.set('I', I);
  module.set('M', M);
  module.set('S', S);
  module.set('X', X);
  module.set('A', A);
  module.set('U', U);

  const base = errorClass('Exception');
  const errorClassValue = base === undefined
    ? makeError('RuntimeError', 'la hierarchie d\'exceptions n\'est pas initialisee')
    : (() => {
        const klass = new UchiClass('error', [base]);
        klass.set('__name__', 'error');
        return klass;
      })();
  module.set('error', errorClassValue);

  module.set('compile', new UchiNativeFunction('compile', (args) => {
    arityCheck(args, 'compile', 1, 2);
    const source = expectString(args.positional[0] as UchiValue, 'compile()');
    const flags = args.positional[1] === undefined
      ? 0
      : expectInt(args.positional[1] as UchiValue, 'compile()');
    return patternObject(compilePattern(source, flags));
  }));

  /**
   * Enveloppe une fonction de module : `re.<nom>(motif, ..., options)`.
   * L'argument `flagAt` designe la position des options, qui est toujours la
   * derniere, comme dans `re.search(motif, texte, options)`.
   */
  const withPattern = (
    name: string,
    min: number,
    max: number,
    flagAt: number,
    body: (pattern: CompiledPattern, args: NativeCallArgs, ctx: HostContext) => UchiValue,
  ): void => {
    module.set(name, new UchiNativeFunction(name, (args, ctx) => {
      arityCheck(args, name, min, max);
      const source = expectString(args.positional[0] as UchiValue, `${name}()`);
      const raw = args.positional[flagAt];
      const flags = raw === undefined ? 0 : expectInt(raw, `${name}()`);
      return body(compilePattern(source, flags), args, ctx);
    }));
  };

  withPattern('search', 2, 3, 2, (pattern, args) => {
    const text = expectString(args.positional[1] as UchiValue, 'search()');
    const found = seek(pattern, 0).exec(text);
    return found === null ? null : matchObject(pattern, found, text);
  });
  withPattern('match', 2, 3, 2, (pattern, args) => {
    const text = expectString(args.positional[1] as UchiValue, 'match()');
    const found = seek(pattern, 0).exec(text);
    if (found === null || found.index !== 0) return null;
    return matchObject(pattern, found, text);
  });
  withPattern('fullmatch', 2, 3, 2, (pattern, args) => {
    const text = expectString(args.positional[1] as UchiValue, 'fullmatch()');
    const found = seek(pattern, 0).exec(text);
    if (found === null) return null;
    if ((found[0] as string).length !== text.length) return null;
    return matchObject(pattern, found, text);
  });
  withPattern('findall', 2, 3, 2, (pattern, args) =>
    findAll(pattern, expectString(args.positional[1] as UchiValue, 'findall()'), 0));
  withPattern('finditer', 2, 3, 2, (pattern, args) =>
    findIter(pattern, expectString(args.positional[1] as UchiValue, 'finditer()'), 0));
  withPattern('sub', 3, 5, 4, (pattern, args, ctx) => {
    const [replacement, text, count] = reordered(args);
    return substitute(pattern, replacement, text, count, false, ctx);
  });
  withPattern('subn', 3, 5, 4, (pattern, args, ctx) => {
    const [replacement, text, count] = reordered(args);
    return substitute(pattern, replacement, text, count, true, ctx);
  });
  withPattern('split', 2, 4, 3, (pattern, args) => {
    const text = expectString(args.positional[1] as UchiValue, 'split()');
    const maxsplit = args.positional[2] === undefined
      ? 0
      : expectInt(args.positional[2] as UchiValue, 'split()');
    return splitText(pattern, text, maxsplit);
  });

  module.set('escape', new UchiNativeFunction('escape', (args) => {
    arityCheck(args, 'escape', 1);
    const text = expectString(args.positional[0] as UchiValue, 'escape()');
    let out = '';
    for (const char of text) {
      if (/[A-Za-z0-9_]/.test(char)) out += char;
      else if (char === '\n') out += '\\\n';
      else if (char === '\r') out += '\\r';
      else if (char === '\t') out += '\\t';
      else out += `\\${char}`;
    }
    return out;
  }));

  return module;
};

/** `re.sub(motif, remplacant, texte, count=0)` : les trois derniers arguments. */
function reordered(args: NativeCallArgs): [UchiValue, string, number] {
  const replacement = args.positional[1] as UchiValue;
  const text = expectString(args.positional[2] as UchiValue, 'sub()');
  const count = args.positional[3] === undefined
    ? 0
    : expectInt(args.positional[3] as UchiValue, 'sub()');
  return [replacement, text, count];
}
