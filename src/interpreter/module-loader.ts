/**
 * Chargement des modules Uchi.
 *
 * Deux sources :
 *   - les modules integres, enregistres par la bibliotheque standard ;
 *   - les fichiers `.uchi`, cherches dans le dossier du script importateur puis
 *     dans les repertoires de recherche.
 *
 * Un module en cours de chargement est place dans le cache *avant* son
 * execution : un import circulaire recoit donc l'objet en cours de constitution
 * plutot qu'une erreur.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { throwValue } from '../errors.ts';
import { EXTENSION, PACKAGE_FILE } from '../language.ts';
import { parse } from '../parser/parser.ts';
import type { Interpreter } from './interpreter.ts';
import { Environment } from './environment.ts';
import { makeError } from './error-registry.ts';
import { UchiModule } from './values.ts';

export type ModuleFactory = (interpreter: Interpreter) => UchiModule;

export class ModuleLoader {
  private readonly interpreter: Interpreter;
  private readonly cache = new Map<string, UchiModule>();
  private readonly builtins: Map<string, ModuleFactory>;
  private readonly searchPaths: string[];
  private readonly baseDirectory: string;
  /** Fichiers en cours d'execution, du plus ancien au plus recent. */
  private readonly loading: string[] = [];

  constructor(
    interpreter: Interpreter,
    builtins: Map<string, ModuleFactory>,
    searchPaths: string[],
    baseDirectory: string,
  ) {
    this.interpreter = interpreter;
    this.builtins = builtins;
    this.searchPaths = searchPaths;
    this.baseDirectory = resolve(baseDirectory);
  }

  load(name: string): UchiModule {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    const factory = this.builtins.get(name);
    if (factory !== undefined) {
      const module = factory(this.interpreter);
      this.cache.set(name, module);
      return module;
    }

    const file = this.resolveFile(name);
    if (file === null) {
      const roots = [this.currentDirectory(), ...this.searchPaths, this.baseDirectory]
        .map((path) => `  ${path}`)
        .join('\n');
      throwValue(
        makeError(
          'ModuleNotFoundError',
          `module '${name}' introuvable. Repertoires recherches :\n${roots}`,
        ),
      );
    }
    return this.loadFile(name, file);
  }

  /** Dossier du script importateur, ou le repertoire de base du programme. */
  private currentDirectory(): string {
    const current = this.loading[this.loading.length - 1];
    return current === undefined ? this.baseDirectory : dirname(current);
  }

  /** Recherche un chemin de module, ou `null` si introuvable. */
  private resolveFile(name: string): string | null {
    const relative = name.replace(/\./g, '/');
    const roots: string[] = [];
    if (name.startsWith('.')) {
      // Un nom relatif part du dossier du script importateur.
      const base = this.currentDirectory();
      const withoutDots = name.replace(/^\.+/, '');
      roots.push(isAbsolute(withoutDots) ? withoutDots : resolve(base, withoutDots));
    } else {
      roots.push(...this.searchPaths, this.baseDirectory);
    }

    for (const root of roots) {
      for (const candidate of [
        join(root, `${relative}${EXTENSION}`),
        join(root, relative, PACKAGE_FILE),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  private loadFile(name: string, file: string): UchiModule {
    const module = new UchiModule(name);
    this.cache.set(name, module);

    // Chaque module a sa propre portee globale, enchainee sur les builtins.
    const env = new Environment(this.interpreter.builtinsEnv, true);
    env.define('__name__', name);
    env.define('__file__', file);

    const source = readFileSync(file, 'utf8');
    const program = parse(source, file);

    this.loading.push(file);
    const previousName = this.interpreter.currentModuleName;
    this.interpreter.currentModuleName = name;
    try {
      this.interpreter.runIn(env, program);
    } finally {
      this.loading.pop();
      this.interpreter.currentModuleName = previousName;
    }

    // Seuls les noms definis par le module sont exportes ; les builtins
    // heredites ne le sont pas.
    for (const member of env.names()) {
      const value = env.get(member);
      if (value !== undefined) module.set(member, value);
    }
    return module;
  }
}
