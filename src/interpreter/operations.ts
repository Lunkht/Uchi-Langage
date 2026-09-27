/**
 * Operations sur les valeurs Uchi : typage, verite, conversions, arithmetique,
 * comparaisons, indexation, tranches, iteration.
 *
 * Ce module ne contient que des fonctions pures : il ne cree pas de classe
 * Uchi et n'appelle pas de fonction utilisateur. C'est `interpreter.ts` qui
 * orchestre, et `native-methods.ts` qui fournit les methodes natives.
 */

import { makeError } from './error-registry.ts';
import {
  UchiClass,
  UchiDict,
  UchiError,
  UchiFunction,
  UchiInstance,
  UchiModule,
  UchiNativeFunction,
  UchiRange,
  UchiSet,
  UchiTuple,
  isList,
  type UchiList,
  type UchiValue,
} from './values.ts';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// ==================================================================== typage

export function typeName(value: UchiValue): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (isList(value)) return 'list';
  if (value instanceof UchiTuple) return 'tuple';
  if (value instanceof UchiDict) return 'dict';
  if (value instanceof UchiSet) return 'set';
  if (value instanceof UchiRange) return 'range';
  if (value instanceof UchiFunction || value instanceof UchiNativeFunction) return 'function';
  if (value instanceof UchiClass) return 'type';
  if (value instanceof UchiInstance) return value.klass.name;
  if (value instanceof UchiModule) return 'module';
  if (value instanceof UchiError) return 'exception';
  return 'inconnu';
}

export function isNumber(value: UchiValue): value is number {
  return typeof value === 'number';
}

export function isInteger(value: UchiValue): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Un `bool` est un sous-type d'`int` : comme en Python, il se comporte
 * partout comme 0 ou 1 pour l'arithmetique et les comparaisons.
 */
function asNumeric(value: UchiValue): UchiValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function isNumeric(value: UchiValue): boolean {
  return typeof value === 'number' || typeof value === 'boolean';
}

function requireNumber(op: string, value: UchiValue): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number') {
    throw makeError('TypeError', `l'operateur '${op}' ne fonctionne pas sur '${typeName(value)}'`);
  }
  return value;
}

function requireInteger(op: string, value: UchiValue): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw makeError('TypeError', `l'operateur '${op}' attend un entier, recu '${typeName(value)}'`);
  }
  return value;
}

function describe(value: UchiValue): string {
  return `'${typeName(value)}'`;
}

// ==================================================================== verite

export function truthy(value: UchiValue): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (isList(value)) return value.length > 0;
  if (value instanceof UchiTuple) return value.items.length > 0;
  if (value instanceof UchiDict) return value.size > 0;
  if (value instanceof UchiSet) return value.size > 0;
  if (value instanceof UchiRange) return value.length > 0;
  return true;
}

// =============================================================== conversions

/**
 * Permet a l'interpreteur de fournir la representation d'un objet
 * personnalise (`__str__` / `__repr__`) sans creer de cycle d'import.
 */
let customRepr: ((value: UchiValue) => string | null) | null = null;

export function setCustomRepr(hook: (value: UchiValue) => string | null): void {
  customRepr = hook;
}

// ===================================================== surcharge d'operateurs

/**
 * Surcharges fournies par les classes ecrites en Uchi (`__add__`, `__eq__`, ...).
 *
 * Chaque fonction renvoie `undefined` lorsque la classe ne definit pas le
 * crochet demande : l'operation standard s'applique alors. Ces points d'accroche
 * evitent a `operations.ts` de connaitre les classes definies en Uchi, donc
 * d'importer l'interpreteur.
 */
export type OperatorOverride = {
  binary: (op: string, left: UchiValue, right: UchiValue) => UchiValue | undefined;
  compare: (op: string, left: UchiValue, right: UchiValue) => Ordering | undefined;
  equals: (left: UchiValue, right: UchiValue) => boolean | undefined;
};

let overrides: OperatorOverride | null = null;

export function setOperatorOverride(hook: OperatorOverride): void {
  overrides = hook;
}

