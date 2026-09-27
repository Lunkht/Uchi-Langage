/**
 * Environnements et portee des variables.
 *
 * Chaque fonction, comprehension et module possede son propre `Environment`,
 * enchaine vers celui qui l'a engendre. La resolution suit la chaine.
 *
 * Note de conception : l'affectation recherche d'abord si le nom existe dans
 * la portee courante, puis dans les portees englobantes (comportement de
 * fermeture). Si le nom est nouveau, il est cree dans la portee courante.
 * `global` et `nonlocal` permettent de forcer une cible.
 */

import { throwValue } from '../errors.ts';
import { makeError } from './error-registry.ts';
import type { UchiValue } from './values.ts';

export class Environment {
  private readonly values = new Map<string, UchiValue>();
  readonly enclosing: Environment | null;
  /** `true` s'il s'agit de l'environnement global d'un module. */
  readonly isGlobal: boolean;
  /** Noms forces dans l'environnement global par `global`. */
  private readonly globalNames = new Set<string>();
  /** Noms forces dans la portee englobante par `nonlocal`. */
  private readonly nonlocalNames = new Set<string>();

  constructor(enclosing: Environment | null = null, isGlobal = false) {
    this.enclosing = enclosing;
    this.isGlobal = isGlobal;
  }

  /** Racine de la chaine d'environnements. */
  get root(): Environment {
    let env: Environment = this;
    while (env.enclosing !== null) env = env.enclosing;
    return env;
  }

  /**
   * Premiere portee globale trouvee en remontant la chaine.
   *
   * Ce n'est pas forcement `root` : l'environnement des `builtins` est lui-meme
   * une portee mere, posee avant celle du module. `global x` doit donc viser le
   * module courant, sans quoi un nom global ecrraserait un builtin.
   */
  get globalScope(): Environment {
    let env: Environment = this;
    while (env.enclosing !== null && !env.isGlobal) env = env.enclosing;
    return env;
  }

  define(name: string, value: UchiValue): void {
    this.values.set(name, value);
  }

  has(name: string): boolean {
    if (this.values.has(name)) return true;
    return this.enclosing?.has(name) ?? false;
  }

  hasLocal(name: string): boolean {
    return this.values.has(name);
  }

  /** Portee ou `name` est defini, ou `null`. */
  private resolve(name: string): Environment | null {
    if (this.values.has(name)) return this;
    return this.enclosing?.resolve(name) ?? null;
  }

  get(name: string): UchiValue {
    const owner = this.resolve(name);
    if (owner === null) {
      throwValue(makeError('NameError', `le nom '${name}' n'est pas defini`));
    }
    return owner.values.get(name) as UchiValue;
  }

  /** Lecture tolérante : `undefined` si le nom n'existe pas. */
  tryGet(name: string): UchiValue | undefined {
    const owner = this.resolve(name);
    return owner === null ? undefined : owner.values.get(name);
  }

  /**
   * Affectation ordinaire.
   *
   * Les declarations `global` / `nonlocal` sont honorees en priorite.
   * Sinon la resolution remonte la chaine : un nom deja connu est mis a jour
   * dans la portee qui le definit (fermeture), un nom nouveau est cree ici.
   */
  assign(name: string, value: UchiValue): void {
    if (this.nonlocalNames.has(name)) {
      this.assignNonlocal(name, value);
      return;
    }
    if (this.globalNames.has(name)) {
      this.globalScope.values.set(name, value);
      return;
    }
    const owner = this.resolve(name);
    if (owner === null) {
      this.values.set(name, value);
      return;
    }
    owner.values.set(name, value);
  }

  /** `global x` : la portee courante n'est plus proprietaire de `x`. */
  declareGlobal(name: string): void {
    this.globalNames.add(name);
    this.values.delete(name);
  }

  /** `nonlocal x` : `x` doit exister dans une portee englobante. */
  declareNonlocal(name: string): void {
    const parent = this.enclosing;
    if (parent === null || !parent.has(name)) {
      throwValue(
        makeError('SyntaxError', `'nonlocal ${name}' : aucune portee englobante ne definit '${name}'`),
      );
    }
    this.nonlocalNames.add(name);
    this.values.delete(name);
  }

  isGlobalName(name: string): boolean {
    return this.globalNames.has(name);
  }

  isNonlocalName(name: string): boolean {
    return this.nonlocalNames.has(name);
  }

  /** Affectation dans l'environnement global du module courant. */
  assignGlobal(name: string, value: UchiValue): void {
    this.globalScope.values.set(name, value);
  }

  /**
   * Affectation dans la portee englobante la plus proche definissant `name`.
   * Erreur si aucune : c'est le comportement attendu de `nonlocal`.
   */
  assignNonlocal(name: string, value: UchiValue): void {
    const parent = this.enclosing;
    if (parent === null) {
      throwValue(makeError('SyntaxError', `'nonlocal ${name}' : aucune portee englobante ne definit '${name}'`));
    }
    const owner = parent.resolve(name);
    if (owner === null) {
      throwValue(makeError('SyntaxError', `'nonlocal ${name}' : aucune portee englobante ne definit '${name}'`));
    }
    owner.values.set(name, value);
  }

  /** Supprime un nom de la portee courante. */
  delete(name: string): boolean {
    return this.values.delete(name);
  }

  /** Noms definis dans cette portee uniquement. */
  names(): string[] {
    return [...this.values.keys()];
  }
}
