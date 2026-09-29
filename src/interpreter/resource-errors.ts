/**
 * Traduction des erreurs JavaScript d'epuisement de ressources.
 *
 * Certaines operations natives n'ont pas d'equivalent en Uchi : allouer un
 * tableau de quatre milliards d'elements, s'appeler indefiniment ou
 * concatener des chaines jusqu'a saturation leve une `RangeError` de
 * JavaScript. En sortant de l'interpreteur, elle est presentee a
 * l'utilisateur comme une « erreur interne » — c'est-a-dire un defaut
 * d'Uchi — et aucun `except` ne peut la rattraper.
 *
 * Ces echecs sont previsibles et meritent donc d'etre des exceptions ordinaires.
 * Cette table reconnait ceux-la, et les rend rattrapables.
 */

import { makeError } from './error-registry.ts';
import type { UchiError } from './values.ts';

/** Type d'exception Uchi a lever, et phrase expliquee a l'utilisateur. */
interface Ressource {
  type: string;
  message: string;
}

/**
 * Reconnaissances par ordre de priorite.
 *
 * Le message est teste avant la classe : un depilement de pile peut remonter
 * sous une forme qui n'est pas une `RangeError`, selon l'operation qui a
 * epuise la pile.
 */
const RECONNAISSANCES: ReadonlyArray<{ motif: RegExp; ressource: Ressource }> = [
  {
    motif: /maximum call stack size exceeded|stack overflow/i,
    ressource: {
      type: 'RecursionError',
      message: 'recursion trop profonde : la pile d\'appels est epuisee',
    },
  },
  {
    motif: /invalid count value|invalid string length/i,
    ressource: {
      type: 'ValueError',
      message: 'taille de chaine invalide',
    },
  },
  {
    motif: /invalid (?:array|typed array|array buffer) length|array buffer allocation failed|out of memory|allocation failed/i,
    ressource: {
      type: 'MemoryError',
      message: 'allocation impossible : la taille demandee depasse les ressources',
    },
  },
];

/**
 * Convertit une erreur JavaScript d'epuisement en exception Uchi.
 *
 * Renvoie `null` pour tout le reste : une `TypeError` de V8 signale un reel
 * defaut du runtime, qu'il ne faut pas maquiller en erreur du programme.
 */
export function asResourceError(error: unknown, traceback: string[]): UchiError | null {
  if (!(error instanceof Error)) return null;
  const texte = `${error.name}: ${error.message}`;

  for (const { motif, ressource } of RECONNAISSANCES) {
    if (!motif.test(texte)) continue;
    return makeError(ressource.type, ressource.message, { traceback });
  }
  // Une `RangeError` restante vient toujours d'une taille ou d'un decompte
  // refuse par le moteur : la cible est donc l'allocation.
  if (error instanceof RangeError) {
    return makeError('MemoryError', `allocation impossible : ${error.message}`, { traceback });
  }
  return null;
}
