/**
 * Fonctions et types integres d'Uchi.
 *
 * Ce module construit la portee des builtins. Il depend du `HostContext` de
 * l'interpreteur et non de l'interpreteur lui-meme, ce qui evite les cycles
 * d'import : seules les fonctionnalites qui exigent un acces direct
 * (`print`, `input`, `super`, `open`) capturent l'instance explicitement.
 */

import type { Interpreter } from '../interpreter/interpreter.ts';
import { makeError, registerErrorClass } from '../interpreter/error-registry.ts';
import { applyFormat } from '../interpreter/format.ts';
import { compare, truthy, typeName } from '../interpreter/operations.ts';
import {
  DICT_METHODS,
  LIST_METHODS,
  RANGE_METHODS,
  SET_METHODS,
  STRING_METHODS,
  TUPLE_METHODS,
  type MethodTable,
} from '../interpreter/native-methods.ts';
import {
  UchiClass,
  UchiDict,
  UchiError,
  UchiInstance,
  UchiModule,
  UchiNativeFunction,
  UchiRange,
  UchiSet,
  UchiTuple,
  isCallable,
  isList,
  type UchiValue,
} from '../interpreter/values.ts';
import type { HostContext, NativeCallArgs } from '../interpreter/context.ts';
import { arityAtLeast, arityCheck, expectInt, expectNumber, expectString } from '../interpreter/context.ts';
import { createFileBuiltins } from './files.ts';
import { UCHI_VERSION } from './version.ts';

// ==================================================================== utilitaires

type NativeBody = (args: NativeCallArgs, ctx: HostContext) => UchiValue;

function native(name: string, body: NativeBody, keywords: string[] = []): UchiNativeFunction {
  return new UchiNativeFunction(name, body, -1, keywords);
}

function optional(args: NativeCallArgs, index: number, fallback: UchiValue): UchiValue {
  return args.positional[index] ?? fallback;
}

function at(args: NativeCallArgs, index: number): UchiValue {
  const value = args.positional[index];
  if (value === undefined) {
    throw makeError('TypeError', `argument ${index} manquant`);
  }
  return value;
}

function keyFunction(ctx: HostContext, key: UchiValue | undefined) {
  if (key === undefined || key === null) return (value: UchiValue) => value;
  return (value: UchiValue) => ctx.callValue(key, [value]);
}

// ============================================================ types de base

/**
 * Conversions des types integres.
 *
 * Le meme code sert a `list(x)` et a `type(x)`, car ces deux operations sont
 * les deux faces d'un objet unique : la classe `list` sert de reference pour
 * `isinstance`, et sa conversion sert a fabriquer une liste.
 */
const CONVERTERS: Record<string, (args: NativeCallArgs, ctx: HostContext) => UchiValue> = {
  object: (args, ctx) => (args.positional[0] === undefined ? null : args.positional[0]),
  // `NoneType()` vaut `None`, comme en Python. Le type de `None` porte ce
  // nom la ou `typeName` continue de rapporter 'None' dans les messages.
  NoneType: () => null,
  str: (args, ctx) => (args.positional[0] === undefined ? '' : ctx.toDisplayString(args.positional[0])),
  int: (args) => {
    arityCheck(args, 'int', 1, 2);
    const base = args.positional[1];
    return toInteger(at(args, 0), base === undefined ? 10 : expectInt(base, 'int()'));
  },
  float: (args) => {
    arityCheck(args, 'float', 1);
    return toFloat(at(args, 0));
  },
  bool: (args, ctx) => {
    arityCheck(args, 'bool', 1);
    return truthy(at(args, 0));
  },
  list: (args, ctx) => {
    arityCheck(args, 'list', 0, 1);
    return args.positional[0] === undefined ? [] : ctx.iterate(args.positional[0]);
  },
  tuple: (args, ctx) => {
    arityCheck(args, 'tuple', 0, 1);
    return new UchiTuple(args.positional[0] === undefined ? [] : ctx.iterate(args.positional[0]));
  },
  set: (args, ctx) => {
    arityCheck(args, 'set', 0, 1);
    return new UchiSet(args.positional[0] === undefined ? [] : ctx.iterate(args.positional[0]));
  },
  dict: (args, ctx) => {
    if (args.positional.length === 0) return new UchiDict();
    const source = at(args, 0);
    if (source instanceof UchiDict) return new UchiDict(source.entriesIterator());
    if (source instanceof UchiInstance) {
      const result = new UchiDict();
      for (const key of ctx.iterate(source)) result.set(key, ctx.getItemOf(source, key));
      return result;
    }
    const result = new UchiDict();
    for (const pair of ctx.iterate(source)) {
      const items = ctx.iterate(pair);
      if (items.length !== 2) {
        throw makeError('ValueError', 'chaque element de dict() doit contenir exactement 2 valeurs');
      }
      result.set(items[0] as UchiValue, items[1] as UchiValue);
    }
    return result;
  },
};

