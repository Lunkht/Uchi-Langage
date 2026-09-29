/**
 * Interpreteur Uchi : parcours de l'AST et execution.
 *
 * Modele : « tree-walking interpreter ». Chaque noeud de l'AST est visite au
 * moment de l'execution. Les flux de controle (`break`, `continue`, `return`)
 * sont propages par des signaux, jamais par des exceptions, afin de distinguer
 * une sortie de boucle d'une erreur.
 *
 * Portees : chaque fonction et chaque module possede son `Environment`, enchaine
 * vers celui qui l'a engendre (voir `environment.ts`).
 */

import { readSync } from 'node:fs';
import { UchiThrow, setTraceProvider, throwValue } from '../errors.ts';
import { parse } from '../parser/parser.ts';
import { AUGMENTED_TO_BINARY } from '../parser/parser.ts';
import type {
  Argument,
  AssignTarget,
  ComparisonOp,
  ComprehensionClause,
  ComprehensionExpr,
  Expr,
  FStringPart,
  Program,
  Stmt,
} from '../parser/ast.ts';
import type { HostContext, NativeCallArgs } from './context.ts';
import { makeError } from './error-registry.ts';
import { Environment } from './environment.ts';
import { applyFormat } from './format.ts';
import {
  DICT_METHODS,
  LIST_METHODS,
  RANGE_METHODS,
  SET_METHODS,
  STRING_METHODS,
  TUPLE_METHODS,
  type MethodTable,
} from './native-methods.ts';
import { ModuleLoader } from './module-loader.ts';
import {
  binaryOp,
  compare,
  contains,
  equals,
  getItem,
  isIterable,
  isSized,
  iterate,
  length,
  makeSlice,
  setCustomRepr,
  setItem,
  setOperatorOverride,
  toRepr,
  toStr,
  truthy,
  typeName,
  unaryOp,
  type Ordering,
} from './operations.ts';
import {
  UchiBoundMethod,
  UchiClass,
  UchiDict,
  UchiError,
  UchiFunction,
  UchiInstance,
  UchiModule,
  UchiNativeFunction,
  UchiRange,
  UchiSet,
  UchiSuper,
  UchiTuple,
  isList,
  type UchiValue,
} from './values.ts';
import {
  builtinTypeClass,
  builtinTypeClasses,
  classNameOf,
  createBuiltins,
  createIterator,
  errorClassByName,
} from '../stdlib/builtins.ts';
import { createBuiltinModules } from '../stdlib/modules.ts';

// ============================================================ flux de controle

/** Signaux de sortie de bloc. Aucune exception n'est levee pour ces cas. */
class BreakSignal {
  readonly name = 'break';
}
class ContinueSignal {
  readonly name = 'continue';
}
class ReturnSignal {
  readonly name = 'return';
  readonly value: UchiValue;

  constructor(value: UchiValue) {
    this.value = value;
  }
}
type Signal = BreakSignal | ContinueSignal | ReturnSignal;

const BREAK = new BreakSignal();
const CONTINUE = new ContinueSignal();

/**
 * Masque du controle du delai : l'horloge n'est lue qu'un tour sur 4096, pour
 * que la garde reste negligeable devant le cout d'un tour de boucle.
 */
const DEADLINE_MASK = 0xfff;

/** Pile d'appels : sert a `super()` et aux traces d'appels. */
interface Frame {
  name: string;
  /** Classe dans le corps de laquelle la methode a ete definie. */
  classContext: UchiClass | null;
  /** Recepteur implicite, si la fonction est une methode liee. */
  self: UchiValue | null;
  /** Derniere instruction executee dans ce cadre : sert a la trace d'appels. */
  line: number;
}

export interface InterpreterOptions {
  /** Ecriture sur la sortie standard. */
  write?: (text: string) => void;
  /** Lecture d'une ligne sur l'entree standard ; `null` signale la fin du flux. */
  readLine?: () => string | null;
  /** Repertoires supplementaires pour la recherche de modules. */
  modulePaths?: string[];
  /** Repertoire de base des imports (normalement le dossier du script). */
  baseDirectory?: string;
  /** Arguments du programme, exposes par `sys.argv`. */
  argv?: string[];
  /** Profondeur d'appels maximale : garde-fou contre la recursion infinie. */
  maxCallDepth?: number;
  /** Nombre d'iterations maximal par boucle : garde-fou contre `while True`. */
  maxLoopIterations?: number;
  /**
   * Delai maximal d'une evaluation, en millisecondes ; `0` signifie aucun
   * delai. Utilise par l'interpreteur interactif, ou un fil dedie ne peut pas
   * interrompre le programme sans perdre l'etat de la session.
   */
  deadlineMs?: number;
}

export class Interpreter implements HostContext {
  /** Builtins : parent de toutes les portees, donc visible partout. */
  readonly builtinsEnv: Environment;
  /** Portee globale du programme principal. */
  readonly globalEnv: Environment;
  readonly frames: Frame[] = [];
  readonly argv: string[];
  readonly moduleLoader: ModuleLoader;
  /** Nom du module en cours d'execution (valeur de `__name__`). */
  currentModuleName = '__main__';
  /** Ligne de la derniere instruction commencee : cible des erreurs d'execution. */
  currentLine = 0;

  /** Ligne de la derniere instruction du niveau module : origine de la trace. */
  private moduleLine = 0;

  /**
   * Instant limite de l'evaluation en cours, en millisecondes ; `0` si
   * l'execution n'est pas bornee dans le temps. Reglable entre deux
   * evaluations, ce qui permet a l'interpreteur interactif de borner chaque
   * instruction saisie sans perdre l'etat de la session.
   */
  deadline = 0;

  private readonly writeFn: (text: string) => void;
  private readonly readLineFn: () => string | null;
  private readonly maxCallDepth: number;
  private readonly maxLoopIterations: number;
  private readonly defaultDeadlineMs: number;

  constructor(options: InterpreterOptions = {}) {
    this.writeFn = options.write ?? ((text: string) => process.stdout.write(text));
    this.readLineFn = options.readLine ?? defaultReadLine;
    this.argv = options.argv ?? [];
    this.maxCallDepth = options.maxCallDepth ?? 2000;
    this.maxLoopIterations = options.maxLoopIterations ?? 10_000_000;
    this.defaultDeadlineMs = options.deadlineMs ?? 0;
    this.armDeadline();

    this.builtinsEnv = new Environment(null, false);
    this.globalEnv = new Environment(this.builtinsEnv, true);

    // Les representations d'objets personnalises sont resolues par l'hote.
    setCustomRepr((value) => this.customReprOf(value));
    // Les operateurs ecrits dans une classe priment sur les operateurs standard.
    setOperatorOverride({
      binary: (op, left, right) => this.overrideBinary(op, left, right),
      compare: (op, left, right) => this.overrideCompare(op, left, right),
      equals: (left, right) => this.overrideEquals(left, right),
    });
    // `raise` n'a pas acces a l'interpreteur : la trace est capturee pour lui.
    setTraceProvider(() => this.callTrace());

    for (const [name, value] of createBuiltins(this)) this.builtinsEnv.define(name, value);
    for (const [name, klass] of builtinTypeClasses()) this.builtinsEnv.define(name, klass);

    this.moduleLoader = new ModuleLoader(
      this,
      createBuiltinModules(),
      options.modulePaths ?? [],
      options.baseDirectory ?? process.cwd(),
    );

    this.globalEnv.define('__name__', '__main__');
  }

  // ==================================================================== API

  /** Execute un programme analyse. */
  run(program: Program): void {
    this.withThrowBoundary(() => this.execBlock(program.body, this.globalEnv));
  }

  /** Execute un programme dans une portee imposee (chargement de module). */
  runIn(env: Environment, program: Program): void {
    this.withThrowBoundary(() => this.execBlock(program.body, env));
  }

  /** Analyse puis execute une source (REPL, option `-e`). */
  runSource(source: string, path = '<repl>'): UchiValue {
    const program = parse(source, path);
    // Chaque instruction saisie est un programme distinct : le delai repart de
    // zero, sans quoi la session deviendrait inutilisable apres quelques lignes.
    this.armDeadline();
    return this.withThrowBoundary(() => this.execStatementsForResult(program.body, this.globalEnv));
  }

  /** Place l'instant limite a `defaultDeadlineMs` a partir de maintenant. */
  private armDeadline(): void {
    this.deadline = this.defaultDeadlineMs === 0 ? 0 : Date.now() + this.defaultDeadlineMs;
  }