export function toStr(value: UchiValue): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return numberToString(value);
  if (isList(value)) return `[${value.map(toRepr).join(', ')}]`;
  if (value instanceof UchiTuple) return `(${value.items.map(toRepr).join(', ')})`;
  if (value instanceof UchiDict) {
    const parts: string[] = [];
    for (const [k, v] of value.entriesIterator()) parts.push(`${toRepr(k)}: ${toRepr(v)}`);
    return `{${parts.join(', ')}}`;
  }
  if (value instanceof UchiSet) {
    if (value.size === 0) return 'set()';
    return `{${[...value.values()].map(toRepr).join(', ')}}`;
  }
  if (value instanceof UchiRange) {
    return rangeToString(value);
  }
  if (value instanceof UchiFunction) return `<fonction ${value.name}>`;
  if (value instanceof UchiNativeFunction) return `<fonction native ${value.name}>`;
  if (value instanceof UchiClass) return `<classe ${value.name}>`;
  if (value instanceof UchiInstance) {
    const custom = customRepr?.(value) ?? null;
    if (custom !== null) return custom;
    const fields = value.fieldNames().map((n) => `${n}=${toRepr(value.get(n) as UchiValue)}`);
    return `<${value.klass.name} objet${fields.length > 0 ? ` ${fields.join(' ')}` : ''}>`;
  }
  if (value instanceof UchiModule) return `<module '${value.name}'>`;
  if (value instanceof UchiError) return errorMessage(value);
  return String(value);
}

export function toRepr(value: UchiValue): string {
  if (typeof value === 'string') return quoteString(value);
  // Comme en Python, `str(e)` ne montre que le message et `repr(e)` ajoute le
  // nom de l'exception : les deux sont utiles dans un trace.
  if (value instanceof UchiError) {
    return value.message === '' ? value.name : `${value.name}(${quoteString(value.message)})`;
  }
  return toStr(value);
}

export function numberToString(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) <= MAX_SAFE) return String(value);
  if (Number.isNaN(value)) return 'nan';
  if (value === Number.POSITIVE_INFINITY) return 'inf';
  if (value === Number.NEGATIVE_INFINITY) return '-inf';
  return String(value);
}

function rangeToString(value: UchiRange): string {
  if (value.step === 1) return `range(${value.start}, ${value.stop})`;
  return `range(${value.start}, ${value.stop}, ${value.step})`;
}

export function quoteString(value: string): string {
  const hasSingle = value.includes("'");
  const hasDouble = value.includes('"');
  let quote = "'";
  if (hasSingle && !hasDouble) quote = '"';
  const body = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r');
  const escaped = quote === "'" ? body.replace(/'/g, "\\'") : body.replace(/"/g, '\\"');
  return `${quote}${escaped}${quote}`;
}

/** `str(e)` : le message seul, comme en Python. */
export function errorMessage(error: UchiError): string {
  if (error.cause !== null) {
    return `${error.message} (pendant le traitement de ${toRepr(error.cause)})`;
  }
  return error.message;
}

/** `Nom: message`, forme utilisee pour annoncer une exception non rattrapee. */
export function errorToString(error: UchiError): string {
  const head = error.message === '' ? error.name : `${error.name}: ${error.message}`;
  if (error.cause !== null) {
    return `${head} (pendant le traitement de ${toRepr(error.cause)})`;
  }
  return head;
}

// ================================================================= egalite

export function equals(a: UchiValue, b: UchiValue): boolean {
  if (a === b) return true;
  const custom = overrides?.equals(a, b);
  if (custom !== undefined) return custom;
  if (a === null || b === null) return false;

  if (isNumeric(a) && isNumeric(b)) return asNumeric(a) === asNumeric(b);
  if (typeof a === 'string' && typeof b === 'string') return a === b;

  if (isList(a) && isList(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => equals(item, b[i] as UchiValue));
  }
  if (a instanceof UchiTuple && b instanceof UchiTuple) {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((item, i) => equals(item, b.items[i] as UchiValue));
  }
  if (a instanceof UchiDict && b instanceof UchiDict) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.entriesIterator()) {
      if (!b.has(k)) return false;
      const other = b.get(k);
      if (other === undefined || !equals(v, other)) return false;
    }
    return true;
  }
  if (a instanceof UchiSet && b instanceof UchiSet) {
    if (a.size !== b.size) return false;
    for (const v of a.values()) if (!b.has(v)) return false;
    return true;
  }
  if (a instanceof UchiRange && b instanceof UchiRange) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a.at(i) !== b.at(i)) return false;
    return true;
  }
  if (a instanceof UchiError && b instanceof UchiError) {
    return a.name === b.name && a.message === b.message;
  }
  return false;
}

