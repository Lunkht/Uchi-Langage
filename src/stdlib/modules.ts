/**
 * Modules integres.
 *
 * Chaque module est une fabrique renvoyant un `UchiModule`. Ils sont produits
 * a la demande puis memorises par le chargeur.
 *
 * Aucun de ces modules n'exige de type que le `HostContext` : ils ne creent pas
 * de dependance circulaire avec l'interpreteur.
 */

import type { HostContext, NativeCallArgs } from '../interpreter/context.ts';
import { arityCheck, expectInt, expectNumber, expectString } from '../interpreter/context.ts';
import { makeError } from '../interpreter/error-registry.ts';
import { truthy, typeName } from '../interpreter/operations.ts';
import { UchiModule, UchiNativeFunction, type UchiValue } from '../interpreter/values.ts';
import { UCHI_VERSION } from './version.ts';
import { jsonModule } from './json.ts';
import { reModule } from './regexp.ts';
import type { Interpreter } from '../interpreter/interpreter.ts';
import type { ModuleFactory } from '../interpreter/module-loader.ts';

type Body = (args: NativeCallArgs, ctx: HostContext) => UchiValue;

function mathFunction(name: string, body: (value: number) => number): UchiNativeFunction {
  return new UchiNativeFunction(name, (args) => {
    arityCheck(args, name, 1);
    return body(expectNumber(args.positional[0] as UchiValue, `${name}()`));
  });
}

function unaryCheck(name: string, body: (value: number) => boolean): UchiNativeFunction {
  return new UchiNativeFunction(name, (args) => {
    arityCheck(args, name, 1);
    return body(expectNumber(args.positional[0] as UchiValue, `${name}()`));
  });
}

/** PGCD de deux entiers positifs, par l'algorithme d'Euclide. */
function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

// ======================================================================= math

