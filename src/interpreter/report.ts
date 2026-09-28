/**
 * Description d'une erreur destined a un hote (CLI, editeur).
 *
 * Le texte est forme une seule fois pour que la console et le terminal
 * affichent la meme chose : `ValueError : division par zero`.
 */

import { UchiThrow } from '../errors.ts';
import { toRepr, toStr, typeName } from './operations.ts';
import { UchiError, UchiInstance, type UchiValue } from './values.ts';
import type { Interpreter } from './interpreter.ts';

/** Phrase unique decrivant une erreur, prete a etre affichee. */
export function describeError(interpreter: Interpreter | null, thrown: unknown): string {
  if (thrown instanceof UchiThrow) {
    const value = thrown.value;
    // `ValueError('oups')` : le nom du type suivi du message, comme en Python.
    if (value instanceof UchiError) return `Erreur : ${value.name} : ${value.message}`;
    if (value instanceof UchiInstance) {
      const text = interpreter === null ? toStr(value) : interpreter.toDisplayString(value);
      return `Erreur : ${value.klass.name} : ${text}`;
    }
    return `Erreur : ${toRepr(value as UchiValue)}`;
  }
  if (thrown instanceof Error) return `Erreur interne : ${thrown.message}`;
  return `Erreur : ${String(thrown)}`;
}

/**
 * Meme information, mais separee : l'editeur colore le nom du type et affiche
 * le message dans un bloc distinct.
 *
 * Le nom est vide quand la valeur levee n'est pas une exception (`raise 3`) :
 * l'appelant affiche alors le message seul.
 */
export function errorSummary(
  interpreter: Interpreter | null,
  thrown: unknown,
): { name: string; message: string } {
  if (thrown instanceof UchiThrow) {
    const value = thrown.value;
    if (value instanceof UchiError) return { name: value.name, message: value.message };
    if (value instanceof UchiInstance) {
      const text = interpreter === null ? toStr(value) : interpreter.toDisplayString(value);
      return { name: value.klass.name, message: text };
    }
    return { name: '', message: toRepr(value as UchiValue) };
  }
  if (thrown instanceof Error) return { name: thrown.name, message: thrown.message };
  return { name: '', message: String(thrown) };
}
