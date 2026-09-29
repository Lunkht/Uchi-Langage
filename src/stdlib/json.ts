/**
 * Module `json` : encodage et decodage de donnees JSON.
 *
 * `dumps` reproduit la mise en forme de CPython (separateurs, `indent`,
 * `sort_keys`, echappements non-ASCII) et `loads` analyse le texte avec un
 * analyseur maison : les constantes `NaN`, `Infinity` et `-Infinity` sont
 * acceptees comme en Python, et les erreurs de syntaxe sont levees sous le
 * type `json.JSONDecodeError`, sous-classe de `ValueError`.
 */

import type { NativeCallArgs } from '../interpreter/context.ts';
import { arityCheck, checkNoExtraKeyword, expectString, kwarg } from '../interpreter/context.ts';
import { errorClass, makeError } from '../interpreter/error-registry.ts';
import { truthy, typeName } from '../interpreter/operations.ts';
import {
  UchiClass,
  UchiDict,
  UchiModule,
  UchiNativeFunction,
  UchiTuple,
  type UchiValue,
} from '../interpreter/values.ts';
import type { ModuleFactory } from '../interpreter/module-loader.ts';

const DUMP_KEYWORDS = [
  'skipkeys', 'ensure_ascii', 'check_circular', 'allow_nan', 'cls',
  'indent', 'separators', 'default', 'sort_keys',
];

const LOAD_KEYWORDS = ['cls', 'object_hook', 'parse_float', 'parse_int', 'parse_constant', 'object_pairs_hook'];

// ======================================================================= dumps

/** Options de `dumps`, apres lecture des arguments nommes. */
interface DumpOptions {
  skipkeys: boolean;
  ensureAscii: boolean;
  allowNan: boolean;
  indent: string | null;
  itemSeparator: string;
  keySeparator: string;
  sortKeys: boolean;
}

function readDumpOptions(args: NativeCallArgs): DumpOptions {
  const rawIndent = kwarg(args, 'indent', null);
  let indent: string | null = null;
  if (rawIndent !== null && rawIndent !== false) {
    if (typeof rawIndent === 'string') indent = rawIndent;
    else if (typeof rawIndent === 'number' && Number.isInteger(rawIndent) && rawIndent >= 0) {
      indent = ' '.repeat(rawIndent);
    } else {
      throw makeError('TypeError', "dumps() : l'option 'indent' doit etre un entier ou une chaine");
    }
  }

  const rawSeparators = kwarg(args, 'separators', null);
  let itemSeparator = ', ';
  let keySeparator = ': ';
  const pair = rawSeparators === null || rawSeparators === false
    ? null
    : Array.isArray(rawSeparators)
      ? rawSeparators
      : rawSeparators instanceof UchiTuple
        ? rawSeparators.items
        : null;
  if (pair !== null) {
    if (pair.length !== 2) {
      throw makeError('TypeError', "dumps() : 'separators' attend un couple de chaines");
    }
    itemSeparator = expectString(pair[0] as UchiValue, 'dumps()');
    keySeparator = expectString(pair[1] as UchiValue, 'dumps()');
  } else if (rawSeparators !== null && rawSeparators !== false) {
    throw makeError('TypeError', "dumps() : 'separators' attend un couple de chaines");
  }
  // Des que `indent` est present, Python passe a `(',', ': ')`, sauf si
  // `separators` est fourni explicitement.
  if (indent !== null && rawSeparators === null) {
    itemSeparator = ',';
    keySeparator = ': ';
  }

  return {
    skipkeys: flag(args, 'skipkeys', false),
    ensureAscii: flag(args, 'ensure_ascii', true),
    allowNan: flag(args, 'allow_nan', true),
    indent,
    itemSeparator,
    keySeparator,
    sortKeys: flag(args, 'sort_keys', false),
  };
}

/** Un option booleenne, avec sa valeur par defaut. */
function flag(args: NativeCallArgs, name: string, fallback: boolean): boolean {
  const value = kwarg(args, name, fallback);
  return value === fallback ? fallback : truthy(value);
}

/** Chaine JSON echappee, avec `\uXXXX` au-dela de 0x7e si `ensure_ascii`. */
function quote(text: string, ensureAscii: boolean): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (ensureAscii && code > 0x7e) {
      if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else {
        // Un caractere hors du plan de base devient une paire de surrogates.
        const adjusted = code - 0x10000;
        const high = 0xd800 + (adjusted >> 10);
        const low = 0xdc00 + (adjusted & 0x3ff);
        out += `\\u${high.toString(16)}\\u${low.toString(16)}`;
      }
    } else out += char;
  }
  return `${out}"`;
}