  /**
   * Convertit une `UchiError` brute en `UchiThrow` a la limite publique.
   *
   * Les erreurs des operations natives sont levees ainsi pour rester
   * rattrapables par `try` ; cette barriere garantit qu'un hebergeur ne voit
   * jamais fuir une erreur non enveloppee.
   */
  private withThrowBoundary<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      // Les cadres sont deja depiles ici : la trace vient de l'erreur, capturee
      // a sa creation, donc a l'endroit ou l'operation a echoue.
      if (error instanceof UchiError) throw new UchiThrow(error, error.traceback);
      throw error;
    }
  }

  /**
   * Trace d'appels, du plus ancien au plus recent : le niveau module, puis un
   * cadre par fonction, avec la derniere ligne qui y fut executee. Le dernier
   * element designe donc la ligne a afficher pour une erreur.
   */
  private callTrace(): string[] {
    const lines: string[] = [];
    if (this.moduleLine > 0) lines.push(`ligne ${this.moduleLine}, dans <module>`);
    for (const frame of this.frames) {
      lines.push(frame.line > 0 ? `ligne ${frame.line}, dans ${frame.name}` : `dans ${frame.name}`);
    }
    if (lines.length === 0) lines.push('module');
    return lines;
  }

  /** Ecriture directe sur la sortie du programme. */
  print(text: string): void {
    this.writeFn(text);
  }

  /** Lecture d'une ligne, invite comprise. */
  readLine(prompt = ''): string | null {
    if (prompt !== '') this.writeFn(prompt);
    return this.readLineFn();
  }

  // ============================================================ instructions

  private execBlock(statements: Stmt[], env: Environment): Signal | null {
    for (const statement of statements) {
      const signal = this.exec(statement, env);
      if (signal !== null) return signal;
    }
    return null;
  }

  /** Comme `execBlock`, mais renvoie la valeur de la derniere expression. */
  private execStatementsForResult(statements: Stmt[], env: Environment): UchiValue {
    let last: UchiValue = null;
    for (const statement of statements) {
      // Les expressions sont evaluees ici sans passer par `exec` : la ligne est
      // notee de la main, sinon une erreur du REPL n'aurait pas de trace.
      if (statement.kind === 'expr-statement') {
        this.noteLine(statement);
        last = this.evaluate(statement.expression, env);
        continue;
      }
      const signal = this.exec(statement, env);
      if (signal instanceof ReturnSignal) return signal.value;
      if (signal !== null) last = null;
    }
    return last;
  }

  /**
   * Retient la ligne de l'instruction qui demarre.
   *
   * Une seule ecriture par instruction : c'est ce numero qui est affiche
   * lorsqu'une erreur d'execution interrompt le programme, et celui que la
   * trace d'appels attribue au cadre courant.
   */
  private noteLine(statement: Stmt): void {
    const line = statement.loc?.line;
    if (line === undefined || line <= 0) return;
    this.currentLine = line;
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) {
      // Niveau module : la ligne sert de point de depart a la trace d'appels.
      this.moduleLine = line;
      return;
    }
    frame.line = line;
  }

  private exec(statement: Stmt, env: Environment): Signal | null {
    this.noteLine(statement);
    switch (statement.kind) {
      case 'expr-statement':
        this.evaluate(statement.expression, env);
        return null;

      case 'assign':
        this.execAssign(statement, env);
        return null;
      case 'aug-assign':
        this.execAugAssign(statement, env);
        return null;

      case 'if':
        return this.execIf(statement, env);
      case 'while':
        return this.execWhile(statement, env);
      case 'for':
        return this.execFor(statement, env);

      case 'break':
        return BREAK;
      case 'continue':
        return CONTINUE;
      case 'pass':
        return null;

      case 'function':
        env.define(statement.name, this.makeFunction(statement.name, statement.params, statement.body, env));
        return null;
      case 'class':
        this.execClass(statement, env);
        return null;
      case 'return':
        return new ReturnSignal(statement.value === null ? null : this.evaluate(statement.value, env));

      case 'import':
        return this.execImport(statement.module, statement.alias, env);
      case 'import-from':
        return this.execImportFrom(statement, env);

      case 'try':
        return this.execTry(statement, env);
      case 'with':
        return this.execWith(statement, env);
      case 'raise':
        return this.execRaise(statement, env);
      case 'assert':
        return this.execAssert(statement, env);

      case 'global':
        for (const name of statement.names) env.declareGlobal(name);
        return null;
      case 'nonlocal':
        for (const name of statement.names) env.declareNonlocal(name);
        return null;
      case 'del':
        return this.execDel(statement, env);

      default:
        return this.internalError(`instruction non geree : ${(statement as Stmt).kind}`);
    }
  }

  private execAssign(statement: Extract<Stmt, { kind: 'assign' }>, env: Environment): void {
    // Les annotations sont informatives : elles ne sont pas verifiees a l'execution.
    const value = this.evaluate(statement.value, env);
    for (const target of statement.targets) this.assign(target, value, env);
  }

  private execAugAssign(statement: Extract<Stmt, { kind: 'aug-assign' }>, env: Environment): void {
    const current = this.readTarget(statement.target, env);
    const operand = this.evaluate(statement.value, env);
    const op = AUGMENTED_TO_BINARY[statement.op];
    // `x += y` passe par l'operateur binaire : `liste += autre` cree donc une
    // nouvelle liste, comme en Python.
    this.assign(statement.target, binaryOp(op, current, operand), env);
  }

  private execIf(statement: Extract<Stmt, { kind: 'if' }>, env: Environment): Signal | null {
    if (truthy(this.evaluate(statement.condition, env))) {
      return this.execBlock(statement.consequence, env);
    }
    const alternate = statement.alternate;
    if (alternate === null) return null;
    if (alternate.kind === 'else') return this.execBlock(alternate.body, env);
    return this.execIf(alternate.statement, env);
  }

  private execWhile(statement: Extract<Stmt, { kind: 'while' }>, env: Environment): Signal | null {
    let iterations = 0;
    // `while ... else` : le bloc `else` ne s'execute que si la boucle s'est
    // terminee par une condition fausse, jamais apres un `break`.
    let completed = true;
    while (truthy(this.evaluate(statement.condition, env))) {
      if (++iterations > this.maxLoopIterations) {
        throwValue(
          makeError(
            'RuntimeError',
            `boucle 'while' : plus de ${this.maxLoopIterations} iterations, boucle probablement infinie`,
          ),
        );
      }
      this.checkDeadline(iterations, 'while');
      const signal = this.execBlock(statement.body, env);
      if (signal === null || signal instanceof ContinueSignal) continue;
      if (signal instanceof BreakSignal) {
        completed = false;
        break;
      }
      return signal;
    }
    if (completed && statement.orelse !== null) return this.execBlock(statement.orelse, env);
    return null;
  }

  /**
   * Verifie que le delai de l'evaluation en cours n'est pas depasse.
   *
   * L'horloge n'est lue qu'un tour sur `DEADLINE_MASK + 1` : une boucle doit
   * rester aussi rapide que possible, et le delai n'a pas besoin d'une precision
   * meilleure que quelques milliers de tours.
   */
  private checkDeadline(iterations: number, boucle: string): void {
    if (this.deadline === 0 || (iterations & DEADLINE_MASK) !== 0) return;
    if (Date.now() <= this.deadline) return;
    throwValue(
      makeError(
        'TimeoutError',
        `delai depasse pendant une boucle '${boucle}' : execution interrompue`,
      ),
    );
  }

  private execFor(statement: Extract<Stmt, { kind: 'for' }>, env: Environment): Signal | null {
    // L'iterable est materialise : la boucle observe un instantane, ce qui
    // evite les surprises lors d'une modification concurrente.
    const items = this.iterate(this.evaluate(statement.iterable, env));
    let iterations = 0;
    let completed = true;
    for (const item of items) {
      if (++iterations > this.maxLoopIterations) {
        throwValue(
          makeError(
            'RuntimeError',
            `boucle 'for' : plus de ${this.maxLoopIterations} iterations, boucle probablement infinie`,
          ),
        );
      }
      this.checkDeadline(iterations, 'for');
      this.assign(statement.target, item, env);
      const signal = this.execBlock(statement.body, env);
      if (signal === null || signal instanceof ContinueSignal) continue;
      if (signal instanceof BreakSignal) {
        completed = false;
        break;
      }
      return signal;
    }
    if (completed && statement.orelse !== null) return this.execBlock(statement.orelse, env);
    return null;
  }

  private execClass(statement: Extract<Stmt, { kind: 'class' }>, env: Environment): void {
    const bases: UchiClass[] = [];
    for (const baseExpression of statement.bases) {
      const value = this.evaluate(baseExpression, env);
      if (!(value instanceof UchiClass)) {
        throwValue(
          makeError('TypeError', `la base de classe '${toStr(value)}' n'est pas une classe`),
        );
      }
      bases.push(value);
    }
    const klass = new UchiClass(statement.name, bases);

    // Le corps s'execute dans une portee temporaire : les methodes capturent
    // cette portee, qui enchaine sur celle du module.
    const classEnv = new Environment(env);
    const signal = this.execBlock(statement.body, classEnv);
    if (signal !== null) {
      throwValue(makeError('SyntaxError', `'return' est interdit dans le corps d'une classe`));
    }
    for (const name of classEnv.names()) {
      const value = classEnv.get(name);
      klass.set(name, this.rebindAsMethod(value, klass));
    }
    klass.set('__name__', statement.name);
    env.define(statement.name, klass);
  }

  /**
   * Les fonctions definies dans un corps de classe sont des methodes :
   * elles sont liees automatiquement a leur recepteur.
   */
  private rebindAsMethod(value: UchiValue, klass: UchiClass): UchiValue {
    if (value instanceof UchiFunction && value.lambdaBody === null) {
      return new UchiFunction(value.name, value.params, value.body, value.closure, true, null);
    }
    if (value instanceof UchiClass) return value;
    void klass;
    return value;
  }

  private makeFunction(
    name: string,
    params: Extract<Stmt, { kind: 'function' }>['params'],
    body: Stmt[],
    closure: Environment,
  ): UchiFunction {
    return new UchiFunction(name, params, body, closure, false);
  }

  // ------------------------------------------------------------- exceptions

  /**
   * `with expr as cible :` — appelle `__enter__`, lie le resultat, execute le
   * bloc, puis appelle toujours `__exit__`.
   *
   * `__exit__` recoit `(type, valeur, traceback)` comme en Python ; une valeur
   * veridique supprime l'exception. Le `traceback` n'est pas simule, Uchi
   * passant `None`.
   */
  private execWith(statement: Extract<Stmt, { kind: 'with' }>, env: Environment): Signal | null {
    const entered: Array<{ manager: UchiValue; target: AssignTarget | null }> = [];
    let signal: Signal | null = null;
    let thrown: UchiThrow | null = null;

    try {
      for (const item of statement.items) {
        const manager = this.evaluate(item.context, env);
        if (!(manager instanceof UchiInstance)) {
          throwValue(
            makeError(
              'TypeError',
              `'${typeName(manager)}' ne peut pas servir de gestionnaire de contexte : __enter__ est absent`,
            ),
          );
        }
        const enter = this.callProtocol(manager, '__enter__');
        if (enter === undefined) {
          throwValue(
            makeError(
              'AttributeError',
              `'${typeName(manager)}' ne peut pas servir de gestionnaire de contexte : __enter__ est absent`,
            ),
          );
        }
        entered.push({ manager, target: item.target });
        // `as` absent : la cible est le gestionnaire lui-meme, sans liaison.
        if (item.target !== null) this.assign(item.target, enter as UchiValue, env);
      }
      signal = this.execBlock(statement.body, env);
    } catch (error) {
      thrown = asThrow(error);
    }

    // La sortie se fait en ordre inverse, comme les context managers imbriques.
    for (let i = entered.length - 1; i >= 0; i--) {
      const { manager } = entered[i] as { manager: UchiValue; target: AssignTarget | null };
      const exit = this.callProtocol(manager as UchiInstance, '__exit__', [
        thrown === null ? null : this.exceptionTypeOf(thrown.value as UchiValue),
        thrown === null ? null : thrown.value as UchiValue,
        null,
      ]);
      // Une exception dans `__exit__` prime sur le retour courant.
      if (exit === undefined) continue;
      if (thrown !== null) {
        if (!truthy(exit)) throw thrown;
        thrown = null;
        signal = null;
      }
    }

    if (thrown !== null) throw thrown;
    return signal;
  }

  /** Classe d'une valeur levee, pour `__exit__` et l'affichage. */
  private exceptionTypeOf(value: UchiValue): UchiValue {
    const error = this.asException(value);
    const klass = error.klass;
    if (klass !== null) return klass;
    const builtin = this.lookupBuiltinClass(error.name);
    return builtin ?? error;
  }

  private execTry(statement: Extract<Stmt, { kind: 'try' }>, env: Environment): Signal | null {
    let signal: Signal | null = null;
    let captured = false;
    try {
      try {
        signal = this.execBlock(statement.body, env);
      } catch (thrown) {
        signal = this.dispatchHandlers(statement, env, asThrow(thrown));
        captured = true;
      }

      // `else` s'execute hors du bloc `try` : une exception qu'il leve n'est
      // donc pas capturee par les gestionnaires, comme en Python. Il ne s'execute
      // pas non plus si un gestionnaire a reellement pris le relais.
      if (statement.elseBody !== null && !captured) {
        signal = this.execBlock(statement.elseBody, env);
      }
    } finally {
      // `finally` s'execute toujours, y compris lors d'une exception non
      // capturee, et sa sortie prime sur le signal en cours.
      if (statement.finallyBody !== null) {
        const finalSignal = this.execBlock(statement.finallyBody, env);
        if (finalSignal !== null) signal = finalSignal;
      }
    }
    return signal;
  }

  private dispatchHandlers(
    statement: Extract<Stmt, { kind: 'try' }>,
    env: Environment,
    thrown: UchiThrow,
  ): Signal | null {
    const error = this.asException(thrown.value);
    // Une erreur interne du runtime n'est jamais rattrapable par le programme.
    if (error.isInternal) throw thrown;

    for (const handler of statement.handlers) {
      // L'evaluation du type est paresseuse : elle n'a lieu que si aucun
      // gestionnaire precedent n'a correspondu.
      const matches =
        handler.type === null || this.errorMatches(error, this.evaluate(handler.type, env));
      if (!matches) continue;
      // Le gestionnaire recoit la valeur levee telle quelle (instance ou UchiError).
      if (handler.name !== null) env.assign(handler.name, thrown.value as UchiValue);
      return this.execBlock(handler.body, env);
    }
    throw thrown;
  }

  /**
   * Vue « exception » d'une valeur levee. Une instance de classe utilisateur
   * est decrite par sa classe, ce qui permet `except MaErreur`.
   */
  asException(value: unknown): UchiError {
    if (value instanceof UchiError) return value;
    if (value instanceof UchiInstance) {
      return new UchiError(value.klass.name, this.toDisplayString(value), {
        klass: value.klass,
        args: [value],
      });
    }
    if (value instanceof UchiClass) {
      return new UchiError(value.name, '', { klass: value });
    }
    if (value === undefined) return new UchiError('Error', 'None', { args: [] });
    return new UchiError('Error', toStr(value as UchiValue), { args: [value as UchiValue] });
  }

  private errorMatches(error: UchiError, expected: UchiValue): boolean {
    if (typeof expected === 'string') return error.name === expected;
    // `except (A, B) :` accepte un tuple de types.
    if (expected instanceof UchiTuple) {
      return expected.items.some((item) => this.errorMatches(error, item));
    }
    if (isList(expected)) {
      return expected.some((item) => this.errorMatches(error, item));
    }
    if (expected instanceof UchiClass) {
      if (error.klass !== null) return error.klass.isSubclassOf(expected);
      return error.name === expected.name;
    }
    if (expected instanceof UchiError) return error.name === expected.name;
    return false;
  }

  private execRaise(statement: Extract<Stmt, { kind: 'raise' }>, env: Environment): Signal | null {
    if (statement.value === null) {
      throwValue(
        makeError('RuntimeError', "'raise' sans exception : a utiliser dans un bloc 'except'"),
      );
    }
    const value = this.evaluate(statement.value, env);
    const cause = statement.cause === null ? null : this.evaluate(statement.cause, env);
    if (cause === null) {
      throwValue(value);
    }
    // `raise X from Y` : la cause est conservee dans l'exception levee.
    if (value instanceof UchiError) {
      throwValue(new UchiError(value.name, value.message, { args: value.args, klass: value.klass, cause }));
    }
    if (value instanceof UchiInstance) {
      throwValue(new UchiError(value.klass.name, this.toDisplayString(value), { klass: value.klass, cause }));
    }
    throwValue(new UchiError('Error', toStr(value), { args: [value], cause }));
  }

  private execAssert(statement: Extract<Stmt, { kind: 'assert' }>, env: Environment): Signal | null {
    if (truthy(this.evaluate(statement.test, env))) return null;
    const message =
      statement.message === null ? 'assertion fausse' : toStr(this.evaluate(statement.message, env));
    throwValue(makeError('AssertionError', message));
  }

  private execDel(statement: Extract<Stmt, { kind: 'del' }>, env: Environment): Signal | null {
    for (const target of statement.targets) {
      switch (target.kind) {
        case 'name': {
          if (!env.hasLocal(target.id)) {
            throwValue(makeError('NameError', `le nom '${target.id}' n'est pas defini`));
          }
          env.delete(target.id);
          break;
        }
        case 'index': {
          const container = this.evaluate(target.object, env);
          const index = this.evaluate(target.index, env);
          if (isList(container)) {
            const position = requireInteger(index, 'index de liste');
            const at = position < 0 ? position + container.length : position;
            if (at < 0 || at >= container.length) {
              throwValue(
                makeError('IndexError', `index de liste hors limites : ${position} (longueur ${container.length})`),
              );
            }
            container.splice(at, 1);
            break;
          }
          if (container instanceof UchiDict) {
            if (!container.delete(index)) {
              throwValue(makeError('KeyError', toRepr(index)));
            }
            break;
          }
          throwValue(
            makeError('TypeError', `'del' ne supporte pas l'indexation sur '${typeName(container)}'`),
          );
          break;
        }
        case 'attribute': {
          const object = this.evaluate(target.object, env);
          if (object instanceof UchiInstance) {
            if (!object.has(target.name)) {
              throwValue(
                makeError(
                  'AttributeError',
                  `l'objet de type '${object.klass.name}' n'a pas d'attribut '${target.name}'`,
                ),
              );
            }
            object.delete(target.name);
            break;
          }
          throwValue(
            makeError('TypeError', `'del' ne supporte pas les attributs sur '${typeName(object)}'`),
          );
          break;
        }
        default:
          throwValue(makeError('SyntaxError', `cible de 'del' non prise en charge (${target.kind})`));
      }
    }
    return null;
  }

  // ================================================================ affectation

  private readTarget(target: AssignTarget, env: Environment): UchiValue {
    switch (target.kind) {
      case 'name':
        return env.get(target.id);
      case 'index': {
        const container = this.evaluate(target.object, env);
        return this.getItemOf(container, this.evaluate(target.index, env));
      }
      case 'attribute': {
        const object = this.evaluate(target.object, env);
        return this.getAttribute(object, target.name);
      }
      default:
        return this.internalError(`lecture impossible depuis la cible '${target.kind}'`);
    }
  }

  assign(target: AssignTarget, value: UchiValue, env: Environment): void {
    switch (target.kind) {
      case 'name':
        env.assign(target.id, value);
        return;
      case 'index': {
        const container = this.evaluate(target.object, env);
        this.setItemOf(container, this.evaluate(target.index, env), value);
        return;
      }
      case 'attribute': {
        const object = this.evaluate(target.object, env);
        this.setAttribute(object, target.name, value);
        return;
      }
      case 'tuple':
      case 'list':
        this.assignUnpacked(target.elements, value, env);
        return;
      case 'star':
        throwValue(makeError('SyntaxError', "une cible '*' ne peut pas etre assignee directement"));
        return;
      default:
        this.internalError(`affectation impossible vers '${(target as AssignTarget).kind}'`);
    }
  }

  /** `a, *b, c = iterable`. */
  private assignUnpacked(elements: Expr[], value: UchiValue, env: Environment): void {
    const items = this.iterate(value);
    const starIndex = elements.findIndex((element) => element.kind === 'star');
    const targetCount = elements.length - (starIndex === -1 ? 0 : 1);

    if (starIndex === -1) {
      if (items.length !== targetCount) {
        throwValue(
          makeError(
            'ValueError',
            items.length < targetCount
              ? `valeur trop courte pour le depaquetage : ${items.length} valeur(s) pour ${targetCount} cible(s)`
              : `valeur trop longue pour le depaquetage : ${items.length} valeur(s) pour ${targetCount} cible(s)`,
          ),
        );
      }
      for (let i = 0; i < targetCount; i++) {
        this.assign(asTarget(elements[i] as Expr), items[i] as UchiValue, env);
      }
      return;
    }

    if (items.length < targetCount) {
      throwValue(
        makeError(
          'ValueError',
          `valeur trop courte pour le depaquetage : ${items.length} valeur(s) pour au moins ${targetCount} cible(s)`,
        ),
      );
    }
    const before = starIndex;
    const after = elements.length - starIndex - 1;
    for (let i = 0; i < before; i++) {
      this.assign(asTarget(elements[i] as Expr), items[i] as UchiValue, env);
    }
    const star = elements[starIndex] as Extract<Expr, { kind: 'star' }>;
    this.assign(asTarget(star.operand), items.slice(before, items.length - after), env);
    for (let i = 0; i < after; i++) {
      this.assign(
        asTarget(elements[starIndex + 1 + i] as Expr),
        items[items.length - after + i] as UchiValue,
        env,
      );
    }
  }

  // ================================================================ expressions

  evaluate(expression: Expr, env: Environment): UchiValue {
    switch (expression.kind) {
      case 'int':
      case 'float':
      case 'string':
      case 'bool':
        return expression.value;
      case 'none':
        return null;
      case 'fstring':
        return this.evaluateFString(expression.parts, env);
      case 'name':
        return env.get(expression.id);
      case 'list':
        return this.evaluateSequence(expression.elements, env);
      case 'comprehension':
        return this.evaluateComprehension(expression, env);
      case 'set':
        return new UchiSet(this.evaluateSequence(expression.elements, env));
      case 'tuple':
        return new UchiTuple(this.evaluateSequence(expression.elements, env));
      case 'dict': {
        const dict = new UchiDict();
        for (const entry of expression.entries) {
          dict.set(this.evaluate(entry.key, env), this.evaluate(entry.value, env));
        }
        return dict;
      }
      case 'unary':
        return unaryOp(expression.op, this.evaluate(expression.operand, env));
      case 'binary':
        return binaryOp(
          expression.op,
          this.evaluate(expression.left, env),
          this.evaluate(expression.right, env),
        );
      case 'comparison':
        return this.evaluateComparison(expression.operands, expression.ops, env);
      case 'logical': {
        const left = this.evaluate(expression.left, env);
        if (expression.op === 'and') {
          return truthy(left) ? this.evaluate(expression.right, env) : left;
        }
        return truthy(left) ? left : this.evaluate(expression.right, env);
      }
      case 'conditional':
        return truthy(this.evaluate(expression.test, env))
          ? this.evaluate(expression.consequent, env)
          : this.evaluate(expression.alternate, env);
      case 'lambda':
        return new UchiFunction('<lambda>', expression.params, [], env, false, expression.body);
      case 'call':
        return this.evaluateCall(expression.callee, expression.args, env);
      case 'attribute':
        return this.getAttribute(this.evaluate(expression.object, env), expression.name);
      case 'index':
        return this.getItemOf(
          this.evaluate(expression.object, env),
          this.evaluate(expression.index, env),
        );
      case 'slice': {
        const object = this.evaluate(expression.object, env);
        return this.sliceOf(
          object,
          expression.lower === null ? null : this.evaluate(expression.lower, env),
          expression.upper === null ? null : this.evaluate(expression.upper, env),
          expression.step === null ? null : this.evaluate(expression.step, env),
        );
      }
      case 'star':
      case 'double-star':
        throwValue(
          makeError(
            'SyntaxError',
            `'${expression.kind === 'star' ? '*' : '**'}' n'est valide que dans un appel ou un litteral`,
          ),
        );
        return null;
      default:
        return this.internalError(`expression non geree : ${(expression as Expr).kind}`);
    }
  }

  /** `[...]`, `(...)`, `{...}` : chaque element `*expr` etale son iterable. */
  private evaluateSequence(elements: Expr[], env: Environment): UchiValue[] {
    const out: UchiValue[] = [];
    for (const element of elements) {
      if (element.kind === 'star') {
        out.push(...this.iterate(this.evaluate(element.operand, env)));
        continue;
      }
      out.push(this.evaluate(element, env));
    }
    return out;
  }

  /**
   * Evalue une comprehension : liste, ensemble ou dictionnaire.
   *
   * Chaque `for` ouvre une portee qui contient les variables de la precedente,
   * comme le ferait une fonction imbriquee. Les filtres `if` sont appliques
   * dans l'ordre, avant l'element produit.
   */
  private evaluateComprehension(expression: ComprehensionExpr, env: Environment): UchiValue {
    const results: UchiValue[] = [];
    const entries: Array<[UchiValue, UchiValue]> = [];
    let produced = 0;

    const step = (clauseIndex: number, scope: Environment): void => {
      if (clauseIndex === expression.clauses.length) {
        produced++;
        if (produced > this.maxLoopIterations) {
          throwValue(
            makeError(
              'RuntimeError',
              `comprehension : nombre d'elements maximal atteint (${this.maxLoopIterations})`,
            ),
          );
        }
        if (expression.valueElement !== null) {
          entries.push([this.evaluate(expression.element, scope), this.evaluate(expression.valueElement, scope)]);
        } else {
          results.push(this.evaluate(expression.element, scope));
        }
        return;
      }
      const clause = expression.clauses[clauseIndex] as ComprehensionClause;
      if (clause.kind === 'if') {
        if (truthy(this.evaluate(clause.condition, scope))) step(clauseIndex + 1, scope);
        return;
      }
      const iterable = this.evaluate(clause.iterable, scope);
      for (const item of this.iterate(iterable)) {
        const inner = new Environment(scope);
        // Les cibles sont definies localement : une comprehension ne doit pas
        // modifier les variables de la portee englobante.
        this.defineLocally(clause.target as AssignTarget, item, inner);
        step(clauseIndex + 1, inner);
      }
    };

    step(0, env);

    if (expression.asSet) return new UchiSet(results);
    if (expression.valueElement !== null) {
      const dict = new UchiDict();
      for (const [key, value] of entries) dict.set(key, value);
      return dict;
    }
    return results;
  }

  /**
   * Affectation qui cree toujours une liaison locale.
   *
   * `Environment.assign` ecrit dans la premiere portee qui connait deja le nom,
   * ce qui convient a une instruction ordinaire mais pas a une comprehension :
   * la variable de boucle doit disparaitre avec la portee qui la contient.
   */
  private defineLocally(target: AssignTarget, value: UchiValue, env: Environment): void {
    switch (target.kind) {
      case 'name':
        env.define(target.id, value);
        return;
      case 'tuple':
      case 'list': {
        const elements = target.elements;
        const items = this.iterate(value);
        const starIndex = elements.findIndex((element) => element.kind === 'star');
        if (starIndex === -1) {
          if (items.length !== elements.length) {
            throwValue(
              makeError(
                'ValueError',
                items.length < elements.length
                  ? `valeur trop courte pour le depaquetage : ${items.length} valeur(s) pour ${elements.length} cible(s)`
                  : `valeur trop longue pour le depaquetage : ${items.length} valeur(s) pour ${elements.length} cible(s)`,
              ),
            );
          }
          for (let i = 0; i < elements.length; i++) {
            this.defineLocally(asTarget(elements[i] as Expr), items[i] as UchiValue, env);
          }
          return;
        }
        const fixed = elements.length - 1;
        if (items.length < fixed) {
          throwValue(
            makeError(
              'ValueError',
              `valeur trop courte pour le depaquetage : ${items.length} valeur(s) pour au moins ${fixed} cible(s)`,
            ),
          );
        }
        for (let i = 0; i < starIndex; i++) {
          this.defineLocally(asTarget(elements[i] as Expr), items[i] as UchiValue, env);
        }
        // Ce qui suit l'etoile est alimente depuis la fin, comme en Python.
        for (let i = starIndex + 1; i < elements.length; i++) {
          this.defineLocally(
            asTarget(elements[i] as Expr),
            items[items.length - (elements.length - i)] as UchiValue,
            env,
          );
        }
        const starred = asTarget(elements[starIndex] as Expr);
        if (starred.kind === 'star' && starred.operand.kind === 'name') {
          env.define(starred.operand.id, [
            ...items.slice(starIndex, items.length - fixed + starIndex),
          ]);
          return;
        }
        this.assign(starred, items[starIndex] as UchiValue, env);
        return;
      }
      case 'index':
      case 'attribute':
        // Ces cibles ne creent aucun nom : une affectation ordinaire convient.
        this.assign(target, value, env);
        return;
      default:
        this.internalError(`cible d'affectation non geree : '${(target as AssignTarget).kind}'`);
    }
  }

  private evaluateFString(parts: FStringPart[], env: Environment): string {
    let out = '';
    for (const part of parts) {
      if (part.kind === 'text') {
        out += part.value;
        continue;
      }
      const value = this.evaluate(part.expression, env);
      // `f"{x=}"` restitue le texte source de l'expression avant la valeur.
      if (part.debug !== undefined) out += part.debug;
      // Le defaut de l'expression auto-documentee est `repr` ; la presence
      // d'un gabarit le ramene a `str`, comme dans CPython.
      const conversion =
        part.conversion ??
        (part.debug !== undefined && part.spec === undefined ? 'r' : undefined);

      // Une conversion explicite produit une chaine, que le gabarit formate
      // ensuite : `f"{x=!r:^20}"` centre la representation, pas la valeur.
      if (conversion === 'r' || conversion === 'a' || conversion === 's') {
        const text =
          conversion === 's' ? this.toDisplayString(value) : this.toInspectString(value);
        out += part.spec !== undefined && part.spec !== '' ? applyFormat(text, part.spec) : text;
        continue;
      }
      // Sans conversion, le gabarit s'applique directement a la valeur.
      if (part.spec !== undefined) {
        out += applyFormat(value, part.spec);
        continue;
      }
      out += this.toDisplayString(value);
    }
    return out;
  }

  private evaluateComparison(operands: Expr[], ops: ComparisonOp[], env: Environment): boolean {
    for (let i = 0; i < ops.length; i++) {
      const left = this.evaluate(operands[i] as Expr, env);
      const right = this.evaluate(operands[i + 1] as Expr, env);
      if (!this.compareOne(ops[i] as ComparisonOp, left, right)) return false;
    }
    return true;
  }

  private compareOne(op: ComparisonOp, left: UchiValue, right: UchiValue): boolean {
    switch (op) {
      case '==':
        return equals(left, right);
      case '!=':
        return !equals(left, right);
      case 'is':
        return left === right;
      case 'is not':
        return left !== right;
      case 'in':
        return this.containsValue(right, left);
      case 'not in':
        return !this.containsValue(right, left);
      case '<':
        return compare(left, right) < 0;
      case '<=':
        return compare(left, right) <= 0;
      case '>':
        return compare(left, right) > 0;
      case '>=':
        return compare(left, right) >= 0;
      default:
        return this.internalError(`comparaison inconnue '${op}'`);
    }
  }

  // ==================================================================== appels

  private evaluateCall(calleeExpression: Expr, args: Argument[], env: Environment): UchiValue {
    const callee = this.evaluate(calleeExpression, env);
    const evaluated = this.evaluateArguments(args, env);
    return this.callValue(callee, evaluated.positional, evaluated.keyword);
  }

  private evaluateArguments(args: Argument[], env: Environment): NativeCallArgs {
    const positional: UchiValue[] = [];
    const keyword = new Map<string, UchiValue>();

    for (const argument of args) {
      switch (argument.kind) {
        case 'positional':
          positional.push(this.evaluate(argument.value, env));
          break;
        case 'keyword':
          if (keyword.has(argument.name)) {
            throwValue(
              makeError('SyntaxError', `argument nomme '${argument.name}' fourni plusieurs fois`),
            );
          }
          keyword.set(argument.name, this.evaluate(argument.value, env));
          break;
        case 'star':
          for (const item of this.iterate(this.evaluate(argument.value, env))) positional.push(item);
          break;
        case 'double-star': {
          const mapping = this.evaluate(argument.value, env);
          if (!(mapping instanceof UchiDict)) {
            throwValue(
              makeError('TypeError', `'**' attend un dictionnaire, recu '${typeName(mapping)}'`),
            );
          }
          for (const [key, value] of mapping.entriesIterator()) {
            if (typeof key !== 'string') {
              throwValue(
                makeError('TypeError', `les cles de '**' doivent etre des chaines, recu '${typeName(key)}'`),
              );
            }
            keyword.set(key, value);
          }
          break;
        }
      }
    }
    return { positional, keyword };
  }

  /** Point d'entree unique pour tout appel. */
  callValue(
    callee: UchiValue,
    positional: UchiValue[] = [],
    keyword: Map<string, UchiValue> = new Map(),
  ): UchiValue {
    if (callee instanceof UchiNativeFunction) {
      return this.runNative(callee, positional, keyword);
    }
    if (callee instanceof UchiBoundMethod) {
      return this.invokeFunction(callee.fn, [callee.receiver, ...positional], keyword, {
        classContext: callee.ownerClass,
        self: callee.receiver,
      });
    }
    if (callee instanceof UchiFunction) {
      return this.invokeFunction(callee, positional, keyword, { classContext: null, self: null });
    }
    if (callee instanceof UchiClass) {
      return this.instantiate(callee, { positional, keyword });
    }
    if (callee instanceof UchiInstance) {
      // `instance(...)` appelle `type(instance).__call__(instance, ...)`.
      const own = callee.get('__call__');
      if (own !== undefined) {
        return this.callValue(this.bind(callee, own, callee.klass), positional, keyword);
      }
      const call = this.callProtocol(callee, '__call__', positional, keyword);
      if (call !== undefined) return call;
    }
    throwValue(
      makeError('TypeError', `'${typeName(callee)}' n'est pas appelable : parentheses oubliees ?`),
    );
  }

  private invokeFunction(
    fn: UchiFunction,
    positional: UchiValue[],
    keyword: Map<string, UchiValue>,
    context: { classContext: UchiClass | null; self: UchiValue | null },
  ): UchiValue {
    if (this.frames.length >= this.maxCallDepth) {
      throwValue(
        makeError(
          'RecursionError',
          `profondeur d'appels maximale atteinte (${this.maxCallDepth}) : recursion infinie ?`,
        ),
      );
    }

    const callEnv = new Environment(fn.closure);
    this.bindParameters(fn, positional, keyword, callEnv);

    if (fn.lambdaBody !== null) {
      return this.evaluate(fn.lambdaBody, callEnv);
    }

    this.frames.push({ name: fn.name, classContext: context.classContext, self: context.self, line: 0 });
    try {
      const signal = this.execBlock(fn.body, callEnv);
      return signal instanceof ReturnSignal ? signal.value : null;
    } finally {
      // Le retrait est garanti meme en cas d'exception : la pile reste coherente
      // pour le code de traitement d'erreur.
      this.frames.pop();
    }
  }

  /** Repartit les arguments entre positionnels, `*args` et `**kwargs`. */
  private bindParameters(
    fn: UchiFunction,
    positional: UchiValue[],
    keyword: Map<string, UchiValue>,
    callEnv: Environment,
  ): void {
    const positionalParams: Array<{ name: string; default: Expr | undefined; positionalOnly: boolean }> = [];
    const keywordOnlyParams: Array<{ name: string; default: Expr | undefined }> = [];
    let varArgs: string | null = null;
    let varKeywords: string | null = null;
    let afterStar = false;
    // `false` tant qu'aucun `/` n'est rencontre : par defaut, un parametre peut
    // etre designe par son nom.
    let onlyPositional = false;

    for (const param of fn.params) {
      if (param.isPosOnlyMarker === true) {
        // `/` clot la section positionnelle : les parametres deja collected ne
        // sont plus designables par leur nom, ceux qui suivent le restent.
        for (const slot of positionalParams) slot.positionalOnly = true;
        onlyPositional = false;
        continue;
      }
      if (param.isKeywordOnlyMarker === true) {
        afterStar = true;
        continue;
      }
      if (param.isVarArg === true) {
        varArgs = param.name;
        afterStar = true;
        continue;
      }
      if (param.isDoubleVarArg === true) {
        varKeywords = param.name;
        continue;
      }
      // `*` est le seul separateur qui distingue les deux familles : tout ce
      // qui le suit ne peut plus etre passe par position.
      if (afterStar) keywordOnlyParams.push({ name: param.name, default: param.default });
      else positionalParams.push({ name: param.name, default: param.default, positionalOnly: onlyPositional });
    }

    if (positional.length > positionalParams.length && varArgs === null) {
      throwValue(
        makeError(
          'TypeError',
          `${fn.name}() attend ${positionalParams.length} argument(s) positionnel(s) mais ${positional.length} ont ete passes`,
        ),
      );
    }

    const remaining = new Map(keyword);
    const missing: string[] = [];
    let index = 0;

    for (const slot of positionalParams) {
      if (index < positional.length) {
        // Python refuse qu'un parametre deja rempli par position recoive aussi
        // une valeur nommee.
        if (remaining.has(slot.name)) {
          throwValue(
            makeError(
              'TypeError',
              `${fn.name}() recoit plusieurs valeurs pour l'argument '${slot.name}'`,
            ),
          );
        }
        callEnv.define(slot.name, positional[index] as UchiValue);
        index++;
        continue;
      }
      // Un parametre precede de `/` ne peut pas etre designe par son nom.
      if (!slot.positionalOnly && remaining.has(slot.name)) {
        callEnv.define(slot.name, remaining.get(slot.name) as UchiValue);
        remaining.delete(slot.name);
        continue;
      }
      if (slot.default !== undefined) {
        // Les valeurs par defaut sont evaluees dans la portee de definition.
        callEnv.define(slot.name, this.evaluate(slot.default, fn.closure));
        continue;
      }
      missing.push(slot.name);
    }

    if (varArgs !== null) {
      callEnv.define(varArgs, positional.slice(index));
      index = positional.length;
    }

    // Les parametres nommes seulement sont pris avant `**kwargs` : sinon ils
    // seraient absorbes par le dictionnaire d'arguments supplementaires.
    for (const slot of keywordOnlyParams) {
      if (remaining.has(slot.name)) {
        callEnv.define(slot.name, remaining.get(slot.name) as UchiValue);
        remaining.delete(slot.name);
        continue;
      }
      if (slot.default !== undefined) {
        callEnv.define(slot.name, this.evaluate(slot.default, fn.closure));
        continue;
      }
      missing.push(slot.name);
    }

    if (varKeywords !== null) {
      const collected = new UchiDict();
      for (const [key, value] of remaining) collected.set(key, value);
      remaining.clear();
      callEnv.define(varKeywords, collected);
    }

    // Python signale d'abord les arguments nommes connus mais reserves a la
    // position, puis les noms inconnus, et seulement ensuite les manques.
    const positionalOnlyNames = new Set(
      positionalParams.filter((slot) => slot.positionalOnly).map((slot) => slot.name),
    );
    const reserved = [...remaining.keys()].filter((name) => positionalOnlyNames.has(name));
    if (reserved.length > 0) {
      const names = reserved.map((name) => `'${name}'`).join(', ');
      throwValue(
        makeError(
          'TypeError',
          reserved.length === 1
            ? `${fn.name}() : le parametre ${names} est positionnel et ne peut pas etre nomme`
            : `${fn.name}() : les parametres ${names} sont positionnels et ne peuvent pas etre nommes`,
        ),
      );
    }
    if (remaining.size > 0) {
      throwValue(
        makeError(
          'TypeError',
          `${fn.name}() : argument(s) nomme(s) inattendu(s) : ${[...remaining.keys()].join(', ')}`,
        ),
      );
    }
    if (missing.length > 0) {
      throwValue(
        makeError('TypeError', `${fn.name}() : argument(s) manquant(s) : ${missing.join(', ')}`),
      );
    }
  }

  /** Instancie une classe : `Classe(...)`. */
  instantiate(klass: UchiClass, args: NativeCallArgs): UchiValue {
    // Les types integres (`int`, `list`, ...) convertissent au lieu de
    // construire une instance : `list([1, 2])` renvoie bien une liste.
    if (klass.converter !== null) {
      try {
        return klass.converter(args, this);
      } catch (error) {
        if (error instanceof UchiThrow) throw error;
        if (error instanceof UchiError) throwValue(error);
        throw error;
      }
    }

    const instance = new UchiInstance(klass);
    const init = klass.lookup('__init__');
    if (init === undefined) {
      // Une exception se construit avec ses arguments, comme en Python :
      // `ValueError('message')` range le message dans `args`.
      if (this.isExceptionClass(klass)) {
        instance.set('args', [...args.positional, ...args.keyword.values()]);
        return instance;
      }
      if (args.positional.length > 0 || args.keyword.size > 0) {
        throwValue(
          makeError('TypeError', `${klass.name}() n'accepte aucun argument : __init__ n'est pas defini`),
        );
      }
      return instance;
    }
    if (!(init instanceof UchiFunction)) {
      throwValue(makeError('TypeError', `'__init__' de '${klass.name}' n'est pas une fonction`));
    }
    // `__init__` est une methode : l'instance est liee en premier argument,
    // exactement comme lors d'un acces a `instance.__init__`.
    const result = this.callValue(new UchiBoundMethod(instance, init, klass), args.positional, args.keyword);
    if (result !== null) {
      throwValue(makeError('TypeError', `'__init__' de '${klass.name}' doit renvoyer None`));
    }
    return instance;
  }

  // ================================================================ attributs

  getAttribute(target: UchiValue, name: string): UchiValue {
    if (target instanceof UchiSuper) return this.superAttribute(target, name);

    if (target instanceof UchiInstance) {
      const own = target.get(name);
      if (own !== undefined) return own;
      const member = target.klass.lookup(name);
      if (member !== undefined) return this.bind(target, member, target.klass);
      // `x.__class__` existe toujours, comme en Python.
      if (name === '__class__') return target.klass;
      return this.missingAttribute(target.klass.name, name);
    }

    if (target instanceof UchiClass) {
      if (name === '__name__') return target.name;
      const member = target.lookup(name);
      if (member !== undefined) return member;
      const builtin = this.builtinMember(target, name);
      if (builtin !== undefined) return builtin;
      return this.missingAttribute(target.name, name);
    }

    if (target instanceof UchiModule) {
      const member = target.get(name);
      if (member !== undefined) return member;
      if (name === '__name__') return target.name;
      return this.missingAttribute(`module '${target.name}'`, name);
    }

    if (target instanceof UchiError) {
      if (name === 'name') return target.name;
      if (name === 'message') return target.message;
      if (name === 'args') return target.args;
      return this.missingAttribute('exception', name);
    }

    if (target === null) {
      // `None` n'a aucun attribut propre, mais repond a `__class__`.
      if (name !== '__class__') {
        throwValue(makeError('AttributeError', `'None' n'a pas d'attribut '${name}'`));
      }
    }

    if (target instanceof UchiFunction || target instanceof UchiNativeFunction) {
      if (name === '__name__') return target.name;
      return this.missingAttribute('function', name);
    }

    const builtin = this.builtinMember(target, name);
    if (builtin !== undefined) return builtin;
    const protocol = this.protocolMember(target, name);
    if (protocol !== undefined) return protocol;
    return this.missingAttribute(typeName(target), name);
  }

  setAttribute(target: UchiValue, name: string, value: UchiValue): void {
    if (target instanceof UchiInstance) {
      target.set(name, value);
      return;
    }
    if (target instanceof UchiClass) {
      target.set(name, value);
      return;
    }
    if (target instanceof UchiModule) {
      target.set(name, value);
      return;
    }
    throwValue(
      makeError('AttributeError', `impossible de definir l'attribut '${name}' sur '${typeName(target)}'`),
    );
  }

  /**
   * Attribut obtenu via `super()`. La classe courante est exclue de la
   * recherche, qui commence par sa classe de base.
   */
  private superAttribute(superValue: UchiSuper, name: string): UchiValue {
    const member = superValue.after.lookup(name);
    if (member !== undefined) return this.bind(superValue.receiver, member, superValue.after);
    if (superValue.receiver instanceof UchiInstance) {
      const own = superValue.receiver.get(name);
      if (own !== undefined) return own;
    }
    throwValue(
      makeError(
        'AttributeError',
        `'${superValue.currentClass.name}' n'a pas d'attribut '${name}' dans ses classes de base`,
      ),
    );
  }

  /**
   * Execute une fonction native.
   *
   * Les codes natifs signalent une erreur en `levant` simplement un `UchiError`
   * (et non un `UchiThrow`), ce qui est plus pratique a ecrire. On convertit
   * ici ces deux representations en une seule, sinon `try/except` n'attraperait
   * jamais les erreurs natives. Les `UchiThrow` deja construits sont laisses
   * tels quels pour que `raise` garde son fonctionnement.
   */
  private runNative(
    callee: UchiNativeFunction,
    positional: UchiValue[],
    keyword: Map<string, UchiValue>,
  ): UchiValue {
    try {
      return callee.body({ positional, keyword }, this);
    } catch (error) {
      if (error instanceof UchiThrow) throw error;
      if (error instanceof UchiError) throwValue(error);
      throw error;
    }
  }

  /** Lie une fonction a un recepteur : `instance.methode` devient appelable. */
  private bind(receiver: UchiValue, member: UchiValue, owner: UchiClass): UchiValue {
    if (member instanceof UchiFunction && member.isMethod) {
      return new UchiBoundMethod(receiver, member, owner);
    }
    if (member instanceof UchiNativeFunction) {
      // Les methodes natives declarees sur une classe (`File`, iterateurs)
      // attendent elles aussi le recepteur en premier argument.
      const native = member;
      return new UchiNativeFunction(member.name, (args, ctx) =>
        native.body({ positional: [receiver, ...args.positional], keyword: args.keyword }, ctx),
      );
    }
    return member;
  }

  private missingAttribute(typeLabel: string, name: string): never {
    throwValue(
      makeError('AttributeError', `l'objet de type '${typeLabel}' n'a pas d'attribut '${name}'`),
    );
  }

  /**
   * Methodes natives des types de base : `"abc".upper()`, `[].append(1)`, et
   * aussi `str.upper("abc")` ou l'on designe explicitement le type.
   */
  private builtinMember(target: UchiValue, name: string): UchiValue | undefined {
    const table = this.methodTableFor(target);
    if (table === null) return undefined;
    const body = table.get(name);
    if (body === undefined) return undefined;
    return new UchiNativeFunction(name, (args, ctx) =>
      body({ positional: [target, ...args.positional], keyword: args.keyword }, ctx),
    );
  }

  /**
   * Crochets de protocole lisibles sur les valeurs natives, comme en Python :
   * `len([])`, `[].__len__()` et `len(x.__len__())` concordent.
   *
   * Seuls les types integres sont concernes : pour une instance, un dunder
   * absent doit lever `AttributeError`.
   */
  private protocolMember(target: UchiValue, name: string): UchiValue | undefined {
    const member = (body: (...args: UchiValue[]) => UchiValue): UchiValue =>
      new UchiNativeFunction(name, (args) => body(...args.positional));
    const ordering = (op: string) => (other: UchiValue = null) => {
      const result = compare(target, other);
      if (op === '<') return result === -1;
      if (op === '<=') return result <= 0;
      if (op === '>') return result === 1;
      return result >= 0;
    };
    const binary = (op: string) => (other: UchiValue = null) => binaryOp(op, target, other);

    switch (name) {
      case '__class__':
        return builtinTypeClass(classNameOf(target)) ?? (this.builtinsEnv.get('object') as UchiValue);
      case '__len__':
        return member(() => length(target));
      case '__str__':
        return member(() => this.toDisplayString(target));
      case '__repr__':
        return member(() => this.toInspectString(target));
      case '__iter__':
        return member(() => createIterator(this.iterate(target)));
      case '__bool__':
        return member(() => truthy(target));
      case '__contains__':
        return member((element) => contains(target, element));
      case '__getitem__':
        return member((index) => this.getItemOf(target, index));
      case '__setitem__':
        return member((index, value) => {
          this.setItemOf(target, index, value);
          return null;
        });
      case '__eq__':
        return member((other) => equals(target, other));
      case '__ne__':
        return member((other) => !equals(target, other));
      case '__lt__':
        return member(ordering('<'));
      case '__le__':
        return member(ordering('<='));
      case '__gt__':
        return member(ordering('>'));
      case '__ge__':
        return member(ordering('>='));
      case '__add__':
        return member(binary('+'));
      case '__sub__':
        return member(binary('-'));
      case '__mul__':
        return member(binary('*'));
      case '__truediv__':
        return member(binary('/'));
      case '__floordiv__':
        return member(binary('//'));
      case '__mod__':
        return member(binary('%'));
      case '__pow__':
        return member(binary('**'));
      case '__neg__':
        return member(() => unaryOp('-', target));
      case '__pos__':
        return member(() => unaryOp('+', target));
      case '__abs__':
        return member(() => Math.abs(this.asNumberForDunder(target)));
      default:
        return undefined;
    }
  }

  private asNumberForDunder(value: UchiValue): number {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value !== 'number') {
      throw makeError('TypeError', `abs() attend un nombre, recu ${typeName(value)}`);
    }
    return value;
  }

  private methodTableFor(target: UchiValue): MethodTable | null {
    if (typeof target === 'string') return STRING_METHODS;
    if (isList(target)) return LIST_METHODS;
    if (target instanceof UchiDict) return DICT_METHODS;
    if (target instanceof UchiSet) return SET_METHODS;
    if (target instanceof UchiTuple) return TUPLE_METHODS;
    if (target instanceof UchiRange) return RANGE_METHODS;
    if (target instanceof UchiClass) return classMethodTable(target.name);
    return null;
  }

  // ================================================================= protocole

  /**
   * Cherche un crochet de protocole (`__iter__`, `__len__`, `__getitem__`, ...)
   * et l'appelle en passant l'instance comme recepteur. Les methodes natives
   * posees sur une classe (iterateurs integres par exemple) sont acceptees au
   * meme titre que les methodes ecrites en Uchi. Renvoie `undefined` quand le
   * crochet n'existe pas, afin que l'appelant bascule sur son comportement
   * standard.
   */
  private callProtocol(
    receiver: UchiInstance,
    name: string,
    args: UchiValue[] = [],
    keyword: Map<string, UchiValue> = new Map(),
  ): UchiValue | undefined {
    const member = receiver.klass.lookup(name);
    if (member === undefined) return undefined;
    if (member instanceof UchiFunction || member instanceof UchiNativeFunction) {
      return this.callValue(this.bind(receiver, member, receiver.klass), args, keyword);
    }
    throwValue(
      makeError('TypeError', `'${name}' de '${receiver.klass.name}' n'est pas une methode`),
    );
  }

  /** `repr()` personnalise, fourni a `operations.ts`. */
  private customReprOf(value: UchiValue): string | null {
    if (!(value instanceof UchiInstance)) return null;
    const repr = this.callProtocol(value, '__repr__');
    if (repr !== undefined) return toStr(repr);
    const text = this.exceptionText(value);
    if (text !== null) return `${value.klass.name}(${toRepr(text)})`;
    return null;
  }

  toDisplayString(value: UchiValue): string {
    if (value instanceof UchiInstance) {
      const str = this.callProtocol(value, '__str__');
      if (str !== undefined) return toStr(str);
      const text = this.exceptionText(value);
      if (text !== null) return text;
    }
    return toStr(value);
  }

  toInspectString(value: UchiValue): string {
    if (value instanceof UchiInstance) {
      const repr = this.customReprOf(value);
      if (repr !== null) return repr;
    }
    return toRepr(value);
  }

  /** Iteration en tenant compte de `__iter__` et `__next__`. */
  iterate(value: UchiValue): UchiValue[] {
    if (value instanceof UchiInstance) return this.iterateInstance(value);
    if (isIterable(value)) return iterate(value);
    throwValue(makeError('TypeError', `'${typeName(value)}' n'est pas iterable`));
  }

  /**
   * Iteration d'un objet personnalise. `__iter__` peut renvoyer l'objet
   * lui-meme (iterateur) ou un autre objet ; a defaut, la presence de
   * `__next__` suffit a faire de l'objet un iterateur.
   */
  private iterateInstance(value: UchiInstance): UchiValue[] {
    const iterable = this.callProtocol(value, '__iter__');
    if (iterable !== undefined) {
      if (iterable === value) return this.drainIterator(value);
      if (iterable instanceof UchiInstance) return this.iterateInstance(iterable);
      if (isList(iterable) || isIterable(iterable)) return iterate(iterable);
      throwValue(makeError('TypeError', `'__iter__' doit renvoyer un objet iterable`));
    }
    if (value.klass.lookup('__next__') !== undefined) return this.drainIterator(value);
    throwValue(makeError('TypeError', `'${typeName(value)}' n'est pas iterable`));
  }

  /** Consomme un iterateur tant que `__next__` ne leve pas `StopIteration`. */
  private drainIterator(iterator: UchiInstance): UchiValue[] {
    const out: UchiValue[] = [];
    for (;;) {
      if (out.length >= this.maxLoopIterations) {
        this.internalError('iteration trop longue : StopIteration attendu');
      }
      try {
        out.push(this.callProtocol(iterator, '__next__') as UchiValue);
      } catch (error) {
        if (error instanceof UchiThrow && this.errorMatches(this.asException(error.value), 'StopIteration')) {
          return out;
        }
        throw error;
      }
    }
  }

  /**
   * `next(iterateur[, defaut])`. Le second argument est distingue de sa seule
   * absence par `hasDefault`, car `None` est une valeur de retour legitime.
   */
  nextOf(iterator: UchiValue, hasDefault: boolean, fallback: UchiValue): UchiValue {
    if (
      !(iterator instanceof UchiInstance) ||
      iterator.klass.lookup('__next__') === undefined
    ) {
      if (hasDefault) return fallback;
      throwValue(makeError('TypeError', `'${typeName(iterator)}' n'est pas un iterateur`));
    }
    try {
      return this.callProtocol(iterator, '__next__') as UchiValue;
    } catch (error) {
      if (error instanceof UchiThrow && this.errorMatches(this.asException(error.value), 'StopIteration')) {
        if (hasDefault) return fallback;
      }
      throw error;
    }
  }

  lengthOf(value: UchiValue): number {
    if (value instanceof UchiInstance) {
      const result = this.callProtocol(value, '__len__');
      if (result !== undefined) {
        if (typeof result === 'number' && Number.isInteger(result) && result >= 0) return result;
        throwValue(makeError('TypeError', `'__len__' doit renvoyer un entier positif ou nul`));
      }
    }
    if (isSized(value)) return length(value);
    throwValue(makeError('TypeError', `l'objet de type '${typeName(value)}' n'a pas de longueur`));
  }

  getItemOf(target: UchiValue, index: UchiValue): UchiValue {
    if (target instanceof UchiInstance) {
      const result = this.callProtocol(target, '__getitem__', [index]);
      if (result !== undefined) return result;
    }
    return getItem(target, index);
  }

  setItemOf(target: UchiValue, index: UchiValue, value: UchiValue): void {
    if (target instanceof UchiInstance) {
      if (this.callProtocol(target, '__setitem__', [index, value]) !== undefined) return;
    }
    setItem(target, index, value);
  }

  /** `element in container`, avec `__contains__` prioritaire sur `__iter__`. */
  containsValue(container: UchiValue, element: UchiValue): boolean {
    if (container instanceof UchiInstance) {
      const result = this.callProtocol(container, '__contains__', [element]);
      if (result !== undefined) return truthy(result);
      return this.iterate(container).some((entry) => equals(entry, element));
    }
    return contains(container, element);
  }

  /** Tranche, y compris via `__getitem__` sur un objet personnalise. */
  sliceOf(
    target: UchiValue,
    lower: UchiValue | null,
    upper: UchiValue | null,
    step: UchiValue | null,
  ): UchiValue {
    if (target instanceof UchiInstance) {
      const result = this.callProtocol(target, '__getitem__', [new UchiTuple([lower, upper, step])]);
      if (result !== undefined) return result;
    }
    return makeSlice(target, lower, upper, step);
  }

  throwError(name: string, message: string): never {
    throwValue(makeError(name, message));
  }

  /** Construit l'objet renvoye par le builtin `super()`. */
  makeSuper(): UchiSuper {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined || frame.classContext === null || frame.self === null) {
      throwValue(
        makeError('RuntimeError', `'super' n'est utilisable qu'a l'interieur d'une methode de classe`),
      );
    }
    return new UchiSuper(frame.self, frame.classContext);
  }

  // ============================================================== surcharges

  /**
   * Surcharge d'un operateur binaire (`+`, `-`, ...).
   *
   * Renvoie `undefined` si aucune classe ne definit le crochet : le
   * comportement standard reprend alors la main.
   */
  /** `true` si la classe derive de `BaseException`. */
  private isExceptionClass(klass: UchiClass): boolean {
    const base = errorClassByName('BaseException');
    return base !== undefined && klass.isSubclassOf(base);
  }

  /** Classe d'exception predefinie correspondant a un nom, si elle existe. */
  lookupBuiltinClass(name: string): UchiClass | undefined {
    return errorClassByName(name);
  }

  /**
   * Message d'une exception construite par l'utilisateur.
   *
   * Un seul argument est affiche tel quel ; plusieurs forment un tuple, comme
   * le fait `str(Exception(1, 2))` en Python.
   */
  private exceptionText(value: UchiInstance): string | null {
    if (!this.isExceptionClass(value.klass)) return null;
    const args = value.get('args');
    if (args === undefined || !isList(args) || args.length === 0) return '';
    if (args.length === 1) return toStr(args[0] as UchiValue);
    return `(${args.map(toRepr).join(', ')})`;
  }

  private overrideBinary(op: string, left: UchiValue, right: UchiValue): UchiValue | undefined {
    const direct = BINARY_DUNDERS[op];
    if (left instanceof UchiInstance && direct !== undefined) {
      const result = this.callProtocol(left, direct, [right]);
      if (result !== undefined) return result;
    }
    const reflected = REFLECTED_DUNDERS[op];
    if (right instanceof UchiInstance && reflected !== undefined) {
      const result = this.callProtocol(right, reflected, [left]);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /** Surcharge des comparaisons orderes (`<`, `<=`, `>`, `>=`). */
  private overrideCompare(op: string, left: UchiValue, right: UchiValue): Ordering | undefined {
    const direct = COMPARISON_DUNDERS[op];
    if (direct !== undefined && left instanceof UchiInstance) {
      const result = this.callProtocol(left, direct, [right]);
      if (result !== undefined) return truthy(result) ? -1 : 1;
    }
    const reflected = REFLECTED_COMPARISON_DUNDERS[op];
    if (reflected !== undefined && right instanceof UchiInstance) {
      const result = this.callProtocol(right, reflected, [left]);
      if (result !== undefined) return truthy(result) ? 1 : -1;
    }
    return undefined;
  }

  /** Surcharge de l'egalite : `__eq__`, et `__ne__` par defaut. */
  private overrideEquals(left: UchiValue, right: UchiValue): boolean | undefined {
    if (left instanceof UchiInstance) {
      const result = this.callProtocol(left, '__eq__', [right]);
      if (result !== undefined) return truthy(result);
      if (left.klass.lookup('__ne__') !== undefined) {
        return !truthy(this.callProtocol(left, '__ne__', [right]) as UchiValue);
      }
      return undefined;
    }
    if (right instanceof UchiInstance) {
      const result = this.callProtocol(right, '__eq__', [left]);
      if (result !== undefined) return truthy(result);
    }
    return undefined;
  }

  // ==================================================================== imports

  private execImport(modulePath: string, alias: string | null, env: Environment): Signal | null {
    // `import a.b` charge toute la chaine et expose chaque niveau comme attribut
    // du niveau parent, afin que `a.b` soit utilisable apres l'import. Sans
    // alias, Python lie la racine (`a`) ; avec `as`, c'est la feuille (`a.b`).
    const parts = modulePath.split('.');
    let path = '';
    let parent: UchiModule | null = null;
    let root: UchiModule | null = null;
    for (const part of parts) {
      path = path === '' ? part : `${path}.${part}`;
      const module = this.moduleLoader.load(path);
      if (parent !== null) parent.set(part, module);
      parent = module;
      if (root === null) root = module;
    }
    const firstSegment = parts[0] as string;
    env.define(alias ?? firstSegment, (alias === null ? root : parent) as UchiModule);
    return null;
  }

  private execImportFrom(
    statement: Extract<Stmt, { kind: 'import-from' }>,
    env: Environment,
  ): Signal | null {
    const module = this.moduleLoader.load(statement.module);
    if (statement.wildcard) {
      for (const name of module.names()) {
        const value = module.get(name);
        if (value !== undefined) env.define(name, value);
      }
      return null;
    }
    for (const { name, alias } of statement.names) {
      const value = module.get(name);
      if (value === undefined) {
        throwValue(
          makeError('ImportError', `le module '${statement.module}' n'expose pas '${name}'`),
        );
      }
      env.define(alias ?? name, value);
    }
    return null;
  }

  // =================================================================== interne

  private internalError(message: string): never {
    throwValue(new UchiError('InternalError', message, { isInternal: true }));
  }
}

// ==================================================================== utilitaires

/**
 * Normalise une exception JavaScript en `UchiThrow`.
 *
 * Les codes natifs, et quelques operations de bas niveau, signalent une erreur
 * en levant directement un `UchiError` plutot qu'un `UchiThrow`. Ces deux
 * formes doivent pouvoir etre rattrapees par `except`, sinon la propagation
 * differerait selon l'origine de l'erreur. Les autres erreurs sont relancees
 * telles quelles : elles signalent un defaut du runtime.
 */
function asThrow(error: unknown): UchiThrow {
  if (error instanceof UchiThrow) return error;
  if (error instanceof UchiError) return new UchiThrow(error);
  throw error;
}

/** Crochet appele pour un operateur binaire ecrit devant. */
const BINARY_DUNDERS: Readonly<Record<string, string>> = {
  '+': '__add__',
  '-': '__sub__',
  '*': '__mul__',
  '/': '__truediv__',
  '//': '__floordiv__',
  '%': '__mod__',
  '**': '__pow__',
  '@': '__matmul__',
  '<<': '__lshift__',
  '>>': '__rshift__',
  '&': '__and__',
  '|': '__or__',
  '^': '__xor__',
};

/** Crochet appele lorsque l'operande de droite est prioritaire. */
const REFLECTED_DUNDERS: Readonly<Record<string, string>> = {
  '+': '__radd__',
  '-': '__rsub__',
  '*': '__rmul__',
  '/': '__rtruediv__',
  '//': '__rfloordiv__',
  '%': '__rmod__',
  '**': '__rpow__',
  '@': '__rmatmul__',
  '<<': '__rlshift__',
  '>>': '__rrshift__',
  '&': '__rand__',
  '|': '__ror__',
  '^': '__rxor__',
};

const COMPARISON_DUNDERS: Readonly<Record<string, string>> = {
  '<': '__lt__',
  '<=': '__le__',
  '>': '__gt__',
  '>=': '__ge__',
};

const REFLECTED_COMPARISON_DUNDERS: Readonly<Record<string, string>> = {
  '<': '__gt__',
  '<=': '__ge__',
  '>': '__lt__',
  '>=': '__le__',
};

/** Table de methodes associee a un type de base, pour `str.upper(...)`. */
function classMethodTable(name: string): MethodTable | null {
  switch (name) {
    case 'str':
      return STRING_METHODS;
    case 'list':
      return LIST_METHODS;
    case 'dict':
      return DICT_METHODS;
    case 'set':
      return SET_METHODS;
    case 'tuple':
      return TUPLE_METHODS;
    case 'range':
      return RANGE_METHODS;
    default:
      return null;
  }
}

/** Les cibles d'affectation sont des expressions, mais validees a la construction. */
function asTarget(expression: Expr): AssignTarget {
  return expression as AssignTarget;
}

function requireInteger(value: UchiValue, who: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throwValue(makeError('TypeError', `${who} attend un entier, recu '${typeName(value)}'`));
  }
  return value;
}

/** Lecture d'une ligne sur l'entree standard, sans dependance externe. */
function defaultReadLine(): string | null {
  const buffer = new Uint8Array(1);
  let out = '';
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, 1, null);
    } catch {
      return out === '' ? null : out;
    }
    if (read === 0) return out === '' ? null : out;
    const char = String.fromCharCode(buffer[0] as number);
    if (char === '\n') return out;
    if (char !== '\r') out += char;
  }
}
