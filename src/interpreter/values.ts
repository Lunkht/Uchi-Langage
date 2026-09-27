/**
 * Valeurs a l'execution d'Uchi.
 *
 * Representation des primitives :
 *   - `None`   -> `null`
 *   - `bool`   -> `true` / `false`
 *   - `int` et `float` -> `number` (IEEE-754 double ; un nombre entier est
 *     affiche sans partie decimale)
 *   - `str`    -> `string`
 *
 * Les types composites ont une classe dediee. Une `list` est un tableau
 * JavaScript ordinaire : c'est rapide et l'identite de reference coincide avec
 * le comportement attendu d'une liste mutable.
 */

import type { Expr, Param, Stmt } from '../parser/ast.ts';
import type { Environment } from './environment.ts';
import type { NativeCallArgs, NativeFunctionBody, HostContext } from './context.ts';

// =============================================================== conteneurs

/** Liste mutable : `Array<UchiValue>`. */
export type UchiList = UchiValue[];

/** Tuple immuable. */
export class UchiTuple {
  readonly items: UchiValue[];
  constructor(items: UchiValue[]) {
    this.items = items;
  }
}

/** Dictionnaire ordonne par insertion. */
export class UchiDict {
  private readonly entries: Map<UchiValue, UchiValue>;

  constructor(entries?: Iterable<[UchiValue, UchiValue]>) {
    this.entries = new Map(entries);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: UchiValue): boolean {
    return this.entries.has(key);
  }

  /** `undefined` si la cle est absente (les valeurs Uchi ne sont jamais `undefined`). */
  get(key: UchiValue): UchiValue | undefined {
    return this.entries.get(key);
  }

  set(key: UchiValue, value: UchiValue): void {
    this.entries.set(key, value);
  }

  delete(key: UchiValue): boolean {
    return this.entries.delete(key);
  }

  keys(): IterableIterator<UchiValue> {
    return this.entries.keys();
  }

  values(): IterableIterator<UchiValue> {
    return this.entries.values();
  }

  entriesIterator(): IterableIterator<[UchiValue, UchiValue]> {
    return this.entries.entries();
  }
}

/** Ensemble. */
export class UchiSet {
  private readonly items: Set<UchiValue>;

  constructor(items?: Iterable<UchiValue>) {
    this.items = new Set(items);
  }

  get size(): number {
    return this.items.size;
  }

  has(value: UchiValue): boolean {
    return this.items.has(value);
  }

  add(value: UchiValue): boolean {
    const before = this.items.size;
    this.items.add(value);
    return this.items.size !== before;
  }

  delete(value: UchiValue): boolean {
    return this.items.delete(value);
  }

  values(): IterableIterator<UchiValue> {
    return this.items.values();
  }
}

/** Sequence produite par `range()`. */
export class UchiRange {
  readonly start: number;
  readonly stop: number;
  readonly step: number;

  constructor(start: number, stop: number, step: number) {
    this.start = start;
    this.stop = stop;
    this.step = step;
  }

  get length(): number {
    if (this.step > 0) return Math.max(0, Math.ceil((this.stop - this.start) / this.step));
    return Math.max(0, Math.ceil((this.start - this.stop) / -this.step));
  }

  at(index: number): number {
    return this.start + index * this.step;
  }

  *[Symbol.iterator](): Generator<number> {
    for (let i = 0; i < this.length; i++) yield this.at(i);
  }
}

// ============================================================== callables

export class UchiFunction {
  readonly name: string;
  readonly params: Param[];
  readonly body: Stmt[];
  readonly closure: Environment;
  /** `true` si la fonction est liee automatiquement a un recepteur. */
  readonly isMethod: boolean;
  /** Corps d'une `lambda` (expression) ; `null` pour une fonction `def`. */
  readonly lambdaBody: Expr | null;

  constructor(
    name: string,
    params: Param[],
    body: Stmt[],
    closure: Environment,
    isMethod: boolean,
    lambdaBody: Expr | null = null,
  ) {
    this.name = name;
    this.params = params;
    this.body = body;
    this.closure = closure;
    this.isMethod = isMethod;
    this.lambdaBody = lambdaBody;
  }

  /** `true` pour une lambda (corps expressionnel). */
  get isLambda(): boolean {
    return this.lambdaBody !== null;
  }
}

export class UchiNativeFunction {
  readonly name: string;
  readonly body: NativeFunctionBody;
  /** Nombre de parametres positionnels accepts, ou `-1` pour une variadique. */
  readonly arity: number;
  /** Noms des parametres cle, si la fonction en accepte. */
  readonly keywordParams: string[];

  constructor(
    name: string,
    body: NativeFunctionBody,
    arity = -1,
    keywordParams: string[] = [],
  ) {
    this.name = name;
    this.body = body;
    this.arity = arity;
    this.keywordParams = keywordParams;
  }
}

/** Methode liee a son recepteur, produite par l'acces a `instance.methode`. */
export class UchiBoundMethod {
  readonly receiver: UchiValue;
  readonly fn: UchiFunction;
  /** Classe proprietaire, pour que `super()` fonctionne a l'interieur. */
  readonly ownerClass: UchiClass | null;

  constructor(receiver: UchiValue, fn: UchiFunction, ownerClass: UchiClass | null = null) {
    this.receiver = receiver;
    this.fn = fn;
    this.ownerClass = ownerClass;
  }
}

// ============================================================== objets