// ============================================================ comparaison

export type Ordering = -1 | 0 | 1;

/** Compare deux valeurs ordonnables. Leve `TypeError` si incomparable. */
export function compare(a: UchiValue, b: UchiValue): Ordering {
  const custom = overrides?.compare('<', a, b);
  if (custom !== undefined) return custom;
  if (isNumeric(a) && isNumeric(b)) return order(asNumeric(a) as number, asNumeric(b) as number);
  if (typeof a === 'string' && typeof b === 'string') return order(a, b);
  if (isList(a) && isList(b)) return compareSequences(a, b);
  if (a instanceof UchiTuple && b instanceof UchiTuple) return compareSequences(a.items, b.items);
  throw makeError(
    'TypeError',
    `les operateurs de comparaison ne sont pas definis entre '${typeName(a)}' et '${typeName(b)}'`,
  );
}

function order<T>(a: T, b: T): Ordering {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareSequences(a: UchiValue[], b: UchiValue[]): Ordering {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const result = compare(a[i] as UchiValue, b[i] as UchiValue);
    if (result !== 0) return result;
  }
  return order(a.length, b.length);
}

// =========================================================== arithmetique

function checkOverflow(result: number, op: string, a: number, b: number): number {
  if (!Number.isFinite(result)) {
    throw makeError('OverflowError', `resultat trop grand pour '${op}' (${a} ${op} ${b})`);
  }
  if (Number.isInteger(result) && Math.abs(result) > MAX_SAFE) {
    throw makeError('OverflowError', `depassement d'entier sur '${op}' (${a} ${op} ${b})`);
  }
  return result;
}

export function binaryOp(op: string, a: UchiValue, b: UchiValue): UchiValue {
  const custom = overrides?.binary(op, a, b);
  if (custom !== undefined) return custom;
  // `True + 1` vaut 2 : si les deux operandes sont numeriques, `bool` devient
  // 0 ou 1 avant le dispatch. Sinon le message d'erreur garde `bool`.
  if (isNumeric(a) && isNumeric(b)) {
    a = asNumeric(a);
    b = asNumeric(b);
  }
  switch (op) {
    case '+':
      return add(a, b);
    case '-':
      return subtract(a, b);
    case '*':
      return multiply(a, b);
    case '/':
      return trueDivide(a, b);
    case '//':
      return floorDivide(a, b);
    case '%':
      return modulo(a, b);
    case '**':
      return power(a, b);
    case '<<':
      return bitShift(a, b, op);
    case '>>':
      return bitShift(a, b, op);
    case '&':
    case '|':
    case '^':
      return bitwise(a, b, op);
    case '@':
      throw makeError(
        'TypeError',
        "l'operateur '@' (produit matriciel) n'est pas encore supporte par Uchi",
      );
    default:
      throw makeError('RuntimeError', `operateur binaire inconnu '${op}'`);
  }
}

function add(a: UchiValue, b: UchiValue): UchiValue {
  if (typeof a === 'number' && typeof b === 'number') {
    return checkOverflow(a + b, '+', a, b);
  }
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (isList(a) && isList(b)) return [...a, ...b];
  if (a instanceof UchiTuple && b instanceof UchiTuple) {
    return new UchiTuple([...a.items, ...b.items]);
  }
  throw makeError('TypeError', `operateur '+' non defini entre ${describe(a)} et ${describe(b)}`);
}

function subtract(a: UchiValue, b: UchiValue): UchiValue {
  if (typeof a === 'number' && typeof b === 'number') {
    return checkOverflow(a - b, '-', a, b);
  }
  if (a instanceof UchiSet && b instanceof UchiSet) {
    return new UchiSet([...a.values()].filter((v) => !b.has(v)));
  }
  throw makeError('TypeError', `operateur '-' non defini entre ${describe(a)} et ${describe(b)}`);
}

