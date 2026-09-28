/**
 * Hierarchie d'erreurs du langage Uchi.
 *
 * - `UchiSyntaxError`  : levee par le lexer et le parser.
 * - `UchiRuntimeError` : levee par l'interpreteur (bug interne du runtime).
 * - `UchiThrow`        : mecanisme de controle de flux utilise par
 *                         `raise` / `try` / `except`. Ce n'est pas une erreur
 *                         de compilation, c'est une valeur transportee.
 */

import { type Token, describeToken, TokenType } from './lexer/tokens.ts';

export interface SourceLocation {
  line: number;
  column: number;
}

export interface SourceFile {
  /** Chemin affiche a l'utilisateur. */
  path: string;
  /** Contenu complet du fichier, utilise pour afficher le contexte. */
  text: string;
}

export class UchiSyntaxError extends Error {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly sourceLine: string | null;

  constructor(
    message: string,
    opts: { path?: string; file?: SourceFile; line?: number; column?: number } = {},
  ) {
    const line = opts.line ?? 0;
    const column = opts.column ?? 0;
    const file = opts.file;
    const sourceLine = file ? (file.text.split('\n')[line - 1] ?? null) : null;
    super(formatSyntaxMessage(message, file?.path ?? opts.path ?? '<inconnu>', line, column, sourceLine));
    this.name = 'UchiSyntaxError';
    this.path = file?.path ?? opts.path ?? '<inconnu>';
    this.line = line;
    this.column = column;
    this.sourceLine = sourceLine;
  }
}

function formatSyntaxMessage(
  message: string,
  path: string,
  line: number,
  column: number,
  sourceLine: string | null,
): string {
  let out = `${path}:${line}:${column + 1}: Erreur de syntaxe: ${message}`;
  if (sourceLine !== null) {
    out += `\n  ${sourceLine}\n  ${' '.repeat(Math.max(0, column))}^`;
  }
  return out;
}

/** Erreur interne du runtime : toujours un bug dans Uchi lui-meme. */
export class UchiRuntimeError extends Error {
  constructor(message: string) {
    super(`Erreur interne du runtime Uchi: ${message}`);
    this.name = 'UchiRuntimeError';
  }
}

/**
 * Objet de controle de flux : transporte une valeur Uchi levee par
 * `raise`. L'interpreteur le fait remonter jusqu'au `try` correspondant.
 */
export class UchiThrow {
  readonly value: unknown;
  /**
   * Trace d'appels, du plus ancien au plus recent, telle que produite par
   * l'interpreteur (`ligne 12, dans f`). Le dernier element designe la ligne
   * ou l'erreur a ete levee.
   */
  readonly traceback: string[];

  constructor(value: unknown, traceback: string[] = []) {
    this.value = value;
    this.traceback = traceback;
  }
}

/**
 * Fournisseur de trace, installe par l'interpreteur.
 *
 * La trace doit etre capturee au moment du `raise`, car les cadres d'appels
 * sont depiles au fur et a mesure que l'erreur remonte. `throwValue` est une
 * fonction libre, sans acces a l'interpreteur : ce crochet fait le lien.
 */
let traceProvider: (() => string[]) | null = null;

export function setTraceProvider(provider: (() => string[]) | null): void {
  traceProvider = provider;
}

/** Trace d'appels courante, ou une trace vide hors execution. */
export function currentTrace(): string[] {
  return traceProvider === null ? [] : traceProvider();
}

/**
 * Ligne designee par une trace d'appels : celle de son dernier element, donc
 * l'endroit ou l'erreur a ete levee. `0` si la trace est vide ou sans ligne.
 */
export function tracebackLine(trace: readonly string[]): number {
  for (let i = trace.length - 1; i >= 0; i--) {
    const found = /^ligne (\d+)/.exec(trace[i] as string);
    if (found !== null) return Number(found[1]);
  }
  return 0;
}

export function throwValue(value: unknown): never {
  throw new UchiThrow(value, currentTrace());
}

export function syntaxErrorAt(
  message: string,
  tok: Token,
  file: SourceFile,
): never {
  throw new UchiSyntaxError(message, { file, line: tok.line, column: tok.column });
}

export function unexpectedToken(tok: Token, file: SourceFile, context = 'expression'): never {
  const where = tok.type === TokenType.NEWLINE ? 'nouvelle ligne inattendue' : describeToken(tok);
  return syntaxErrorAt(`${where} dans ${context}`, tok, file);
}