/** Noms des types integres, dans l'ordre utilise par `repr()`. */
const BUILTIN_TYPE_NAMES = [
  'object',
  'int',
  'float',
  'bool',
  'str',
  'list',
  'tuple',
  'dict',
  'set',
  'NoneType',
] as const;

/**
 * Classes de reference pour `isinstance()` et `type()`.
 *
 * Elles sont creees une seule fois : `type(x)` renvoie la meme instance que le
 * nom global, si bien que `type([]) == list` est vrai. Chaque classe porte sa
 * conversion, ce qui permet d'ecrire `list([1, 2])` comme en Python.
 *
 * `range` n'en fait pas partie : ce nom designe deja la fonction `range()`, et
 * l'ecraser par une classe rendrait la construction impossible.
 */
/**
 * Heritage des types integres. En Python, `bool` herite de `int`, mais `int`
 * n'herite pas de `float` : la tour numerique ne se voit que dans
 * `isinstance()`, traitee par `matchesType`.
 */
const BUILTIN_TYPE_BASES: Readonly<Record<string, readonly string[]>> = {
  bool: ['int'],
};

const builtinTypeClassMap = new Map<string, UchiClass>();

export function builtinTypeClass(name: string): UchiClass | undefined {
  if (!builtinTypeClassMap.has(name)) {
    const converter = CONVERTERS[name];
    if (converter === undefined) return undefined;
    const bases = (BUILTIN_TYPE_BASES[name] ?? []).map(
      (base) => builtinTypeClass(base) as UchiClass,
    );
    builtinTypeClassMap.set(name, new UchiClass(name, bases, converter));
  }
  return builtinTypeClassMap.get(name);
}

export function builtinTypeClasses(): Array<[string, UchiClass]> {
  return BUILTIN_TYPE_NAMES.map((name) => [name, builtinTypeClass(name) as UchiClass]);
}

/** Nom de type connu, pour que `type(x)` et `x.__class__` partagent la classe. */
export function builtinTypeNames(): readonly string[] {
  return BUILTIN_TYPE_NAMES;
}

/** Nom de la classe de `value` : `None` se nomme `NoneType`, comme en Python. */
export function classNameOf(value: UchiValue): string {
  return value === null ? 'NoneType' : typeName(value);
}

// ============================================================== exceptions