function repeat(value: UchiValue, times: UchiValue, op: string): UchiValue {
  const count0 = asNumeric(times);
  if (typeof count0 !== 'number' || !Number.isInteger(count0) || count0 < 0) {
    throw makeError('TypeError', `l'operateur '${op}' attend un entier positif comme multiplicateur`);
  }
  const count = count0;
  if (typeof value === 'string') return value.repeat(count);
  if (isList(value)) {
    const out: UchiValue[] = [];
    for (let i = 0; i < count; i++) out.push(...value);
    return out;
  }
  if (value instanceof UchiTuple) {
    const out: UchiValue[] = [];
    for (let i = 0; i < count; i++) out.push(...value.items);
    return new UchiTuple(out);
  }
  throw makeError('TypeError', `l'operateur '${op}' ne peut pas repeter ${describe(value)}`);
}

function multiply(a: UchiValue, b: UchiValue): UchiValue {
  if (isNumeric(a) && isNumeric(b)) {
    const x = asNumeric(a) as number;
    const y = asNumeric(b) as number;
    return checkOverflow(x * y, '*', x, y);
  }
  // Un `bool` convient comme multiplicateur : `"ab" * True` vaut `"ab"`.
  if (isNumeric(a) && typeof b === 'string') return repeat(b, a, '*');
  if (typeof a === 'string' && isNumeric(b)) return repeat(a, b, '*');
  if (isNumeric(a) && isList(b)) return repeat(b, a, '*');
  if (isList(a) && isNumeric(b)) return repeat(a, b, '*');
  if (isNumeric(a) && b instanceof UchiTuple) return repeat(b, a, '*');
  if (a instanceof UchiTuple && isNumeric(b)) return repeat(a, b, '*');
  throw makeError('TypeError', `operateur '*' non defini entre ${describe(a)} et ${describe(b)}`);
}

function trueDivide(a: UchiValue, b: UchiValue): UchiValue {
  const x = requireNumber('/', a);
  const y = requireNumber('/', b);
  if (y === 0) throw makeError('ZeroDivisionError', 'division par zero');
  return x / y;
}

function floorDivide(a: UchiValue, b: UchiValue): UchiValue {
  const x = requireNumber('//', a);
  const y = requireNumber('//', b);
  if (y === 0) throw makeError('ZeroDivisionError', 'division entiere par zero');
  return Math.floor(x / y);
}

function modulo(a: UchiValue, b: UchiValue): UchiValue {
  if (typeof a === 'string' && typeof b !== 'number') {
    throw makeError(
      'TypeError',
      "le formatage par '%' n'est pas supporte : utilisez une f-string, par exemple f\"{valeur}\"",
    );
  }
  const x = requireNumber('%', a);
  const y = requireNumber('%', b);
  if (y === 0) throw makeError('ZeroDivisionError', 'modulo par zero');
  const result = x % y;
  // Python suit le signe du diviseur, JS celui de la dividend : on corrige le
  // resultat negatif quand les deux operandes n'ont pas le meme signe.
  if (result !== 0 && result < 0 !== y < 0) return result + y;
  return result;
}

function power(a: UchiValue, b: UchiValue): UchiValue {
  const x = requireNumber('**', a);
  const y = requireNumber('**', b);
  const result = x ** y;
  if (Number.isNaN(result) && !Number.isNaN(x) && !Number.isNaN(y)) {
    throw makeError('ValueError', `resultat ind defini pour ${x} ** ${y}`);
  }
  if (Number.isInteger(x) && Number.isInteger(y) && y < 0 && x === 0) {
    throw makeError('ZeroDivisionError', 'puissance negative de zero');
  }
  return result;
}

function bitShift(a: UchiValue, b: UchiValue, op: string): UchiValue {
  const x = requireInteger(op, a);
  const y = requireInteger(op, b);
  if (y < 0) throw makeError('ValueError', "un decalage ne peut pas etre negatif");
  if (y > 1024) throw makeError('ValueError', 'decalage trop grand');
  return op === '<<' ? x * 2 ** y : Math.floor(x / 2 ** y);
}

function bitwise(a: UchiValue, b: UchiValue, op: string): UchiValue {
  const x = requireInteger(op, a);
  const y = requireInteger(op, b);
  const result =
    op === '&' ? BigInt(x) & BigInt(y) : op === '|' ? BigInt(x) | BigInt(y) : BigInt(x) ^ BigInt(y);
  const back = Number(result);
  if (!Number.isSafeInteger(back)) {
    throw makeError('OverflowError', `operation binaire '${op}' hors de la plage des entiers`);
  }
  return back;
}

