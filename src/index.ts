/**
 * Point d'entree public du langage Uchi.
 *
 * `runSource` convient a un hebergeur (REPL, tests, GUI) : il analyse puis
 * execute une source et renvoie la valeur de la derniere expression.
 */

export { parse } from './parser/parser.ts';
export { tokenize } from './lexer/lexer.ts';
export { UchiSyntaxError, UchiRuntimeError, UchiThrow } from './errors.ts';
export { Interpreter } from './interpreter/interpreter.ts';
export type { InterpreterOptions } from './interpreter/interpreter.ts';
export { toStr, toRepr, typeName } from './interpreter/operations.ts';
export {
  UchiClass,
  UchiDict,
  UchiError,
  UchiInstance,
  UchiModule,
  UchiSet,
  UchiTuple,
  isCallable,
} from './interpreter/values.ts';
export type { UchiValue } from './interpreter/values.ts';
export { UCHI_VERSION } from './stdlib/version.ts';
