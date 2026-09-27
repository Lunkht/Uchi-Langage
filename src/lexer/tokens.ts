/**
 * Definitions de tokens pour le langage Uchi.
 *
 * Uchi est un langage a indentation significative : le lexer produit
 * des tokens NEWLINE, INDENT et DEDENT que le parser utilise pour
 * delimiter les blocs.
 */

export const TokenType = {
  // Structure
  NEWLINE: 'NEWLINE',
  INDENT: 'INDENT',
  DEDENT: 'DEDENT',
  EOF: 'EOF',

  // Literaux
  INT: 'INT',
  FLOAT: 'FLOAT',
  STRING: 'STRING',
  FSTRING_START: 'FSTRING_START',
  FSTRING_MIDDLE: 'FSTRING_MIDDLE',
  FSTRING_END: 'FSTRING_END',
  FSTRING_CONVERSION: 'FSTRING_CONVERSION',
  FSTRING_SPEC: 'FSTRING_SPEC',
  /** Specificateur `=` des expressions auto-documentees : `f"{x=}"`. */
  FSTRING_DEBUG: 'FSTRING_DEBUG',

  // Noms
  NAME: 'NAME',

  // Mots-cles
  AND: 'AND',
  BREAK: 'BREAK',
  CLASS: 'CLASS',
  CONTINUE: 'CONTINUE',
  DEF: 'DEF',
  ELIF: 'ELIF',
  ELSE: 'ELSE',
  EXCEPT: 'EXCEPT',
  FALSE: 'FALSE',
  FINALLY: 'FINALLY',
  FOR: 'FOR',
  FROM: 'FROM',
  GLOBAL: 'GLOBAL',
  IF: 'IF',
  IMPORT: 'IMPORT',
  IN: 'IN',
  IS: 'IS',
  LAMBDA: 'LAMBDA',
  NONE: 'NONE',
  NONLOCAL: 'NONLOCAL',
  NOT: 'NOT',
  OR: 'OR',
  PASS: 'PASS',
  RAISE: 'RAISE',
  RETURN: 'RETURN',
  ASSERT: 'ASSERT',
  SELF: 'SELF',
  TRUE: 'TRUE',
  TRY: 'TRY',
  WHILE: 'WHILE',
  DEL: 'DEL',
  AS: 'AS',
  WITH: 'WITH',

  // Operateurs
  PLUS: 'PLUS',
  MINUS: 'MINUS',
  STAR: 'STAR',
  SLASH: 'SLASH',
  SLASH_SLASH: 'SLASH_SLASH',
  PERCENT: 'PERCENT',
  STAR_STAR: 'STAR_STAR',
  AT: 'AT',
  TILDE: 'TILDE',

  // Comparaisons
  EQ_EQ: 'EQ_EQ',
  BANG_EQ: 'BANG_EQ',
  LT: 'LT',
  GT: 'GT',
  LT_EQ: 'LT_EQ',
  GT_EQ: 'GT_EQ',

  // Assignations
  EQ: 'EQ',
  PLUS_EQ: 'PLUS_EQ',
  MINUS_EQ: 'MINUS_EQ',
  STAR_EQ: 'STAR_EQ',
  SLASH_EQ: 'SLASH_EQ',
  SLASH_SLASH_EQ: 'SLASH_SLASH_EQ',
  PERCENT_EQ: 'PERCENT_EQ',
  STAR_STAR_EQ: 'STAR_STAR_EQ',
  AT_EQ: 'AT_EQ',

  // Ponctuation
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  LBRACKET: 'LBRACKET',
  RBRACKET: 'RBRACKET',
  LBRACE: 'LBRACE',
  RBRACE: 'RBRACE',
  COMMA: 'COMMA',
  COLON: 'COLON',
  DOT: 'DOT',
  SEMICOLON: 'SEMICOLON',
  ARROW: 'ARROW',
  ATAT: 'ATAT',
  BANG: 'BANG',
  COLON_EQ: 'COLON_EQ',

  // Bits
  PIPE: 'PIPE',
  CARET: 'CARET',
  AMPERSAND: 'AMPERSAND',
  LT_LT: 'LT_LT',
  GT_GT: 'GT_GT',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export interface Token {
  type: TokenType;
  /** Lexeme brut tel qu'il apparait dans le source. */
  lexeme: string;
  /** Ligne 1-indexee. */
  line: number;
  /** Colonne 0-indexee. */
  column: number;
}

export function token(
  type: TokenType,
  lexeme: string,
  line: number,
  column: number,
): Token {
  return { type, lexeme, line, column };
}

/** Mots-cles reserves -> type de token correspondant. */
export const KEYWORDS: ReadonlyMap<string, TokenType> = new Map([
  ['and', TokenType.AND],
  ['as', TokenType.AS],
  ['assert', TokenType.ASSERT],
  ['break', TokenType.BREAK],
  ['class', TokenType.CLASS],
  ['continue', TokenType.CONTINUE],
  ['def', TokenType.DEF],
  ['del', TokenType.DEL],
  ['elif', TokenType.ELIF],
  ['else', TokenType.ELSE],
  ['except', TokenType.EXCEPT],
  ['False', TokenType.FALSE],
  ['finally', TokenType.FINALLY],
  ['for', TokenType.FOR],
  ['from', TokenType.FROM],
  ['global', TokenType.GLOBAL],
  ['if', TokenType.IF],
  ['import', TokenType.IMPORT],
  ['in', TokenType.IN],
  ['is', TokenType.IS],
  ['lambda', TokenType.LAMBDA],
  ['None', TokenType.NONE],
  ['nonlocal', TokenType.NONLOCAL],
  ['not', TokenType.NOT],
  ['or', TokenType.OR],
  ['pass', TokenType.PASS],
  ['raise', TokenType.RAISE],
  ['return', TokenType.RETURN],
  ['self', TokenType.SELF],
  ['True', TokenType.TRUE],
  ['try', TokenType.TRY],
  ['while', TokenType.WHILE],
  ['with', TokenType.WITH],
]);

export function describeToken(t: Token): string {
  switch (t.type) {
    case TokenType.NEWLINE:
      return 'fin de ligne';
    case TokenType.INDENT:
      return 'indentation';
    case TokenType.DEDENT:
      return 'dedentation';
    case TokenType.EOF:
      return 'fin du fichier';
    default:
      return `'${t.lexeme}'`;
  }
}