export function unaryOp(op: string, value: UchiValue): UchiValue {
  switch (op) {
    case '-':
      return checkOverflow(-requireNumber('-', value), '-', 0, value as number);
    case '+':
      return requireNumber('+', value);
    case 'not':
      return !truthy(value);
    case '~':
      return ~requireInteger('~', value);
    default:
      throw makeError('RuntimeError', `operateur unaire inconnu '${op}'`);
  }
}

// ============================================================ indexation

export function length(value: UchiValue): number {
  if (typeof value === 'string') return value.length;
  if (isList(value)) return value.length;
  if (value instanceof UchiTuple) return value.items.length;
  if (value instanceof UchiDict) return value.size;
  if (value instanceof UchiSet) return value.size;
  if (value instanceof UchiRange) return value.length;
  throw makeError('TypeError', `l'objet de type '${typeName(value)}' n'a pas de longueur`);
}

export function isSized(value: UchiValue): boolean {
  return (
    typeof value === 'string' ||
    isList(value) ||
    value instanceof UchiTuple ||
    value instanceof UchiDict ||
    value instanceof UchiSet ||
    value instanceof UchiRange
  );
}

/** Convertit un indice en position positive, ou `null` si hors bornes. */
export function normalizeIndex(index: number, size: number): number | null {
  const resolved = index < 0 ? index + size : index;
  if (resolved < 0 || resolved >= size) return null;
  return resolved;
}

export function getItem(target: UchiValue, index: UchiValue): UchiValue {
  if (typeof target === 'string') {
    const i = requireInteger('indexation', index);
    const position = normalizeIndex(i, target.length);
    if (position === null) throw indexError('chaine', i, target.length);
    return target[position] as string;
  }
  if (isList(target)) {
    const i = requireInteger('indexation', index);
    const position = normalizeIndex(i, target.length);
    if (position === null) throw indexError('liste', i, target.length);
    return target[position] as UchiValue;
  }
  if (target instanceof UchiTuple) {
    const i = requireInteger('indexation', index);
    const position = normalizeIndex(i, target.items.length);
    if (position === null) throw indexError('tuple', i, target.items.length);
    return target.items[position] as UchiValue;
  }
  if (target instanceof UchiDict) {
    if (!target.has(index)) {
      throw makeError('KeyError', toRepr(index));
    }
    return target.get(index) as UchiValue;
  }
  if (target instanceof UchiRange) {
    const i = requireInteger('indexation', index);
    const position = normalizeIndex(i, target.length);
    if (position === null) throw indexError('range', i, target.length);
    return target.at(position);
  }
  throw makeError('TypeError', `'${typeName(target)}' ne supporte pas l'indexation`);
}

function indexError(kind: string, index: number, size: number): ReturnType<typeof makeError> {
  return makeError('IndexError', `index de ${kind} hors limites : ${index} (longueur ${size})`);
}

export function setItem(target: UchiValue, index: UchiValue, value: UchiValue): void {
  if (isList(target)) {
    const i = requireInteger('affectation par index', index);
    const position = normalizeIndex(i, target.length);
    if (position === null) throw indexError('liste', i, target.length);
    target[position] = value;
    return;
  }
  if (target instanceof UchiDict) {
    target.set(index, value);
    return;
  }
  if (target instanceof UchiError) {
    if (index === 'args' || index === 'message' || index === 'name') {
      return; // champs en lecture seule
    }
  }
  throw makeError('TypeError', `l'objet de type '${typeName(target)}' ne supporte pas l'affectation par index`);
}

// ================================================================= tranches

/**
 * Rend une borne de tranche positive. Pour la borne basse, `-1` reste admis :
 * avec un pas negatif, la borne haute implicite est `-1` (« jusqu'au debut »),
 * et la borner a `0` viderait la tranche. L'index de depart, lui, ne peut pas
 * descendre sous `0`.
 */
function normalizeBound(value: number, size: number, lowest: number): number {
  const resolved = value < 0 ? value + size : value;
  if (resolved < lowest) return lowest;
  if (resolved > size) return size;
  return resolved;
}