/** Noms d'exceptions integres, avec leur classe de base. */
const ERROR_HIERARCHY: Array<[string, string | null]> = [
  ['BaseException', null],
  ['Exception', 'BaseException'],
  ['Error', 'Exception'],
  ['SyntaxError', 'Error'],
  ['TypeError', 'Exception'],
  ['ValueError', 'Exception'],
  ['NameError', 'Exception'],
  ['AttributeError', 'Exception'],
  ['RuntimeError', 'Exception'],
  ['AssertionError', 'Exception'],
  ['NotImplementedError', 'Exception'],
  ['StopIteration', 'Exception'],
  ['EOFError', 'Exception'],
  ['SystemExit', 'BaseException'],
  ['ArithmeticError', 'Exception'],
  ['OverflowError', 'ArithmeticError'],
  ['ZeroDivisionError', 'ArithmeticError'],
  ['LookupError', 'Exception'],
  ['IndexError', 'LookupError'],
  ['KeyError', 'LookupError'],
  ['ImportError', 'Exception'],
  ['ModuleNotFoundError', 'ImportError'],
  ['RecursionError', 'RuntimeError'],
  ['InternalError', 'Exception'],
  // Exceptions systeme : leurs noms sont utilisables dans `except`, et
  // `errorMatches` retombe sur le nom quand aucune classe ne correspond.
  ['OSError', 'Exception'],
  ['BlockingIOError', 'OSError'],
  ['ChildProcessError', 'OSError'],
  ['ConnectionError', 'OSError'],
  ['BrokenPipeError', 'ConnectionError'],
  ['ConnectionAbortedError', 'ConnectionError'],
  ['ConnectionRefusedError', 'ConnectionError'],
  ['ConnectionResetError', 'ConnectionError'],
  ['FileExistsError', 'OSError'],
  ['FileNotFoundError', 'OSError'],
  ['InterruptedError', 'OSError'],
  ['IsADirectoryError', 'OSError'],
  ['NotADirectoryError', 'OSError'],
  ['PermissionError', 'OSError'],
  ['ProcessLookupError', 'OSError'],
  ['TimeoutError', 'OSError'],
];

const errorClasses = new Map<string, UchiClass>();

export function errorClassByName(name: string): UchiClass | undefined {
  return errorClasses.get(name);
}

function buildErrorClasses(): void {
  for (const [name, baseName] of ERROR_HIERARCHY) {
    const base = baseName === null ? [] : [errorClasses.get(baseName) as UchiClass];
    const klass = new UchiClass(name, base);
    klass.set('__name__', name);
    errorClasses.set(name, klass);
    registerErrorClass(name, klass);
  }
}

// ==================================================================== builtins