const mathModule: ModuleFactory = () => {
  const module = new UchiModule('math');
  const constants: Array<[string, number]> = [
    ['pi', Math.PI],
    ['e', Math.E],
    ['tau', Math.PI * 2],
    ['inf', Number.POSITIVE_INFINITY],
    ['nan', Number.NaN],
  ];
  for (const [name, value] of constants) module.set(name, value);

  const functions: Array<[string, UchiNativeFunction]> = [
    ['sqrt', mathFunction('sqrt', Math.sqrt)],
    ['floor', mathFunction('floor', Math.floor)],
    ['ceil', mathFunction('ceil', Math.ceil)],
    ['trunc', mathFunction('trunc', Math.trunc)],
    ['fabs', mathFunction('fabs', Math.abs)],
    ['exp', mathFunction('exp', Math.exp)],
    ['expm1', mathFunction('expm1', Math.expm1)],
    ['log1p', mathFunction('log1p', Math.log1p)],
    ['sin', mathFunction('sin', Math.sin)],
    ['cos', mathFunction('cos', Math.cos)],
    ['tan', mathFunction('tan', Math.tan)],
    ['asin', mathFunction('asin', Math.asin)],
    ['acos', mathFunction('acos', Math.acos)],
    ['atan', mathFunction('atan', Math.atan)],
    ['sinh', mathFunction('sinh', Math.sinh)],
    ['cosh', mathFunction('cosh', Math.cosh)],
    ['tanh', mathFunction('tanh', Math.tanh)],
    ['degrees', mathFunction('degrees', (value) => (value * 180) / Math.PI)],
    ['radians', mathFunction('radians', (value) => (value * Math.PI) / 180)],
    ['isnan', unaryCheck('isnan', Number.isNaN)],
    ['isinf', unaryCheck('isinf', (value) => !Number.isFinite(value) && !Number.isNaN(value))],
    ['isfinite', unaryCheck('isfinite', Number.isFinite)],
  ];
  for (const [name, fn] of functions) module.set(name, fn);

  module.set('log', new UchiNativeFunction('log', (args) => {
    arityCheck(args, 'log', 1, 2);
    const value = expectNumber(args.positional[0] as UchiValue, 'log()');
    if (value <= 0) throw makeError('ValueError', 'log() : le nombre doit etre strictement positif');
    if (args.positional.length === 2) {
      const base = expectNumber(args.positional[1] as UchiValue, 'log()');
      if (base <= 0 || base === 1) {
        throw makeError('ValueError', 'log() : la base doit etre positive et differente de 1');
      }
      return Math.log(value) / Math.log(base);
    }
    return Math.log(value);
  }));

  module.set('log2', mathFunction('log2', Math.log2));
  module.set('log10', mathFunction('log10', Math.log10));
  module.set('pow', new UchiNativeFunction('pow', (args) => {
    arityCheck(args, 'pow', 2);
    return expectNumber(args.positional[0] as UchiValue, 'pow()') ** expectNumber(args.positional[1] as UchiValue, 'pow()');
  }));

  module.set('fmod', new UchiNativeFunction('fmod', (args) => {
    arityCheck(args, 'fmod', 2);
    const divisor = expectNumber(args.positional[1] as UchiValue, 'fmod()');
    if (divisor === 0) throw makeError('ZeroDivisionError', 'fmod() : division par zero');
    return expectNumber(args.positional[0] as UchiValue, 'fmod()') % divisor;
  }));

  module.set('atan2', new UchiNativeFunction('atan2', (args) => {
    arityCheck(args, 'atan2', 2);
    return Math.atan2(
      expectNumber(args.positional[0] as UchiValue, 'atan2()'),
      expectNumber(args.positional[1] as UchiValue, 'atan2()'),
    );
  }));

  module.set('hypot', new UchiNativeFunction('hypot', (args) => {
    const values = args.positional.map((value) => expectNumber(value, 'hypot()'));
    return Math.hypot(...values);
  }));

  module.set('gcd', new UchiNativeFunction('gcd', (args) => {
    const values = args.positional.map((value) => expectInt(value, 'gcd()'));
    return values.reduce((result, value) => greatestCommonDivisor(result, Math.abs(value)), 0);
  }));

  module.set('lcm', new UchiNativeFunction('lcm', (args) => {
    const values = args.positional.map((value) => expectInt(value, 'lcm()'));
    if (values.length === 0) return 1;
    if (values.some((value) => value === 0)) return 0;
    let result = Math.abs(values[0] as number);
    for (const value of values.slice(1)) {
      const other = Math.abs(value);
      result = Math.abs((result / greatestCommonDivisor(result, other)) * other);
    }
    return result;
  }));

  module.set('isqrt', new UchiNativeFunction('isqrt', (args) => {
    arityCheck(args, 'isqrt', 1);
    const n = expectInt(args.positional[0] as UchiValue, 'isqrt()');
    if (n < 0) throw makeError('ValueError', 'isqrt() : l\'argument doit etre positif ou nul');
    return Math.floor(Math.sqrt(n));
  }));

  module.set('dist', new UchiNativeFunction('dist', (args) => {
    arityCheck(args, 'dist', 2);
    const a = args.positional[0];
    const b = args.positional[1];
    if (!Array.isArray(a) || !Array.isArray(b)) {
      throw makeError('TypeError', 'dist() attend deux listes de nombres');
    }
    if (a.length !== b.length) {
      throw makeError('ValueError', 'dist() : les deux sequences doivent avoir la meme longueur');
    }
    let total = 0;
    for (let i = 0; i < a.length; i++) {
      const delta = expectNumber(a[i] as UchiValue, 'dist()') - expectNumber(b[i] as UchiValue, 'dist()');
      total += delta * delta;
    }
    return Math.sqrt(total);
  }));

  module.set('prod', new UchiNativeFunction('prod', (args) => {
    const values = args.positional.map((value) => expectNumber(value, 'prod()'));
    let result = 1;
    for (const value of values) result *= value;
    return result;
  }));

  module.set('copysign', new UchiNativeFunction('copysign', (args) => {
    arityCheck(args, 'copysign', 2);
    const magnitude = Math.abs(expectNumber(args.positional[0] as UchiValue, 'copysign()'));
    const sign = expectNumber(args.positional[1] as UchiValue, 'copysign()');
    return sign < 0 || Object.is(sign, -0) ? -magnitude : magnitude;
  }));

  module.set('fmod', new UchiNativeFunction('fmod', (args) => {
    arityCheck(args, 'fmod', 2);
    return (
      expectNumber(args.positional[0] as UchiValue, 'fmod()')
      % expectNumber(args.positional[1] as UchiValue, 'fmod()')
    );
  }));

  module.set('log2', mathFunction('log2', Math.log2));

  module.set('factorial', new UchiNativeFunction('factorial', (args) => {
    arityCheck(args, 'factorial', 1);
    const n = expectInt(args.positional[0] as UchiValue, 'factorial()');
    if (n < 0) throw makeError('ValueError', 'factorial() : l\'argument doit etre positif');
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
  }));

  module.set('comb', new UchiNativeFunction('comb', (args) => {
    arityCheck(args, 'comb', 2);
    const n = expectInt(args.positional[0] as UchiValue, 'comb()');
    const k = expectInt(args.positional[1] as UchiValue, 'comb()');
    if (k < 0 || k > n) return 0;
    let result = 1;
    for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
    return Math.round(result);
  }));

  module.set('perm', new UchiNativeFunction('perm', (args) => {
    arityCheck(args, 'perm', 1, 2);
    const n = expectInt(args.positional[0] as UchiValue, 'perm()');
    const k = args.positional[1] === undefined ? n : expectInt(args.positional[1], 'perm()');
    if (k < 0 || k > n) return 0;
    let result = 1;
    for (let i = 0; i < k; i++) result *= n - i;
    return result;
  }));

  return module;
};