/** Serialise une valeur Uchi, en respectant l'indentation demandee. */
function encode(value: UchiValue, options: DumpOptions, depth: number): string {
  const newline = options.indent === null ? '' : '\n';
  const pad = options.indent === null ? '' : options.indent.repeat(depth + 1);
  const closePad = options.indent === null ? '' : options.indent.repeat(depth);

  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return nan(options.allowNan);
    if (!Number.isFinite(value)) {
      if (!options.allowNan) throw makeError('ValueError', "dumps() : l'infini n'est pas serialisable");
      return value > 0 ? 'Infinity' : '-Infinity';
    }
    return String(value);
  }
  if (typeof value === 'string') return quote(value, options.ensureAscii);

  if (Array.isArray(value) || value instanceof UchiTuple) {
    const items = value instanceof UchiTuple ? value.items : value;
    if (items.length === 0) return '[]';
    const body = items.map((item) => `${pad}${encode(item, options, depth + 1)}`);
    return `[${newline}${body.join(`${options.itemSeparator}${newline}`)}${newline}${closePad}]`;
  }

  if (value instanceof UchiDict) {
    const entries: Array<[string, UchiValue]> = [];
    for (const key of value.keys()) {
      const name = encodeKey(key, options);
      if (name === null) {
        if (options.skipkeys) continue;
        throw makeError(
          'TypeError',
          `dumps() : les cles doivent etre des chaines, des nombres ou None (recu '${typeName(key)}')`,
        );
      }
      entries.push([name, value.get(key) as UchiValue]);
    }
    if (options.sortKeys) entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (entries.length === 0) return '{}';
    const body = entries.map(
      ([name, item]) => `${pad}${quote(name, options.ensureAscii)}${options.keySeparator}${encode(item, options, depth + 1)}`,
    );
    return `{${newline}${body.join(`${options.itemSeparator}${newline}`)}${newline}${closePad}}`;
  }

  throw makeError('TypeError', `dumps() : l'objet de type '${typeName(value)}' n'est pas serialisable`);
}

function nan(allowNan: boolean): string {
  if (!allowNan) throw makeError('ValueError', "dumps() : NaN n'est pas serialisable");
  return 'NaN';
}

/** Nom d'une cle d'objet JSON, ou `null` si la cle n'est pas convertible. */
function encodeKey(key: UchiValue, options: DumpOptions): string | null {
  if (typeof key === 'string') return key;
  if (key === null) return 'null';
  if (typeof key === 'boolean') return key ? 'true' : 'false';
  if (typeof key === 'number') {
    if (Number.isFinite(key)) return String(key);
    return options.allowNan ? nan(true) : null;
  }
  return null;
}

// ======================================================================= loads

/** Erreur d'analyse, traduite ensuite en `json.JSONDecodeError`. */
class JsonSyntaxError extends Error {
  readonly reason: string;
  readonly pos: number;
  readonly lineno: number;
  readonly colno: number;

  constructor(reason: string, pos: number, lineno: number, colno: number) {
    super(reason);
    this.reason = reason;
    this.pos = pos;
    this.lineno = lineno;
    this.colno = colno;
  }
}

/** Analyseur JSON recursif descendant : les messages suivent CPython. */
class JsonReader {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parse(): UchiValue {
    this.skipSpaces();
    const value = this.readValue();
    this.skipSpaces();
    if (this.index < this.text.length) this.fail('Extra data');
    return value;
  }

  private readValue(): UchiValue {
    const char = this.text[this.index];
    if (char === undefined) this.fail('Expecting value');
    if (char === '{') return this.readObject();
    if (char === '[') return this.readArray();
    if (char === '"') return this.readString();
    for (const [literal, value] of LITERALS) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    return this.readNumber();
  }

  private readObject(): UchiDict {
    this.index++;
    const dict = new UchiDict();
    this.skipSpaces();
    if (this.text[this.index] === '}') {
      this.index++;
      return dict;
    }
    for (;;) {
      this.skipSpaces();
      if (this.text[this.index] !== '"') {
        this.fail('Expecting property name enclosed in double quotes');
      }
      const key = this.readString();
      this.skipSpaces();
      if (this.text[this.index] !== ':') this.fail("Expecting ':' delimiter");
      this.index++;
      this.skipSpaces();
      // Comme en Python, une cle en double garde la derniere valeur.
      dict.set(key, this.readValue());
      this.skipSpaces();
      const char = this.text[this.index];
      if (char === ',') {
        this.index++;
        continue;
      }
      if (char === '}') {
        this.index++;
        return dict;
      }
      this.fail("Expecting ',' delimiter");
    }
  }