export function createBuiltins(interpreter: Interpreter): Array<[string, UchiValue]> {
  buildErrorClasses();

  const builtins: Array<[string, UchiValue]> = [];

  const add = (name: string, body: NativeBody, keywords: string[] = []): void => {
    builtins.push([name, native(name, body, keywords)]);
  };

  // ------------------------------------------------------------- affichage

  add('print', (args, ctx) => {
    const separator = args.keyword.get('sep') ?? ' ';
    const end = args.keyword.get('end') ?? '\n';
    if (typeof separator !== 'string' || typeof end !== 'string') {
      throw makeError('TypeError', "'sep' et 'end' de print() doivent etre des chaines");
    }
    const text = args.positional.map((value) => ctx.toDisplayString(value)).join(separator);
    interpreter.print(text + end);
    return null;
  }, ['sep', 'end']);

  add('input', (args, ctx) => {
    const prompt = args.positional[0] === undefined ? '' : ctx.toDisplayString(args.positional[0]);
    const line = interpreter.readLine(prompt);
    if (line === null) {
      throw makeError('EOFError', 'fin du flux d\'entree atteinte');
    }
    return line;
  });

  add('len', (args, ctx) => {
    arityCheck(args, 'len', 1);
    return ctx.lengthOf(at(args, 0));
  });

  add('repr', (args, ctx) => {
    arityCheck(args, 'repr', 1);
    return ctx.toInspectString(at(args, 0));
  });

  // Deux usages, comme dans les versions recentes de Python : appliquer un
  // gabarit a une valeur (`format(3.14159, '.2f')`) ou construire une chaine
  // par champs (`format('{0}-{1}', 1, 2)`).
  add('format', (args, ctx) => {
    const template = at(args, 0);
    const looksLikeTemplate = typeof template === 'string' && template.includes('{');
    if (args.positional.length > 1 && !looksLikeTemplate) {
      const spec = args.positional[1] as UchiValue;
      if (typeof spec !== 'string') {
        throw makeError('TypeError', `le gabarit de format() doit etre une chaine, recu '${typeName(spec)}'`);
      }
      return applyFormat(template, spec);
    }
    if (typeof template !== 'string') {
      throw makeError('TypeError', "le premier argument de format() doit etre une chaine");
    }
    const method = STRING_METHODS.get('format');
    if (method === undefined) throw makeError('RuntimeError', "la methode 'format' est indisponible");
    return method({ positional: [template, ...args.positional.slice(1)], keyword: args.keyword }, ctx);
  }, ['**kwargs']);

  // -------------------------------------------------------------- types

  add('type', (args) => {
    arityCheck(args, 'type', 1);
    const value = at(args, 0);
    const known = builtinTypeClass(classNameOf(value));
    if (known !== undefined) return known;
    return new UchiClass(typeName(value), []);
  });

  // -------------------------------------------------------------- nombres

  add('abs', (args) => {
    arityCheck(args, 'abs', 1);
    return Math.abs(expectNumber(at(args, 0), 'abs()'));
  });

  add('min', (args, ctx) => {
    arityAtLeast(args, 'min', 1);
    return extremum(args, ctx, 'min');
  });

  add('max', (args, ctx) => {
    arityAtLeast(args, 'max', 1);
    return extremum(args, ctx, 'max');
  });

  add('sum', (args, ctx) => {
    arityCheck(args, 'sum', 1, 2);
    let total = args.positional[1] ?? 0;
    for (const item of ctx.iterate(at(args, 0))) {
      total = expectNumber(total, 'sum()') + expectNumber(item, 'sum()');
    }
    return total;
  });

  add('round', (args) => {
    arityCheck(args, 'round', 1, 2);
    const digits = args.positional[1] === undefined ? 0 : expectInt(args.positional[1], 'round()');
    return roundHalfToEven(expectNumber(at(args, 0), 'round()'), digits);
  });

  add('pow', (args) => {
    arityCheck(args, 'pow', 2, 3);
    const base = expectNumber(at(args, 0), 'pow()');
    const exponent = expectNumber(at(args, 1), 'pow()');
    if (args.positional[2] === undefined) return base ** exponent;
    const modulus = expectNumber(args.positional[2], 'pow()');
    if (modulus === 0) throw makeError('ValueError', 'pow() : le module ne peut pas etre zero');
    return integerModulo(Math.floor(base) ** Math.floor(exponent), modulus);
  });

  add('divmod', (args) => {
    arityCheck(args, 'divmod', 2);
    const a = expectNumber(at(args, 0), 'divmod()');
    const b = expectNumber(at(args, 1), 'divmod()');
    if (b === 0) throw makeError('ZeroDivisionError', 'division par zero');
    const quotient = Math.floor(a / b);
    return new UchiTuple([quotient, a - quotient * b]);
  });

  add('chr', (args) => {
    arityCheck(args, 'chr', 1);
    const code = expectInt(at(args, 0), 'chr()');
    if (code < 0 || code > 0x10ffff) {
      throw makeError('ValueError', `chr() : code invalide ${code}`);
    }
    return String.fromCodePoint(code);
  });

  add('ord', (args) => {
    arityCheck(args, 'ord', 1);
    const text = expectString(at(args, 0), 'ord()');
    if (text.length === 0) throw makeError('TypeError', "ord() attend une chaine non vide");
    return text.codePointAt(0) as number;
  });

  add('hex', (args) => integerBase(args, 16, '0x'));
  add('oct', (args) => integerBase(args, 8, '0o'));
  add('bin', (args) => integerBase(args, 2, '0b'));

  // ------------------------------------------------------------ sequences

  add('range', (args) => {
    arityCheck(args, 'range', 1, 3);
    const numbers = args.positional.map((value) => expectInt(value, 'range()'));
    const [start, stop, step] =
      numbers.length === 1
        ? [0, numbers[0] as number, 1]
        : numbers.length === 2
          ? [numbers[0] as number, numbers[1] as number, 1]
          : [numbers[0] as number, numbers[1] as number, numbers[2] as number];
    if (step === 0) throw makeError('ValueError', "range() : le pas ne peut pas etre zero");
    return new UchiRange(start, stop, step);
  });

  add('enumerate', (args, ctx) => {
    arityCheck(args, 'enumerate', 1, 2);
    const start = args.positional[1] === undefined ? 0 : expectInt(args.positional[1], 'enumerate()');
    return ctx.iterate(at(args, 0)).map((item, index) => new UchiTuple([start + index, item]));
  }, ['start']);

  add('zip', (args, ctx) => {
    const columns = args.positional.map((value) => ctx.iterate(value));
    if (columns.length === 0) return [];
    const shortest = Math.min(...columns.map((column) => column.length));
    const rows: UchiValue[] = [];
    for (let i = 0; i < shortest; i++) {
      rows.push(new UchiTuple(columns.map((column) => column[i] as UchiValue)));
    }
    return rows;
  });

  add('reversed', (args, ctx) => {
    arityCheck(args, 'reversed', 1);
    return ctx.iterate(at(args, 0)).reverse();
  });

  add('sorted', (args, ctx) => {
    arityCheck(args, 'sorted', 1);
    const key = keyFunction(ctx, args.keyword.get('key'));
    const reverse = truthy(args.keyword.get('reverse') ?? false);
    const items = ctx.iterate(at(args, 0));
    items.sort((a, b) => {
      const result = compare(key(a), key(b));
      return reverse ? -result : result;
    });
    return items;
  }, ['key', 'reverse']);

  add('any', (args, ctx) => ctx.iterate(at(args, 0)).some(truthy));
  add('all', (args, ctx) => ctx.iterate(at(args, 0)).every(truthy));

  add('iter', (args, ctx) => {
    arityCheck(args, 'iter', 1);
    return createIterator(ctx.iterate(at(args, 0)));
  });

  add('next', (args) => {
    arityCheck(args, 'next', 1, 2);
    const hasDefault = args.keyword.has('default') || args.positional.length > 1;
    const fallback = args.keyword.has('default')
      ? (args.keyword.get('default') as UchiValue)
      : args.positional[1] as UchiValue;
    return interpreter.nextOf(at(args, 0), hasDefault, fallback);
  }, ['default']);

  // -------------------------------------------------------------- objets

  add('callable', (args) => isCallable(at(args, 0)));

  add('isinstance', (args) => {
    arityCheck(args, 'isinstance', 2);
    return matchesType(at(args, 0), at(args, 1));
  });

  add('issubclass', (args) => {
    arityCheck(args, 'issubclass', 2);
    const child = at(args, 0);
    const parent = at(args, 1);
    if (!(child instanceof UchiClass) || !(parent instanceof UchiClass)) {
      throw makeError('TypeError', "issubclass() attend deux classes");
    }
    return child.isSubclassOf(parent) || child.name === parent.name;
  });

  add('getattr', (args, ctx) => {
    arityCheck(args, 'getattr', 2, 3);
    const target = at(args, 0);
    const name = expectString(at(args, 1), 'getattr()');
    // Avec une valeur par defaut, un attribut absent n'est pas une erreur.
    if (args.positional.length > 2 && !hasAttribute(ctx, target, name)) {
      return args.positional[2] as UchiValue;
    }
    return ctx.getAttribute(target, name);
  });

  add('setattr', (args, ctx) => {
    arityCheck(args, 'setattr', 3);
    ctx.setAttribute(at(args, 0), expectString(at(args, 1), 'setattr()'), at(args, 2));
    return null;
  });

  add('hasattr', (args, ctx) => {
    arityCheck(args, 'hasattr', 2);
    return hasAttribute(ctx, at(args, 0), expectString(at(args, 1), 'hasattr()'));
  });

  add('delattr', (args) => {
    arityCheck(args, 'delattr', 2);
    const target = at(args, 0);
    const name = expectString(at(args, 1), 'delattr()');
    if (!(target instanceof UchiInstance) || !target.has(name)) {
      throw makeError('AttributeError', `l'objet n'a pas d'attribut '${name}'`);
    }
    target.delete(name);
    return null;
  });

  add('dir', (args) => {
    arityCheck(args, 'dir', 0, 1);
    const target = args.positional[0];
    if (target === undefined) return [];
    if (target instanceof UchiInstance) {
      return [...new Set([...target.fieldNames(), ...target.klass.allNames()])].sort();
    }
    if (target instanceof UchiClass) return target.allNames().sort();
    if (target instanceof UchiError) return ['args', 'message', 'name'];
    return memberNamesOf(target);
  });

  builtins.push(['super', native('super', () => interpreter.makeSuper())]);
  builtins.push(['__version__', UCHI_VERSION]);
  builtins.push(...createFileBuiltins());
  for (const [name, klass] of errorClasses) builtins.push([name, klass]);
  return builtins;
}