// ==================================================================== string

/**
 * Les fonctions de `string` deleguent aux methodes natives des chaines : le
 * comportement est donc identique a `"texte".upper()`.
 */
const STRING_DELEGATES: Record<string, string> = {
  upper: 'upper',
  lower: 'lower',
  title: 'title',
  capitalize: 'capitalize',
  swapcase: 'swapcase',
  strip: 'strip',
  lstrip: 'lstrip',
  rstrip: 'rstrip',
  split: 'split',
  rsplit: 'rsplit',
  splitlines: 'splitlines',
  replace: 'replace',
  find: 'find',
  rfind: 'rfind',
  index: 'index',
  startswith: 'startswith',
  endswith: 'endswith',
  count: 'count',
  isdigit: 'isdigit',
  isalpha: 'isalpha',
  isalnum: 'isalnum',
  isspace: 'isspace',
  isupper: 'isupper',
  islower: 'islower',
  partition: 'partition',
  center: 'center',
  ljust: 'ljust',
  rjust: 'rjust',
  zfill: 'zfill',
};

const stringModule: ModuleFactory = () => {
  const module = new UchiModule('string');
  const digits = '0123456789';
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  const whitespace = ' \t\n\r\v\f';
  const constants: Array<[string, string]> = [
    ['ascii_lowercase', 'abcdefghijklmnopqrstuvwxyz'],
    ['ascii_uppercase', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['ascii_letters', letters],
    ['digits', digits],
    ['hex_digits', `${digits}abcdefABCDEF`],
    ['oct_digits', '01234567'],
    ['punctuation', punctuation],
    ['whitespace', whitespace],
    // Noms de Python 3, absents de la liste ci-dessus.
    ['hexdigits', `${digits}abcdefABCDEF`],
    ['octdigits', '01234567'],
    ['printable', `${digits}${letters}${punctuation}${whitespace}`],
  ];
  for (const [name, value] of constants) module.set(name, value);

  for (const [name, method] of Object.entries(STRING_DELEGATES)) {
    module.set(
      name,
      new UchiNativeFunction(
        name,
        (args, ctx) => {
          arityCheck(args, name, 1, 4);
          const target = args.positional[0] as UchiValue;
          // Le premier argument est la chaine ; les suivants, comme les
          // arguments nommes, sont transmis tels quels a la methode native.
          return ctx.callValue(
            ctx.getAttribute(target, method),
            args.positional.slice(1),
            args.keyword,
          );
        },
        1,
      ),
    );
  }

  // `string.join` n'est pas une methode de chaine : comme `_string.join`, il
  // prend le separateur en premier et l'iterable en second.
  module.set(
    'join',
    new UchiNativeFunction(
      'join',
      (args, ctx) => {
        arityCheck(args, 'join', 2, 2);
        const separator = expectString(args.positional[0] as UchiValue, 'join');
        const words = args.positional[1] as UchiValue;
        return ctx.callValue(ctx.getAttribute(separator, 'join'), [words]);
      },
      2,
    ),
  );

  module.set('capwords', new UchiNativeFunction('capwords', (args, ctx) => {
    arityCheck(args, 'capwords', 1, 2);
    const separator = args.positional[1] === undefined ? ' ' : expectString(args.positional[1], 'capwords()');
    const words = ctx.iterate(ctx.callValue(ctx.getAttribute(args.positional[0] as UchiValue, 'split'), [separator]));
    return words
      .map((word) => ctx.callValue(ctx.getAttribute(word, 'capitalize'), []))
      .join(separator);
  }));
  return module;
};

// ======================================================================== sys

const sysModule: ModuleFactory = (interpreter) => {
  const module = new UchiModule('sys');
  module.set('argv', interpreter.argv);
  module.set('version', `Uchi ${UCHI_VERSION} (Node ${process.versions.node})`);
  module.set('platform', process.platform);
  module.set('maxsize', Number.MAX_SAFE_INTEGER);
  module.set('path', [...nodePath().split(';')]);
  module.set('exit', new UchiNativeFunction('exit', (args) => {
    const code = args.positional[0];
    const status = code === undefined ? 0 : typeof code === 'number' ? code : truthy(code) ? 0 : 1;
    // L'exception est interceptee par la CLI, qui en tire le code de sortie.
    throw makeError('SystemExit', `code ${status}`, { args: [status] });
  }));
  return module;
};

function nodePath(): string {
  return process.env.PATH ?? '';
}

// ===================================================================== random

const randomModule: ModuleFactory = () => {
  const module = new UchiModule('random');

  const seed = (value: number): void => {
    // Generateur lineaire congruentiel : reproductible d'une execution a l'autre.
    state = (Math.trunc(value) >>> 0) || 0x2545f491;
  };
  let state = 0x2545f491;

  const nextRandom = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  module.set('seed', new UchiNativeFunction('seed', (args) => {
    arityCheck(args, 'seed', 0, 1);
    if (args.positional[0] === undefined) seed(Date.now() % 100000);
    else seed(expectNumber(args.positional[0], 'seed()'));
    return null;
  }));

  module.set('random', new UchiNativeFunction('random', () => nextRandom()));

  module.set('uniform', new UchiNativeFunction('uniform', (args) => {
    arityCheck(args, 'uniform', 2);
    const low = expectNumber(args.positional[0] as UchiValue, 'uniform()');
    const high = expectNumber(args.positional[1] as UchiValue, 'uniform()');
    return low + nextRandom() * (high - low);
  }));

  module.set('randint', new UchiNativeFunction('randint', (args) => {
    arityCheck(args, 'randint', 2);
    const low = expectInt(args.positional[0] as UchiValue, 'randint()');
    const high = expectInt(args.positional[1] as UchiValue, 'randint()');
    if (low > high) throw makeError('ValueError', 'randint() : la borne inferieure depasse la superieure');
    return low + Math.floor(nextRandom() * (high - low + 1));
  }));

  module.set('choice', new UchiNativeFunction('choice', (args, ctx) => {
    arityCheck(args, 'choice', 1);
    const items = ctx.iterate(args.positional[0] as UchiValue);
    if (items.length === 0) throw makeError('IndexError', "choice() sur une sequence vide");
    return items[Math.floor(nextRandom() * items.length)] as UchiValue;
  }));

  module.set('choices', new UchiNativeFunction('choices', (args, ctx) => {
    arityCheck(args, 'choices', 2, 3);
    const items = ctx.iterate(args.positional[0] as UchiValue);
    if (items.length === 0) throw makeError('IndexError', 'choices() sur une sequence vide');
    const count = expectInt(args.positional[1] as UchiValue, 'choices()');
    return Array.from({ length: count }, () => items[Math.floor(nextRandom() * items.length)] as UchiValue);
  }));

  module.set('sample', new UchiNativeFunction('sample', (args, ctx) => {
    arityCheck(args, 'sample', 2);
    const items = ctx.iterate(args.positional[0] as UchiValue);
    const count = expectInt(args.positional[1] as UchiValue, 'sample()');
    if (count > items.length) {
      throw makeError('ValueError', "sample() : plus d'elements demandes que disponibles");
    }
    // Melange de Fisher-Yates sur une copie.
    const pool = items.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      [pool[i], pool[j]] = [pool[j] as UchiValue, pool[i] as UchiValue];
    }
    return pool.slice(0, count);
  }));

  module.set('shuffle', new UchiNativeFunction('shuffle', (args) => {
    arityCheck(args, 'shuffle', 1);
    const items = args.positional[0] as UchiValue;
    if (!Array.isArray(items)) {
      throw makeError('TypeError', `shuffle() attend une liste, recu '${typeName(items)}'`);
    }
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      [items[i], items[j]] = [items[j] as UchiValue, items[i] as UchiValue];
    }
    return null;
  }));

  return module;
};

// ======================================================================= time

const timeModule: ModuleFactory = () => {
  const module = new UchiModule('time');
  module.set('time', new UchiNativeFunction('time', () => Date.now() / 1000));
  module.set('monotonic', new UchiNativeFunction('monotonic', () => Number(process.hrtime.bigint()) / 1e9));
  module.set('perf_counter', new UchiNativeFunction('perf_counter', () => Number(process.hrtime.bigint()) / 1e9));
  module.set('sleep', new UchiNativeFunction('sleep', (args) => {
    arityCheck(args, 'sleep', 1);
    const seconds = expectNumber(args.positional[0] as UchiValue, 'sleep()');
    if (seconds < 0) throw makeError('ValueError', 'sleep() : la duree doit etre positive');
    // Attente synchrone courte : l'interpreteur est mono-thread.
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      /* attente breve */
    }
    return null;
  }));
  return module;
};

// ============================================================== construction

export function createBuiltinModules(): Map<string, ModuleFactory> {
  return new Map<string, ModuleFactory>([
    ['math', mathModule],
    ['string', stringModule],
    ['sys', sysModule],
    ['random', randomModule],
    ['time', timeModule],
    ['re', reModule],
    ['json', jsonModule],
  ]);
}