  private readArray(): UchiValue[] {
    this.index++;
    const items: UchiValue[] = [];
    this.skipSpaces();
    if (this.text[this.index] === ']') {
      this.index++;
      return items;
    }
    for (;;) {
      this.skipSpaces();
      items.push(this.readValue());
      this.skipSpaces();
      const char = this.text[this.index];
      if (char === ',') {
        this.index++;
        continue;
      }
      if (char === ']') {
        this.index++;
        return items;
      }
      this.fail("Expecting ',' delimiter");
    }
  }

  private readString(): string {
    const start = this.index;
    this.index++;
    let out = '';
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) this.index = start, this.fail('Unterminated string starting at');
      if (char === '"') {
        this.index++;
        return out;
      }
      if (char !== '\\') {
        out += char;
        this.index++;
        continue;
      }
      this.index++;
      const escape = this.text[this.index];
      this.index++;
      if (escape === 'u') {
        const digits = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail('Invalid \\uXXXX escape');
        out += String.fromCharCode(parseInt(digits, 16));
        this.index += 4;
        continue;
      }
      if (ESCAPES[escape] === undefined) this.fail('Invalid \\escape');
      out += ESCAPES[escape] as string;
    }
  }

  private readNumber(): number {
    const start = this.index;
    if (this.text[this.index] === '-') this.index++;
    while (this.index < this.text.length && /[0-9eE+\-.]/.test(this.text[this.index] as string)) this.index++;
    const slice = this.text.slice(start, this.index);
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(slice)) {
      this.index = start;
      this.fail('Expecting value');
    }
    return Number(slice);
  }

  private skipSpaces(): void {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index] as string)) this.index++;
  }

  private fail(reason: string): never {
    const before = this.text.slice(0, this.index);
    const lineno = before.split('\n').length;
    const colno = this.index - (before.lastIndexOf('\n') + 1) + 1;
    throw new JsonSyntaxError(reason, this.index, lineno, colno);
  }
}

/** Mots-cles de `loads`, dont les constantes numeriques de Python. */
const LITERALS: Array<[string, UchiValue]> = [
  ['true', true],
  ['false', false],
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
];

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Leve `json.JSONDecodeError`, sous-classe de `ValueError`. */
function decodeError(error: JsonSyntaxError, klass: UchiClass): never {
  const message = `${error.reason}: line ${error.lineno} column ${error.colno} (char ${error.pos})`;
  throw makeError('json.JSONDecodeError', `json.JSONDecodeError : ${message}`, {
    klass,
    args: [message],
  });
}

// ======================================================================= module

export const jsonModule: ModuleFactory = () => {
  const module = new UchiModule('json');

  // `json.JSONDecodeError` est une vraie sous-classe de `ValueError` : le
  // runtime s'en sert aussi pour la correspondance des `except`.
  const base = errorClass('ValueError');
  const decodeErrorClass = new UchiClass('JSONDecodeError', base === undefined ? [] : [base]);
  module.set('JSONDecodeError', decodeErrorClass);

  module.set('dumps', new UchiNativeFunction('dumps', (args) => {
    arityCheck(args, 'dumps', 1);
    checkNoExtraKeyword(args, 'dumps', DUMP_KEYWORDS);
    return encode(args.positional[0] as UchiValue, readDumpOptions(args), 0);
  }));

  // `dump` serialise puis ecrit sur un flux : seule l'ecriture compte ici.
  module.set('dump', new UchiNativeFunction('dump', (args, ctx) => {
    arityCheck(args, 'dump', 2, 4);
    checkNoExtraKeyword(args, 'dump', DUMP_KEYWORDS);
    const target = args.positional[1] as UchiValue;
    const text = encode(args.positional[0] as UchiValue, readDumpOptions(args), 0);
    ctx.callValue(ctx.getAttribute(target, 'write'), [text]);
    return null;
  }));

  module.set('loads', new UchiNativeFunction('loads', (args) => {
    arityCheck(args, 'loads', 1);
    checkNoExtraKeyword(args, 'loads', LOAD_KEYWORDS);
    const source = expectString(args.positional[0] as UchiValue, 'loads()');
    try {
      return new JsonReader(source).parse();
    } catch (error) {
      if (error instanceof JsonSyntaxError) decodeError(error, decodeErrorClass);
      throw error;
    }
  }));

  // `load` fait l'inverse de `dump` : il lit tout le flux, puis le decode.
  module.set('load', new UchiNativeFunction('load', (args, ctx) => {
    arityCheck(args, 'load', 1);
    checkNoExtraKeyword(args, 'load', LOAD_KEYWORDS);
    const source = ctx.callValue(ctx.getAttribute(args.positional[0] as UchiValue, 'read'), []);
    const text = expectString(source, 'load()');
    try {
      return new JsonReader(text).parse();
    } catch (error) {
      if (error instanceof JsonSyntaxError) decodeError(error, decodeErrorClass);
      throw error;
    }
  }));

  return module;
};