// ================================================================ attributs

function hasAttribute(ctx: HostContext, target: UchiValue, name: string): boolean {
  try {
    ctx.getAttribute(target, name);
    return true;
  } catch {
    return false;
  }
}

/** Noms disponibles sur une valeur : attributs de classe, champs, ou methodes natives. */
function memberNamesOf(value: UchiValue): string[] {
  if (value instanceof UchiModule) return value.names().sort();
  const table = tableFor(value);
  return table === null ? [] : [...table.keys()].sort();
}

function tableFor(value: UchiValue): MethodTable | null {
  if (typeof value === 'string') return STRING_METHODS;
  if (isList(value)) return LIST_METHODS;
  if (value instanceof UchiDict) return DICT_METHODS;
  if (value instanceof UchiSet) return SET_METHODS;
  if (value instanceof UchiTuple) return TUPLE_METHODS;
  if (value instanceof UchiRange) return RANGE_METHODS;
  return null;
}

// ================================================================ conversions

function toInteger(value: UchiValue, base: number): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw makeError('ValueError', 'int() ne peut pas convertir un nombre infini ou ind defini');
    }
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') {
      throw makeError('ValueError', "int() : la chaine est vide");
    }
    const radix = base === 0 ? detectRadix(text) : base;
    const body = radix === 16 && /^[+-]?0[xX]/.test(text) ? text.replace(/^([+-]?)0[xX]/, '$1') : text;
    const parsed = Number.parseInt(body, radix);
    if (Number.isNaN(parsed) || !isIntegerText(body, radix)) {
      throw makeError(
        'ValueError',
        `int() : la chaine '${value}' n'est pas un entier valide en base ${radix}`,
      );
    }
    return parsed;
  }
  throw makeError('TypeError', `int() ne peut pas convertir '${typeName(value)}'`);
}