export class UchiClass {
  readonly name: string;
  readonly bases: UchiClass[];
  /** Methodes et attributs de classe, resolus par heritage. */
  private readonly table: Map<string, UchiValue>;
  /** Recherche d'attribut en remontant la hierarchie. */
  lookup(name: string): UchiValue | undefined {
    const own = this.table.get(name);
    if (own !== undefined) return own;
    for (const base of this.bases) {
      const inherited = base.lookup(name);
      if (inherited !== undefined) return inherited;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  set(name: string, value: UchiValue): void {
    this.table.set(name, value);
  }

  get(name: string): UchiValue | undefined {
    return this.table.get(name);
  }

  /** Noms definis directement sur la classe. */
  ownNames(): string[] {
    return [...this.table.keys()];
  }

  /** Tous les noms visibles, heritage compris, sans doublon. */
  allNames(): string[] {
    const names = new Set<string>();
    for (const base of this.bases) for (const n of base.allNames()) names.add(n);
    for (const n of this.table.keys()) names.add(n);
    return [...names];
  }

  /** Classe de base la plus proche, ou `null`. */
  get superClass(): UchiClass | null {
    return this.bases[0] ?? null;
  }

  /** `true` si `klass` est cette classe ou l'une de ses ancetres. */
  isSubclassOf(klass: UchiClass): boolean {
    if (this === klass) return true;
    return this.bases.some((base) => base.isSubclassOf(klass));
  }

  /**
   * Conversion associee aux types integres : `int("12")`, `list([1, 2])`.
   * Absente pour une classe ecrita en Uchi, qui s'instancie normalement.
   */
  readonly converter: ((args: NativeCallArgs, ctx: HostContext) => UchiValue) | null;

  constructor(
    name: string,
    bases: UchiClass[],
    converter: ((args: NativeCallArgs, ctx: HostContext) => UchiValue) | null = null,
  ) {
    this.name = name;
    this.bases = bases;
    this.converter = converter;
    this.table = new Map();
  }
}

export class UchiInstance {
  readonly klass: UchiClass;
  private readonly fields: Map<string, UchiValue>;
  /**
   * Etat cote implementation, invisible depuis Uchi : poignee de fichier,
   * curseur d'iterateur, etc. Les classes natives y rangent leurs ressources.
   */
  payload: unknown = null;

  get(name: string): UchiValue | undefined {
    return this.fields.get(name);
  }

  set(name: string, value: UchiValue): void {
    this.fields.set(name, value);
  }

  has(name: string): boolean {
    return this.fields.has(name);
  }

  delete(name: string): boolean {
    return this.fields.delete(name);
  }

  fieldNames(): string[] {
    return [...this.fields.keys()];
  }

  constructor(klass: UchiClass) {
    this.klass = klass;
    this.fields = new Map();
  }
}

/**
 * Resultat de `super()`.
 *
 * `after` est la classe a partir de laquelle chercher (`self` exclu) :
 * c'est la classe de la methode courante, si bien que la recherche commence
 * par sa classe de base. L/heritage est lineaire et multiple.
 */
export class UchiSuper {
  readonly receiver: UchiValue;
  readonly after: UchiClass;
  /** Classe de la methode appelante, utile pour le diagnostic. */
  readonly currentClass: UchiClass;

  constructor(receiver: UchiValue, currentClass: UchiClass) {
    this.receiver = receiver;
    this.currentClass = currentClass;
    this.after = currentClass.superClass ?? currentClass;
  }
}

/** Module : espace de noms de premier niveau. */
export class UchiModule {
  readonly name: string;
  private readonly members: Map<string, UchiValue>;

  get(name: string): UchiValue | undefined {
    return this.members.get(name);
  }

  set(name: string, value: UchiValue): void {
    this.members.set(name, value);
  }

  has(name: string): boolean {
    return this.members.has(name);
  }

  names(): string[] {
    return [...this.members.keys()].filter((n) => !n.startsWith('_'));
  }

  constructor(name: string) {
    this.name = name;
    this.members = new Map();
  }
}

// ================================================================ erreurs

/**
 * Valeur d'exception. `name` est le nom du type (`ValueError`, ...) et
 * `klass` la classe Uchi associee si elle provient d'un `raise`.
 */
export class UchiError {
  readonly name: string;
  readonly message: string;
  readonly args: UchiValue[];
  /** Classe Uchi d'origine, si l'exception a ete levee avec `raise`. */
  readonly klass: UchiClass | null;
  readonly cause: UchiValue | null;
  /** `true` pour une erreur interne du runtime, jamais rattrapable par `except`. */
  readonly isInternal: boolean;

  constructor(
    name: string,
    message: string,
    options: { args?: UchiValue[]; klass?: UchiClass | null; cause?: UchiValue | null; isInternal?: boolean } = {},
  ) {
    this.name = name;
    this.message = message;
    this.args = options.args ?? [message];
    this.klass = options.klass ?? null;
    this.cause = options.cause ?? null;
    this.isInternal = options.isInternal ?? false;
  }
}

// =============================================================== type union

export type UchiValue =
  | null
  | boolean
  | number
  | string
  | UchiList
  | UchiTuple
  | UchiDict
  | UchiSet
  | UchiRange
  | UchiFunction
  | UchiNativeFunction
  | UchiBoundMethod
  | UchiClass
  | UchiInstance
  | UchiModule
  | UchiSuper
  | UchiError;

export function isList(value: UchiValue): value is UchiList {
  return Array.isArray(value);
}

export function isCallable(value: UchiValue): boolean {
  return (
    value instanceof UchiFunction ||
    value instanceof UchiNativeFunction ||
    value instanceof UchiBoundMethod ||
    value instanceof UchiClass
  );
}
