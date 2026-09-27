/**
 * Arbre syntaxique abstrait (AST) d'Uchi.
 *
 * Chaque noeud porte une localisation optionnelle (`loc`) qui permet de
 * produire des erreurs d'execution precises.
 */

import type { SourceLocation } from '../errors.ts';
import type { TokenType } from '../lexer/tokens.ts';

export interface Node {
  readonly loc?: SourceLocation;
}

// ============================================================ Expressions

export type Expr =
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | BoolLiteral
  | NoneLiteral
  | FStringExpr
  | ListLiteral
  | ComprehensionExpr
  | SetLiteral
  | TupleLiteral
  | DictLiteral
  | NameExpr
  | UnaryExpr
  | BinaryExpr
  | ComparisonExpr
  | LogicalExpr
  | ConditionalExpr
  | LambdaExpr
  | CallExpr
  | AttributeExpr
  | IndexExpr
  | SliceExpr
  | StarExpr
  | DoubleStarExpr;

export interface IntLiteral extends Node {
  kind: 'int';
  value: number;
}

export interface FloatLiteral extends Node {
  kind: 'float';
  value: number;
}

export interface StringLiteral extends Node {
  kind: 'string';
  value: string;
}

export interface BoolLiteral extends Node {
  kind: 'bool';
  value: boolean;
}

export interface NoneLiteral extends Node {
  kind: 'none';
}

/** Partie d'une f-string : litteral, interpolation, ou les deux. */
export type FStringPart = FStringText | FStringInterpolation;

export interface FStringText {
  kind: 'text';
  value: string;
}

export interface FStringInterpolation {
  kind: 'interpolation';
  expression: Expr;
  /** `r`, `s` ou `a`, ou undefined. */
  conversion?: string;
  /** Gabarit de format brut, ou undefined. */
  spec?: string;
  /**
   * Expression auto-documentee `f"{x=}"` : texte source suivi de `=`.
   * Le defaut de conversion devient `repr` quand aucun gabarit n'est fourni.
   */
  debug?: string;
}

export interface FStringExpr extends Node {
  kind: 'fstring';
  parts: FStringPart[];
}

export interface ListLiteral extends Node {
  kind: 'list';
  elements: Expr[];
}

/**
 * Comprehension : `[expr for cible in iterable if condition, ...]`.
 *
 * Le meme noeud sert aux comprehensions de liste et d'ensemble ; le type
 *(resultat) est decide par l'interpreteur, pas par le parseur.
 */
export interface ComprehensionExpr extends Node {
  kind: 'comprehension';
  /** Element produit : l'expression pour une liste, la cle ou la valeur pour un dict. */
  element: Expr;
  /** `None` pour `{cle: valeur for ...}` : deux expressions sont produites. */
  valueElement: Expr | null;
  /** `true` pour `{...}` (ensemble), `false` pour `[...]` (liste). */
  asSet: boolean;
  /** `for cible in iterable` ; les clauses suivantes sont des `if` ou des `for`. */
  clauses: ComprehensionClause[];
}

export type ComprehensionClause =
  | { kind: 'for'; target: Expr; iterable: Expr }
  | { kind: 'if'; condition: Expr };

export interface SetLiteral extends Node {
  kind: 'set';
  elements: Expr[];
}

export interface TupleLiteral extends Node {
  kind: 'tuple';
  elements: Expr[];
  /** `()` : tuple vide, `(x)` : parenthesise, sinon tuple litteral. */
  parenthesized: boolean;
}

export interface DictLiteral extends Node {
  kind: 'dict';
  entries: Array<{ key: Expr; value: Expr }>;
}

export interface NameExpr extends Node {
  kind: 'name';
  id: string;
}

export type UnaryOp = '-' | '+' | 'not' | '~';

