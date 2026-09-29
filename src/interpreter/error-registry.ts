/**
 * Registre des types d'exception.
 *
 * Les classes d'erreur (`ValueError`, `TypeError`, ...) sont des classes
 * Uchi ordinaires enregistrees ici au demarrage, afin que le runtime puisse
 * construire des exceptions sans dependre de la bibliotheque standard
 * (ce qui creerait un cycle d'import).
 */

import { UchiClass, UchiError, type UchiValue } from './values.ts';

const registry = new Map<string, UchiClass>();

export function registerErrorClass(name: string, klass: UchiClass): void {
  registry.set(name, klass);
}

export function errorClass(name: string): UchiClass | undefined {
  return registry.get(name);
}

export function errorClassNames(): string[] {
  return [...registry.keys()];
}

/** Construit une exception pret a etre levee. */
export function makeError(
  name: string,
  message: string,
  options: {
    args?: UchiValue[];
    cause?: UchiValue | null;
    klass?: UchiClass | null;
    traceback?: string[];
  } = {},
): UchiError {
  return new UchiError(name, message, {
    args: options.args ?? [message],
    klass: options.klass ?? registry.get(name) ?? null,
    cause: options.cause ?? null,
    traceback: options.traceback,
  });
}