export function sliceItems(
  source: UchiValue[],
  lower: UchiValue | null,
  upper: UchiValue | null,
  stepValue: UchiValue | null,
): UchiValue[] {
  const size = source.length;
  let step = stepValue === null ? 1 : requireInteger('tranche', stepValue);
  if (step === 0) throw makeError('ValueError', "le pas d'une tranche ne peut pas etre zero");

  if (lower === null && upper === null && stepValue === null) return source.slice();

  const start =
    lower === null
      ? step > 0
        ? 0
        : size - 1
      : normalizeBound(requireInteger('tranche', lower), size, 0);
  const stop =
    upper === null
      ? step > 0
        ? size
        : -1
      : normalizeBound(requireInteger('tranche', upper), size, -1);

  const out: UchiValue[] = [];
  if (step > 0) {
    for (let i = start; i < stop; i += step) out.push(source[i] as UchiValue);
  } else {
    for (let i = start; i > stop; i += step) out.push(source[i] as UchiValue);
  }
  return out;
}

export function makeSlice(
  target: UchiValue,
  lower: UchiValue | null,
  upper: UchiValue | null,
  stepValue: UchiValue | null,
): UchiValue {
  if (typeof target === 'string') {
    return sliceItems([...target], lower, upper, stepValue).join('');
  }
  if (isList(target)) return sliceItems(target, lower, upper, stepValue);
  if (target instanceof UchiTuple) {
    return new UchiTuple(sliceItems(target.items, lower, upper, stepValue));
  }
  if (target instanceof UchiRange) {
    const start = lower === null ? target.start : requireInteger('tranche', lower);
    const stop = upper === null ? target.stop : requireInteger('tranche', upper);
    const step = stepValue === null ? target.step : requireInteger('tranche', stepValue);
    if (step === 0) throw makeError('ValueError', "le pas d'une tranche ne peut pas etre zero");
    return new UchiRange(start, stop, step);
  }
  throw makeError('TypeError', `'${typeName(target)}' ne supporte pas les tranches`);
}

// ============================================================ containment

export function contains(container: UchiValue, item: UchiValue): boolean {
  if (typeof container === 'string') {
    if (typeof item !== 'string') {
      throw makeError('TypeError', `argument de type '${typeName(item)}' pour 'in' sur une chaine`);
    }
    return container.includes(item);
  }
  if (isList(container)) return container.some((entry) => equals(entry, item));
  if (container instanceof UchiTuple) return container.items.some((entry) => equals(entry, item));
  if (container instanceof UchiDict) return container.has(item);
  if (container instanceof UchiSet) return container.has(item);
  if (container instanceof UchiRange) {
    return typeof item === 'number' && Number.isInteger(item)
      ? item >= Math.min(container.start, container.stop + container.step) &&
          item <= Math.max(container.start, container.stop - container.step)
      : false;
  }
  throw makeError(
    'TypeError',
    `l'operateur 'in' n'est pas defini pour '${typeName(container)}'`,
  );
}

export function containsIn(container: UchiValue, item: UchiValue): boolean {
  return contains(item, container);
}

// ============================================================== iteration

/** Materialise un iterable en tableau. Les modifications pendant la boucle sont sans effet. */
export function iterate(value: UchiValue): UchiValue[] {
  if (isList(value)) return value.slice();
  if (value instanceof UchiTuple) return value.items.slice();
  if (typeof value === 'string') return [...value];
  if (value instanceof UchiDict) return [...value.keys()];
  if (value instanceof UchiSet) return [...value.values()];
  if (value instanceof UchiRange) {
    const out: UchiValue[] = [];
    for (let i = 0; i < value.length; i++) out.push(value.at(i));
    return out;
  }
  throw makeError('TypeError', `'${typeName(value)}' n'est pas iterable`);
}

export function isIterable(value: UchiValue): boolean {
  return (
    isList(value) ||
    value instanceof UchiTuple ||
    typeof value === 'string' ||
    value instanceof UchiDict ||
    value instanceof UchiSet ||
    value instanceof UchiRange
  );
}

/** Genere une liste de 0 a `n - 1` (utilise par `range`). */
export function sequenceFrom(range: UchiRange): UchiValue[] {
  const out: UchiValue[] = [];
  for (let i = 0; i < range.length; i++) out.push(range.at(i));
  return out;
}