export interface UnaryExpr extends Node {
  kind: 'unary';
  op: UnaryOp;
  operand: Expr;
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '//'
  | '%'
  | '**'
  | '@'
  | '<<'
  | '>>'
  | '&'
  | '|'
  | '^';

export interface BinaryExpr extends Node {
  kind: 'binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export type ComparisonOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not in' | 'is' | 'is not';

export interface ComparisonExpr extends Node {
  kind: 'comparison';
  /** Au moins deux operandes : `a < b < c`. */
  operands: Expr[];
  /** `operands.length - 1` operateurs. */
  ops: ComparisonOp[];
}

export interface LogicalExpr extends Node {
  kind: 'logical';
  op: 'and' | 'or';
  left: Expr;
  right: Expr;
}

export interface ConditionalExpr extends Node {
  kind: 'conditional';
  test: Expr;
  consequent: Expr;
  alternate: Expr;
}

export interface LambdaExpr extends Node {
  kind: 'lambda';
  params: Param[];
  body: Expr;
}

export type Argument =
  | { kind: 'positional'; value: Expr }
  | { kind: 'keyword'; name: string; value: Expr }
  | { kind: 'star'; value: Expr }
  | { kind: 'double-star'; value: Expr };

export interface CallExpr extends Node {
  kind: 'call';
  callee: Expr;
  args: Argument[];
}

export interface AttributeExpr extends Node {
  kind: 'attribute';
  object: Expr;
  name: string;
}

export interface IndexExpr extends Node {
  kind: 'index';
  object: Expr;
  index: Expr;
}

export interface SliceExpr extends Node {
  kind: 'slice';
  object: Expr;
  lower: Expr | null;
  upper: Expr | null;
  step: Expr | null;
}

export interface StarExpr extends Node {
  kind: 'star';
  operand: Expr;
}

export interface DoubleStarExpr extends Node {
  kind: 'double-star';
  operand: Expr;
}

// ============================================================= Statements

export type Stmt =
  | ExprStatement
  | AssignStatement
  | AugAssignStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | WithStatement
  | BreakStatement
  | ContinueStatement
  | PassStatement
  | FunctionStatement
  | ClassStatement
  | ReturnStatement
  | ImportStatement
  | ImportFromStatement
  | TryStatement
  | RaiseStatement
  | AssertStatement
  | GlobalStatement
  | NonlocalStatement
  | DelStatement;

export interface ExprStatement extends Node {
  kind: 'expr-statement';
  expression: Expr;
}

/** Cible d'assignation : nom, tuple avec etoile, index ou attribut. */
export type AssignTarget = NameExpr | IndexExpr | AttributeExpr | TupleLiteral | ListLiteral | StarExpr;

export interface AssignStatement extends Node {
  kind: 'assign';
  targets: AssignTarget[];
  value: Expr;
  /** Annotations de type optionnelles, alignees sur `targets`. */
  annotations: Array<string | null>;
}

export type AugAssignOp = '+=' | '-=' | '*=' | '/=' | '//=' | '%=' | '**=' | '@=';

export interface AugAssignStatement extends Node {
  kind: 'aug-assign';
  target: AssignTarget;
  op: AugAssignOp;
  value: Expr;
  annotation: string | null;
}

export interface IfStatement extends Node {
  kind: 'if';
  condition: Expr;
  consequence: Stmt[];
  /** `else` (Stmt[]) ou `elif` (IfStatement) ou null. */
  alternate: IfAlternate | null;
}

export type IfAlternate = { kind: 'else'; body: Stmt[] } | { kind: 'elif'; statement: IfStatement };

export interface WhileStatement extends Node {
  kind: 'while';
  condition: Expr;
  body: Stmt[];
  /** Bloc `else`, execute seulement si la boucle s'est terminee sans `break`. */
  orelse: Stmt[] | null;
}

/** `with expr as cible, ... :` */
export interface WithItem {
  context: Expr;
  target: AssignTarget | null;
}

export interface WithStatement extends Node {
  kind: 'with';
  items: WithItem[];
  body: Stmt[];
}

export interface ForStatement extends Node {
  kind: 'for';
  target: AssignTarget;
  iterable: Expr;
  body: Stmt[];
  /** Bloc `else`, execute seulement si la boucle s'est terminee sans `break`. */
  orelse: Stmt[] | null;
}

export interface BreakStatement extends Node {
  kind: 'break';
}

export interface ContinueStatement extends Node {
  kind: 'continue';
}

export interface PassStatement extends Node {
  kind: 'pass';
}

export interface Param {
  name: string;
  default?: Expr;
  /** `*args`. */
  isVarArg?: boolean;
  /** `**kwargs`. */
  isDoubleVarArg?: boolean;
  /** `/` : tout ce qui precede est positionnel. */
  isPosOnlyMarker?: boolean;
  /** `*` seul : ce qui suit est mot-cle uniquement. */
  isKeywordOnlyMarker?: boolean;
  /** Parametre situe apres `*args` ou `*`. */
  isKeywordOnly?: boolean;
  annotation?: string;
}

export interface FunctionStatement extends Node {
  kind: 'function';
  name: string;
  params: Param[];
  body: Stmt[];
  returnAnnotation: string | null;
}

export interface ClassStatement extends Node {
  kind: 'class';
  name: string;
  bases: Expr[];
  body: Stmt[];
}

export interface ReturnStatement extends Node {
  kind: 'return';
  value: Expr | null;
}

export interface ImportStatement extends Node {
  kind: 'import';
  /** Chemin pointte, ex. `os.path`. */
  module: string;
  alias: string | null;
}

export interface ImportFromStatement extends Node {
  kind: 'import-from';
  module: string;
  names: Array<{ name: string; alias: string | null }>;
  wildcard: boolean;
}

export interface ExceptClause extends Node {
  kind: 'except';
  /** `null` equivaut a un `except` nu. */
  type: Expr | null;
  name: string | null;
  body: Stmt[];
}

export interface TryStatement extends Node {
  kind: 'try';
  body: Stmt[];
  handlers: ExceptClause[];
  elseBody: Stmt[] | null;
  finallyBody: Stmt[] | null;
}

export interface RaiseStatement extends Node {
  kind: 'raise';
  value: Expr | null;
  cause: Expr | null;
}

export interface AssertStatement extends Node {
  kind: 'assert';
  test: Expr;
  message: Expr | null;
}

export interface GlobalStatement extends Node {
  kind: 'global';
  names: string[];
}

export interface NonlocalStatement extends Node {
  kind: 'nonlocal';
  names: string[];
}

export interface DelStatement extends Node {
  kind: 'del';
  targets: Expr[];
}

// ============================================================== Programme

export interface Program extends Node {
  kind: 'program';
  body: Stmt[];
}

/** Reexport pratique pour la suite du code. */
export type { SourceLocation, TokenType };
