/**
 * Contrat entre l'interpreteur et les fonctions natives.
 *
 * Les fonctions natives (builtin et methodes) ne dependent que de cette
 * interface, ce qui evite tout cycle d'import avec `interpreter.ts`.
 */

import { makeError } from './error-registry.ts';
import type { UchiClass, UchiValue } from './values.ts';

export interface NativeCallArgs {
  positional: UchiValue[];
  keyword: Map<string, UchiValue>;
}

export interface HostContext {
  /** Appelle n'importe quelle valeur appelable. */
  callValue(callee: UchiValue, positional?: UchiValue[], keyword?: Map<string, UchiValue>): UchiValue;
  /** Levee une exception Uchi. */
  throwError(name: string, message: string): never;
  /** `str()` d'une valeur, en tenant compte de `__str__`. */
  toDisplayString(value: UchiValue): string;
  /** `repr()` d'une valeur, en tenant compte de `__repr__`. */
  toInspectString(value: UchiValue): string;
  /** Iterer une valeur, en tenant compte de `__iter__`. */
  iterate(value: UchiValue): UchiValue[];
  /** Longueur d'une valeur, en tenant compte de `__len__`. */
  lengthOf(value: UchiValue): number;
  /** Indexation, en tenant compte de `__getitem__`. */
  getItemOf(value: UchiValue, index: UchiValue): UchiValue;
  /** Lecture d'attribut arbitraire, y compris sur les types integres. */
  getAttribute(target: UchiValue, name: string): UchiValue;
  /** Ecriture d'attribut. */
  setAttribute(target: UchiValue, name: string, value: UchiValue): void;
  /** Instancie une classe : `Classe(...)`. */
  instantiate(klass: UchiClass, args: NativeCallArgs): UchiValue;
}

export type NativeFunctionBody = (args: NativeCallArgs, ctx: HostContext) => UchiValue;

// ====================================================== aides pour le natif

export function arityCheck(args: NativeCallArgs, name: string, min: number, max = min): void {
  const count = args.positional.length;
  if (count >= min && count <= max) return;
  const expected = min === max ? String(min) : min === 0 ? `0 a ${max}` : `${min} a ${max}`;
  throw makeError(
    'TypeError',
    count < min
      ? `il manque ${min - count} argument(s) : ${name} attend ${expected}`
      : `${name} attend ${expected} argument(s), ${count} recu(s)`,
  );
}

/** Borne minimale seule : le nombre d'arguments reste libre (`str.format`). */
export function arityAtLeast(args: NativeCallArgs, name: string, min: number): void {
  const count = args.positional.length;
  if (count >= min) return;
  throw makeError(
    'TypeError',
    `il manque ${min - count} argument(s) : ${name} attend au moins ${min}`,
  );
}

export function arg(args: NativeCallArgs, index: number): UchiValue {
  return args.positional[index] as UchiValue;
}

export function kwarg(args: NativeCallArgs, name: string, fallback: UchiValue): UchiValue {
  return args.keyword.get(name) ?? fallback;
}

export function checkNoExtraKeyword(
  args: NativeCallArgs,
  name: string,
  allowed: readonly string[],
): void {
  for (const key of args.keyword.keys()) {
    if (!allowed.includes(key)) {
      throw makeError('TypeError', `${name}() ne accepte pas l'argument nomme '${key}'`);
    }
  }
}

export function expectString(value: UchiValue, who: string): string {
  if (typeof value !== 'string') {
    throw makeError('TypeError', `${who} attend une chaine, recu ${typeOfLabel(value)}`);
  }
  return value;
}

export function expectInt(value: UchiValue, who: string): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw makeError('TypeError', `${who} attend un entier, recu ${typeOfLabel(value)}`);
  }
  return value;
}

export function expectNumber(value: UchiValue, who: string): number {
  // `bool` est un sous-type d'`int` : `sum([True, True])` vaut 2.
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number') {
    throw makeError('TypeError', `${who} attend un nombre, recu ${typeOfLabel(value)}`);
  }
  return value;
}

function typeOfLabel(value: UchiValue): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'objet';
}