function detectRadix(text: string): number {
  const sign = /^[+-]?/.exec(text)?.[0] ?? '';
  const body = text.slice(sign.length);
  if (/^0[xX]/.test(body)) return 16;
  if (/^0[bB]/.test(body)) return 2;
  if (/^0[oO]/.test(body)) return 8;
  return 10;
}

function isIntegerText(text: string, radix: number): boolean {
  const sign = /^[+-]?/.exec(text)?.[0] ?? '';
  const body = text.slice(sign.length).replace(/^0[xXbBoO]/, '');
  const pattern = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 10 ? /^[0-9]+$/ : radix === 8 ? /^[0-7]+$/ : /^[01]+$/;
  return pattern.test(body);
}

function toFloat(value: UchiValue): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isNaN(parsed) && value.trim() !== 'nan') {
      throw makeError('ValueError', `float() : la chaine '${value}' n'est pas un nombre valide`);
    }
    return parsed;
  }
  throw makeError('TypeError', `float() ne peut pas convertir '${typeName(value)}'`);
}

/** Arrondi au plus proche, en privilegiant l'entier pair (comme Python). */
function roundHalfToEven(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const difference = scaled - floor;
  let rounded: number;
  if (difference > 0.5) rounded = floor + 1;
  else if (difference < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  const result = rounded / factor;
  // `-0.0` est.remplace par `0` pour eviter une affichage etrange.
  return result === 0 ? 0 : result;
}

function integerModulo(value: number, modulus: number): number {
  const result = value % Math.abs(modulus);
  return result < 0 ? result + Math.abs(modulus) : result;
}

function integerBase(args: NativeCallArgs, radix: number, prefix: string): string {
  arityCheck(args, 'toBase', 1);
  const value = expectInt(at(args, 0), 'conversion de base');
  const negative = value < 0;
  const digits = Math.abs(value).toString(radix);
  return `${negative ? '-' : ''}${prefix}${digits}`;
}

function extremum(args: NativeCallArgs, ctx: HostContext, kind: 'min' | 'max'): UchiValue {
  const key = keyFunction(ctx, args.keyword.get('key'));
  // `min(1, 2)` compare des arguments ; `min([1, 2])` compare un iterable.
  const items = args.positional.length === 1 ? ctx.iterate(args.positional[0] as UchiValue) : args.positional;
  if (items.length === 0) {
    // `default` ne sert que sur une sequence vide, comme en Python.
    const fallback = args.keyword.get('default');
    if (fallback !== undefined) return fallback;
    throw makeError('ValueError', `${kind}() sur une sequence vide`);
  }
  let best = items[0] as UchiValue;
  for (const item of items.slice(1)) {
    const order = compare(key(item), key(best));
    if (kind === 'min' ? order < 0 : order > 0) best = item;
  }
  return best;
}

function matchesType(value: UchiValue, expected: UchiValue): boolean {
  if (expected instanceof UchiClass) {
    if (value instanceof UchiInstance) return value.klass.isSubclassOf(expected);
    if (value instanceof UchiError) {
      return value.klass !== null
        ? value.klass.isSubclassOf(expected)
        : value.name === expected.name;
    }
    if (value instanceof UchiClass) return value.isSubclassOf(expected) || value.name === expected.name;
    if (expected.name === 'object') return true;
    // Tour numerique de CPython : `bool` < `int` < `float` pour `isinstance`.
    if (expected.name === 'float') return typeof value === 'number' || typeof value === 'boolean';
    if (expected.name === 'int') {
      return (
        typeof value === 'boolean' || (typeof value === 'number' && Number.isInteger(value))
      );
    }
    if (expected.name === 'bool') return typeof value === 'boolean';
    return classNameOf(value) === expected.name;
  }
  if (isList(expected)) {
    return expected.some((candidate) => matchesType(value, candidate));
  }
  if (expected instanceof UchiTuple) {
    return expected.items.some((candidate) => matchesType(value, candidate));
  }
  if (typeof expected === 'string') {
    if (expected === 'int') return typeof value === 'number' && Number.isInteger(value);
    if (expected === 'float') return typeof value === 'number';
    return typeName(value) === expected;
  }
  throw makeError('TypeError', 'isinstance() attend une classe ou un tuple de classes');
}

// ================================================================ iterateurs

interface IteratorState {
  items: UchiValue[];
  cursor: number;
  next(ctx: HostContext): UchiValue;
}

/**
 * Iterateur minimal. L'objet est une instance d'une classe native : son etat
 * vit dans `payload`, invisible depuis le code Uchi.
 */
export function createIterator(items: UchiValue[]): UchiInstance {
  const klass = new UchiClass('iterator', []);
  const instance = new UchiInstance(klass);
  const state: IteratorState = {
    items,
    cursor: 0,
    next(ctx) {
      if (state.cursor >= state.items.length) {
        throw makeError('StopIteration', '');
      }
      return state.items[state.cursor++] as UchiValue;
    },
  };
  instance.payload = state;
  klass.set('__iter__', new UchiNativeFunction('__iter__', () => instance));
  klass.set('__next__', new UchiNativeFunction('__next__', (_args, ctx) => state.next(ctx)));
  klass.set('__length_hint__', new UchiNativeFunction('__length_hint__', () => state.items.length - state.cursor));
  klass.set('__repr__', new UchiNativeFunction('__repr__', () => `<iterator position ${state.cursor}>`));
  return instance;
}
