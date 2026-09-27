/**
 * Tables de coloration syntaxique pour l'editeur web.
 *
 * Les tables ne sont pas recopiees : elles sont derivees des memes sources que
 * l'interpreteur (mots-cles du lexer, fonctions natives, classes de types,
 * modules integres, exceptions), afin que la coloration suive l'evolution du
 * langage sans synchronisation manuelle.
 */

import { Interpreter } from '../interpreter/interpreter.ts';
import { KEYWORDS } from '../lexer/tokens.ts';
import { builtinTypeNames, createBuiltins } from '../stdlib/builtins.ts';
import { createBuiltinModules } from '../stdlib/modules.ts';
import { errorClassNames } from '../interpreter/error-registry.ts';
import { UchiNativeFunction } from '../interpreter/values.ts';

/** Tables de coloration, consommees par `/api/grammar`. */
export interface Grammar {
  /** Mots-cles du langage, y compris `True`, `False`, `None` et `self`. */
  keywords: string[];
  /** Valeurs litterales : `True`, `False`, `None`. */
  literals: string[];
  /** Noms de types integres : `int`, `str`, `list`, ... */
  types: string[];
  /** Fonctions natives : `len`, `print`, `range`, ... */
  functions: string[];
  /** Modules integres : `math`, `re`, `json`, ... */
  modules: string[];
  /** Exceptions systeme : `ValueError`, `TypeError`, ... */
  exceptions: string[];
  /** Methodes speciales, pour les crochets de protocole. */
  dunders: string[];
  /** Operateurs, tries par longueur decroissante. */
  operators: string[];
}

/** Methodes speciales reconnues par l'editeur. */
const DUNDERS = [
  '__init__', '__str__', '__repr__', '__len__', '__iter__', '__next__', '__getitem__',
  '__setitem__', '__contains__', '__bool__', '__call__', '__enter__', '__exit__',
  '__add__', '__sub__', '__mul__', '__truediv__', '__floordiv__', '__mod__', '__pow__',
  '__eq__', '__ne__', '__lt__', '__le__', '__gt__', '__ge__', '__neg__', '__pos__',
  '__abs__', '__hash__', '__repr__', '__setattr__', '__getattr__', '__del__',
];

/** Operateurs Uchi, du plus long au plus court pour un balayage sans ambiguite. */
const OPERATORS = [
  '**=', '//=', '>>=', '<<=', '...',
  '**', '//', '==', '!=', '<=', '>=', '->', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=',
  '+', '-', '*', '/', '%', '=', '<', '>', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '@', '&', '|', '^', '~',
];

/** Construit les tables de coloration a partir de l'etat reel du langage. */
export function collectGrammar(): Grammar {
  // Un interpreteur jetable suffit a obtenir la liste des natives : aucune
  // execution de code Uchi n'a lieu.
  const interpreter = new Interpreter({ write: () => {} });
  const functions = createBuiltins(interpreter)
    .filter(([, value]) => value instanceof UchiNativeFunction)
    .map(([name]) => name)
    .sort();
  return {
    keywords: [...KEYWORDS.keys()].sort(),
    literals: ['True', 'False', 'None'],
    types: [...builtinTypeNames()],
    functions,
    modules: [...createBuiltinModules().keys()].sort(),
    exceptions: errorClassNames().sort(),
    dunders: DUNDERS,
    operators: OPERATORS,
  };
}
