/**
 * Parser Uchi.
 *
 * Recursion descendante pour les instructions, analyse descendante a
 * precedence de Pratt pour les expressions.
 *
 * Le style `parseExpression` / `parsePrecedence` permet d'integrer tres
 * simplement les constructions propres a Uchi comme `x if cond else y`.
 */

import { TokenType, describeToken, type Token } from '../lexer/tokens.ts';
import { tokenize } from '../lexer/lexer.ts';
import { UchiSyntaxError, type SourceFile, type SourceLocation } from '../errors.ts';
import type {
  Argument,
  AssignTarget,
  AugAssignOp,
  BinaryOp,
  ComparisonOp,
  ComprehensionClause,
  ComprehensionExpr,
  Expr,
  ExceptClause,
  FStringPart,
  IfAlternate,
  IfStatement,
  Param,
  Program,
  Stmt,
  UnaryOp,
  WithItem,
} from './ast.ts';

// ------------------------------------------------------------ precedences

const BP_TERNARY = 2;
const BP_OR = 4;
const BP_AND = 6;
const BP_NOT = 8;
const BP_COMPARE = 9;
const BP_BIT_OR = 12;
const BP_BIT_XOR = 14;
const BP_BIT_AND = 16;
const BP_SHIFT = 18;
const BP_TERM = 20;
const BP_FACTOR = 22;
const BP_UNARY = 24;
const BP_POWER = 26;
const BP_POSTFIX = 28;

/** Puissance de liaison gauche, par token infixe. */
const INFIX_BINDING_POWER: Partial<Record<TokenType, number>> = {
  [TokenType.OR]: BP_OR,
  [TokenType.AND]: BP_AND,
  [TokenType.EQ_EQ]: BP_COMPARE,
  [TokenType.BANG_EQ]: BP_COMPARE,
  [TokenType.LT]: BP_COMPARE,
  [TokenType.LT_EQ]: BP_COMPARE,
  [TokenType.GT]: BP_COMPARE,
  [TokenType.GT_EQ]: BP_COMPARE,
  [TokenType.IN]: BP_COMPARE,
  [TokenType.IS]: BP_COMPARE,
  [TokenType.NOT]: BP_COMPARE, // uniquement `not in`
  [TokenType.PIPE]: BP_BIT_OR,
  [TokenType.CARET]: BP_BIT_XOR,
  [TokenType.AMPERSAND]: BP_BIT_AND,
  [TokenType.LT_LT]: BP_SHIFT,
  [TokenType.GT_GT]: BP_SHIFT,
  [TokenType.PLUS]: BP_TERM,
  [TokenType.MINUS]: BP_TERM,
  [TokenType.STAR]: BP_FACTOR,
  [TokenType.SLASH]: BP_FACTOR,
  [TokenType.SLASH_SLASH]: BP_FACTOR,
  [TokenType.PERCENT]: BP_FACTOR,
  [TokenType.AT]: BP_FACTOR,
  [TokenType.STAR_STAR]: BP_POWER,
  [TokenType.LPAREN]: BP_POSTFIX,
  [TokenType.LBRACKET]: BP_POSTFIX,
  [TokenType.DOT]: BP_POSTFIX,
};

const BINARY_OPERATORS: Partial<Record<TokenType, BinaryOp>> = {
  [TokenType.PLUS]: '+',
  [TokenType.MINUS]: '-',
  [TokenType.STAR]: '*',
  [TokenType.SLASH]: '/',
  [TokenType.SLASH_SLASH]: '//',
  [TokenType.PERCENT]: '%',
  [TokenType.AT]: '@',
  [TokenType.STAR_STAR]: '**',
  [TokenType.PIPE]: '|',
  [TokenType.CARET]: '^',
  [TokenType.AMPERSAND]: '&',
  [TokenType.LT_LT]: '<<',
  [TokenType.GT_GT]: '>>',
};

/** L'operateur `**` est associatif a droite : sa puissance droite vaut sa gauche. */
function rightBindingPower(left: number, type: TokenType): number {
  return type === TokenType.STAR_STAR ? BP_POWER : left + 1;
}

const AUGMENTED_OPERATORS: Partial<Record<TokenType, AugAssignOp>> = {
  [TokenType.PLUS_EQ]: '+=',
  [TokenType.MINUS_EQ]: '-=',
  [TokenType.STAR_EQ]: '*=',
  [TokenType.SLASH_EQ]: '/=',
  [TokenType.SLASH_SLASH_EQ]: '//=',
  [TokenType.PERCENT_EQ]: '%=',
  [TokenType.STAR_STAR_EQ]: '**=',
  [TokenType.AT_EQ]: '@=',
};

const UNARY_OPERATORS: Partial<Record<TokenType, UnaryOp>> = {
  [TokenType.MINUS]: '-',
  [TokenType.PLUS]: '+',
  [TokenType.NOT]: 'not',
  [TokenType.TILDE]: '~',
};

/** Correspondance operateur augmentee -> operateur binaire sous-jacent. */
export const AUGMENTED_TO_BINARY: Readonly<Record<AugAssignOp, BinaryOp>> = {
  '+=': '+',
  '-=': '-',
  '*=': '*',
  '/=': '/',
  '//=': '//',
  '%=': '%',
  '**=': '**',
  '@=': '@',
};

export function parse(source: string, path = '<inconnu>'): Program {
  return parseTokens(tokenize(source, path), source, path);
}

/** Analyse une source deja tokenisee (utile pour les tests et le REPL). */
export function parseTokens(tokens: Token[], source: string, path = '<inconnu>'): Program {
  return new Parser(source, { path, text: source }, tokens).parseProgram();
}

/** Une cible eventuellement annotee, avant validation. */
interface TargetPart {
  expression: Expr;
  annotation: string | null;
}

class Parser {
  private current = 0;
  private readonly file: SourceFile;
  private readonly tokens: Token[];

  private readonly source: string;

  constructor(source: string, file: SourceFile, tokens?: Token[]) {
    this.source = source;
    this.file = file;
    this.tokens = tokens ?? [];
  }

  // ------------------------------------------------------- gestion des tokens

  private get previous(): Token {
    return this.tokens[this.current - 1];
  }

  private peek(offset = 0): Token {
    return this.tokens[this.current + offset];
  }

  private check(type: TokenType): boolean {
    const t = this.peek();
    return t !== undefined && t.type === type;
  }

  private checkNext(type: TokenType): boolean {
    const t = this.peek(1);
    return t !== undefined && t.type === type;
  }

  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.current++;
        return true;
      }
    }
    return false;
  }

  private advance(): Token {
    if (!this.atEnd) this.current++;
    return this.previous;
  }

  private get atEnd(): boolean {
    const t = this.peek();
    return t === undefined || t.type === TokenType.EOF;
  }

  /** Fin de ligne logique : ou une instruction se termine. */
  private get endOfStatement(): boolean {
    return this.atEnd || this.check(TokenType.NEWLINE) || this.check(TokenType.SEMICOLON) || this.check(TokenType.DEDENT);
  }

  /**
   * Cherche un `=` d'affectation supplementaire sur la ligne courante, en
   * ignorant le contenu des parentheses et des crochets.
   *
   * C'est ce qui permet de distinguer `a = b = 1` (deux cibles) de `a = b`
   * (une cible et une valeur), que le lexer ne differentiate pas a priori.
   */
  private hasChainedAssign(): boolean {
    let depth = 0;
    for (let offset = 0; ; offset++) {
      const tok = this.peek(offset);
      if (tok === undefined) return false;
      if (tok.type === TokenType.NEWLINE || tok.type === TokenType.SEMICOLON) return false;
      if (tok.type === TokenType.EOF) return false;
      // Un corps de lambda s'etend jusqu'a la fin de la ligne et peut contenir
      // des affectations (`lambda x=1: x`) : ce ne sont pas des-cibles.
      if (depth === 0 && tok.type === TokenType.LAMBDA) return false;
      if (tok.type === TokenType.LPAREN || tok.type === TokenType.LBRACKET || tok.type === TokenType.LBRACE) {
        depth++;
      } else if (tok.type === TokenType.RPAREN || tok.type === TokenType.RBRACKET || tok.type === TokenType.RBRACE) {
        depth--;
      } else if (depth === 0 && tok.type === TokenType.EQ) {
        return true;
      }
    }
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    this.error(message);
  }

  private error(message: string, tok?: Token): never {
    const t = tok ?? this.peek();
    if (t === undefined) {
      throw new UchiSyntaxError(message, {
        file: this.file,
        line: this.source.split('\n').length,
        column: 0,
      });
    }
    throw new UchiSyntaxError(message, { file: this.file, line: t.line, column: t.column });
  }

  private loc(tok: Token): SourceLocation {
    return { line: tok.line, column: tok.column };
  }

  // -------------------------------------------------------------- programme

  parseProgram(): Program {
    if (this.tokens.length === 0) {
      this.error('source vide : le lexer n a produit aucun token');
    }
    const body = this.parseStatementList(null);
    if (!this.atEnd) this.error(`instruction inattendue ${describeToken(this.peek())}`);
    return { kind: 'program', body };
  }

  private parseStatementList(terminator: TokenType | null): Stmt[] {
    const statements: Stmt[] = [];
    for (;;) {
      while (this.match(TokenType.NEWLINE)) {
        // ligne vide
      }
      if (this.atEnd) break;
      if (terminator !== null && this.check(terminator)) break;
      statements.push(...this.parseStatement());
    }
    return statements;
  }

  private parseStatement(): Stmt[] {
    switch (this.peek().type) {
      case TokenType.IF:
      case TokenType.WHILE:
      case TokenType.FOR:
      case TokenType.WITH:
      case TokenType.DEF:
      case TokenType.CLASS:
      case TokenType.TRY:
        return [this.parseCompoundStatement()];
      default:
        return this.parseSimpleStatementLine();
    }
  }

  private parseCompoundStatement(): Stmt {
    switch (this.peek().type) {
      case TokenType.IF:
        return this.parseIfStatement();
      case TokenType.WHILE:
        return this.parseWhileStatement();
      case TokenType.FOR:
        return this.parseForStatement();
      case TokenType.WITH:
        return this.parseWithStatement();
      case TokenType.DEF:
        return this.parseFunctionStatement();
      case TokenType.CLASS:
        return this.parseClassStatement();
      default:
        return this.parseTryStatement();
    }
  }

  // -------------------------------------------------- instructions simples

  private parseSimpleStatementLine(): Stmt[] {
    const statements: Stmt[] = [this.parseSimpleStatement()];
    while (this.match(TokenType.SEMICOLON)) {
      if (this.endOfStatement) break;
      statements.push(this.parseSimpleStatement());
    }
    if (this.match(TokenType.NEWLINE)) return statements;
    if (this.atEnd || this.check(TokenType.DEDENT)) return statements;
    this.error(`attendu fin de ligne, trouve ${describeToken(this.peek())}`);
  }

  private parseSimpleStatement(): Stmt {
    const tok = this.peek();
    switch (tok.type) {
      case TokenType.BREAK:
        this.advance();
        return { kind: 'break', loc: this.loc(tok) };
      case TokenType.CONTINUE:
        this.advance();
        return { kind: 'continue', loc: this.loc(tok) };
      case TokenType.PASS:
        this.advance();
        return { kind: 'pass', loc: this.loc(tok) };
      case TokenType.RETURN:
        return this.parseReturnStatement();
      case TokenType.IMPORT:
        return this.parseImportStatement();
      case TokenType.FROM:
        return this.parseImportFromStatement();
      case TokenType.RAISE:
        return this.parseRaiseStatement();
      case TokenType.ASSERT:
        return this.parseAssertStatement();
      case TokenType.GLOBAL:
        return this.parseGlobalLike('global');
      case TokenType.NONLOCAL:
        return this.parseGlobalLike('nonlocal');
      case TokenType.DEL:
        return this.parseDelStatement();
      default:
        return this.parseExpressionOrAssignment();
    }
  }

  private parseReturnStatement(): Stmt {
    const tok = this.advance();
    const loc = this.loc(tok);
    if (this.endOfStatement) return { kind: 'return', value: null, loc };
    return { kind: 'return', value: this.parseExpressionListAsExpr(), loc };
  }

  private parseGlobalLike(kind: 'global' | 'nonlocal'): Stmt {
    const tok = this.advance();
    const loc = this.loc(tok);
    const names: string[] = [this.consume(TokenType.NAME, 'nom de variable attendu').lexeme];
    while (this.match(TokenType.COMMA)) {
      names.push(this.consume(TokenType.NAME, 'nom de variable attendu').lexeme);
    }
    return kind === 'global' ? { kind: 'global', names, loc } : { kind: 'nonlocal', names, loc };
  }

  private parseDelStatement(): Stmt {
    const tok = this.advance();
    const loc = this.loc(tok);
    const targets: Expr[] = [this.parseExpression()];
    while (this.match(TokenType.COMMA) && !this.endOfStatement) {
      targets.push(this.parseExpression());
    }
    return { kind: 'del', targets, loc };
  }

  private parseAssertStatement(): Stmt {
    const tok = this.advance();
    const loc = this.loc(tok);
    const test = this.parseExpression();
    let message: Expr | null = null;
    if (this.match(TokenType.COMMA) && !this.endOfStatement) message = this.parseExpression();
    return { kind: 'assert', test, message, loc };
  }

  private parseRaiseStatement(): Stmt {
    const tok = this.advance();
    const loc = this.loc(tok);
    if (this.endOfStatement) return { kind: 'raise', value: null, cause: null, loc };
    const value = this.parseExpression();
    let cause: Expr | null = null;
    if (this.match(TokenType.FROM)) cause = this.parseExpression();
    return { kind: 'raise', value, cause, loc };
  }

  private parseImportStatement(): Stmt {
    const tok = this.advance();
    const loc = this.loc(tok);
    const module = this.parseDottedPath();
    let alias: string | null = null;
    if (this.match(TokenType.AS)) {
      alias = this.consume(TokenType.NAME, "nom d'alias attendu").lexeme;
    }
    return { kind: 'import', module, alias, loc };
  }

  private parseImportFromStatement(): Stmt {
    const tok = this.advance();
    const loc = this.loc(tok);
    const module = this.parseDottedPath();
    this.consume(TokenType.IMPORT, "'import' attendu apres le nom du module");
    if (this.match(TokenType.STAR)) {
      return { kind: 'import-from', module, names: [], wildcard: true, loc };
    }
    const names: Array<{ name: string; alias: string | null }> = [];
    do {
      const name = this.consume(TokenType.NAME, 'nom attendu apres import').lexeme;
      let alias: string | null = null;
      if (this.match(TokenType.AS)) {
        alias = this.consume(TokenType.NAME, "nom d'alias attendu").lexeme;
      }
      names.push({ name, alias });
    } while (this.match(TokenType.COMMA) && !this.endOfStatement);
    return { kind: 'import-from', module, names, wildcard: false, loc };
  }

  private parseDottedPath(): string {
    let path = this.consume(TokenType.NAME, 'nom de module attendu').lexeme;
    while (this.match(TokenType.DOT)) {
      path += `.${this.consume(TokenType.NAME, 'nom attendu apres .').lexeme}`;
    }
    return path;
  }

  // ------------------------------------------ affectation / expression simple

  /**
   * Analyse une ligne commencant par une expression : statement,
   * affectation simple, multiple, annotee ou augmentee.
   */
  private parseExpressionOrAssignment(): Stmt {
    const parts = this.parseTargetParts();

    const tok = this.peek();
    const augOp = AUGMENTED_OPERATORS[tok.type];
    if (augOp !== undefined) {
      if (parts.length !== 1) this.error('une affectation augmentee accepte une seule cible', tok);
      const part = parts[0];
      if (part.annotation !== null) this.error("l'annotation de type doit suivre l'affectation", tok);
      this.advance();
      const target = this.toAssignTarget(part.expression);
      const value = this.parseExpressionListAsExpr();
      return { kind: 'aug-assign', target, op: augOp, value, annotation: null, loc: this.loc(tok) };
    }

    if (this.match(TokenType.EQ)) {
      // Affectation enchainee : `a = b = valeur` vise plusieurs cibles.
      const targets: AssignTarget[] = [this.toAssignTarget(parts[0].expression)];
      const annotations: Array<string | null> = [parts[0].annotation];
      while (this.hasChainedAssign()) {
        for (const part of this.parseTargetParts()) {
          if (part.annotation !== null) {
            this.error("l'annotation de type doit suivre l'affectation", this.findTokenAt(part.expression.loc));
          }
          targets.push(this.toAssignTarget(part.expression));
          annotations.push(null);
        }
        this.consume(TokenType.EQ, "'=' attendu dans l'affectation enchainee");
      }
      const value = this.parseExpressionListAsExpr();
      return { kind: 'assign', targets, value, annotations, loc: value.loc };
    }

    // Pas d'affectation.
    if (parts.length === 1) {
      const part = parts[0];
      if (part.annotation === null) {
        return { kind: 'expr-statement', expression: part.expression, loc: part.expression.loc };
      }
      // Declaration seule : `x: int`
      return {
        kind: 'assign',
        targets: [this.toAssignTarget(part.expression)],
        value: { kind: 'none' },
        annotations: [part.annotation],
        loc: part.expression.loc,
      };
    }

    // `a, b` seul : c'est un tuple.
    return {
      kind: 'expr-statement',
      expression: this.makeTuple(parts.map((part) => part.expression), false),
      loc: parts[0].expression.loc,
    };
  }

  /** Liste separee par des virgules, chaque element pouvant etre annote. */
  private parseTargetParts(): TargetPart[] {
    const parts: TargetPart[] = [];
    let separatedByComma = false;
    do {
      // `*reste` : cible etiquetee pour le depaquetage.
      if (this.match(TokenType.STAR)) {
        const operand = this.parseExpression();
        parts.push({
          expression: { kind: 'star', operand, loc: operand.loc },
          annotation: null,
        });
      } else {
        const expression = this.parseExpression();
        let annotation: string | null = null;
        if (this.match(TokenType.COLON)) annotation = this.parseTypeAnnotation();
        parts.push({ expression, annotation });
      }
      if (this.match(TokenType.COMMA) && !this.endOfStatement) separatedByComma = true;
      else break;
    } while (true);
    // `a, b = ...` cible un tuple, alors que `a = b = ...` vise deux cibles
    // independantes : seule la presence reelle d'une virgule permet de
    // distinguer les deux formes.
    if (separatedByComma) {
      const annotated = parts.find((part) => part.annotation !== null);
      if (annotated !== undefined) {
        this.error(
          "une annotation de type n'est pas acceptee sur une liste de cibles",
          this.findTokenAt(annotated.expression.loc),
        );
      }
      return [
        { expression: this.makeTuple(parts.map((part) => part.expression), false), annotation: null },
      ];
    }
    return parts;
  }

  private toAssignTarget(expression: Expr): AssignTarget {
    switch (expression.kind) {
      case 'name':
      case 'index':
      case 'attribute':
      case 'star':
      case 'tuple':
      case 'list':
        this.validateTarget(expression);
        return expression;
      default:
        return this.error(
          `cible d'affectation invalide : ${this.describeExpr(expression)}`,
          this.findTokenAt(expression.loc),
        );
    }
  }

  /**
   * Verifie la forme d'une cible : au plus une etoile, et jamais seule.
   * `a, *b, c = ...` est valide ; `*a = ...` ne l'est pas.
   */
  private validateTarget(target: AssignTarget): void {
    if (target.kind !== 'tuple' && target.kind !== 'list') return;
    let stars = 0;
    for (const element of target.elements) {
      if (element.kind === 'star') {
        stars++;
        if (element.operand.kind === 'star') this.error('deux etoiles consecutives ne sont pas autorisees');
        continue;
      }
      if (element.kind === 'tuple' || element.kind === 'list') this.validateTarget(element);
    }
    if (stars > 1) this.error('une seule cible peut etre prefixee par une etoile');
    if (target.elements.length === 1 && stars === 1) {
      this.error("une cible 'etoile' doit etre accompagnee d'autres cibles");
    }
  }

  private describeExpr(expression: Expr): string {
    switch (expression.kind) {
      case 'name':
        return `le nom '${expression.id}'`;
      case 'call':
        return 'un appel de fonction';
      case 'string':
      case 'int':
      case 'float':
        return 'une valeur litterale';
      case 'binary':
        return 'une expression arithmetique';
      case 'fstring':
        return 'une f-string';
      default:
        return `une expression de type ${expression.kind}`;
    }
  }

  private findTokenAt(loc: SourceLocation | undefined): Token | undefined {
    if (loc === undefined) return undefined;
    for (const t of this.tokens) {
      if (t.line === loc.line && t.column === loc.column) return t;
    }
    return undefined;
  }

  // ----------------------------------------------- instructions composees

  private parseIfStatement(): Stmt {
    const tok = this.advance(); // 'if'
    return this.parseIfTail(this.loc(tok));
  }

  /**
   * Analyse `condition : bloc` suivi de `elif`/`else`.
   * Utilise apres consommation du mot-cle `if` comme de `elif`.
   */
  private parseIfTail(loc: SourceLocation): IfStatement {
    const condition = this.parseExpression();
    const consequence = this.parseBlock();
    let alternate: IfAlternate | null = null;
    if (this.match(TokenType.ELIF)) {
      const elifLoc = this.loc(this.previous);
      alternate = { kind: 'elif', statement: this.parseIfTail(elifLoc) };
    } else if (this.match(TokenType.ELSE)) {
      alternate = { kind: 'else', body: this.parseBlock() };
    }
    return { kind: 'if', condition, consequence, alternate, loc };
  }

  private parseWhileStatement(): Stmt {
    const tok = this.advance();
    const condition = this.parseExpression();
    const body = this.parseBlock();
    const orelse = this.match(TokenType.ELSE) ? this.parseBlock() : null;
    return { kind: 'while', condition, body, orelse, loc: this.loc(tok) };
  }

  private parseForStatement(): Stmt {
    const tok = this.advance();
    const target = this.parseForTarget();
    this.consume(TokenType.IN, "'in' attendu dans la boucle for");
    const iterable = this.parseExpressionListAsExpr();
    const body = this.parseBlock();
    const orelse = this.match(TokenType.ELSE) ? this.parseBlock() : null;
    return { kind: 'for', target, iterable, body, orelse, loc: this.loc(tok) };
  }

  /**
   * Cible d'une boucle `for`.
   *
   * Elle est volontairement analysee sans operateur `in` : une expression
   * ordinaire consommerait `in` comme comparaison. Seul un nom, un attribut
   * ou une indexation sont acceptes, eventuellement groupes dans un tuple.
   */
  private parseForTarget(allowTuple: boolean = true): AssignTarget {
    const parts: Expr[] = [];
    do {
      if (this.match(TokenType.STAR)) {
        const operand = this.parseForTargetAtom();
        parts.push({ kind: 'star', operand, loc: operand.loc });
        continue;
      }
      parts.push(this.parseForTargetAtom());
    } while (
      allowTuple && this.match(TokenType.COMMA) && !this.check(TokenType.IN) && !this.endOfStatement
    );

    if (parts.length === 1 && parts[0].kind !== 'star') return this.toAssignTarget(parts[0]);
    const tuple: AssignTarget = { kind: 'tuple', elements: parts, parenthesized: false };
    this.validateTarget(tuple);
    return tuple;
  }

  /** `nom`, `nom.attr` ou `nom[...]`, sans operateur infixe. */
  private parseForTargetAtom(): Expr {
    const tok = this.peek();
    if (tok === undefined || (tok.type !== TokenType.NAME && tok.type !== TokenType.SELF)) {
      this.error("cible d'iteration invalide : un nom est attendu", tok);
    }
    this.advance();
    const loc = this.loc(tok);
    let expr: Expr = { kind: 'name', id: tok.lexeme, loc };

    for (;;) {
      if (this.check(TokenType.DOT)) {
        this.advance();
        const nameTok = this.consume(TokenType.NAME, "nom d'attribut attendu apres '.'");
        expr = { kind: 'attribute', object: expr, name: nameTok.lexeme, loc };
        continue;
      }
      if (this.check(TokenType.LBRACKET)) {
        this.advance();
        expr = this.parseSubscript(expr, loc);
        continue;
      }
      break;
    }
    return expr;
  }

  private parseFunctionStatement(): Stmt {
    const tok = this.advance();
    const name = this.consume(TokenType.NAME, 'nom de fonction attendu').lexeme;
    this.consume(TokenType.LPAREN, "'(' attendu apres le nom de la fonction");
    const params = this.parseParamList();
    this.consume(TokenType.RPAREN, "')' attendu apres la liste de parametres");
    let returnAnnotation: string | null = null;
    if (this.match(TokenType.ARROW)) returnAnnotation = this.parseTypeAnnotation();
    const body = this.parseBlock();
    return { kind: 'function', name, params, body, returnAnnotation, loc: this.loc(tok) };
  }

  private parseClassStatement(): Stmt {
    const tok = this.advance();
    const name = this.consume(TokenType.NAME, 'nom de classe attendu').lexeme;
    const bases: Expr[] = [];
    if (this.match(TokenType.LPAREN)) {
      if (!this.check(TokenType.RPAREN)) {
        do {
          const argTok = this.peek();
          const arg = this.parseOneArgument();
          if (arg.kind !== 'positional') {
            this.error('les arguments nommes ne sont pas supportes dans un en-tete de classe', argTok);
          }
          bases.push(arg.value);
        } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
      }
      this.consume(TokenType.RPAREN, "')' attendu apres la liste de bases");
    }
    const body = this.parseBlock();
    return { kind: 'class', name, bases, body, loc: this.loc(tok) };
  }

  /**
   * `with expr as cible, ... :` — la liste d'items peut etre
   * parenthesee et s'etaler sur plusieurs lignes, comme depuis Python 3.9.
   *
   * La virgule separe les items et non les elements d'une cible : une cible
   * multiple doit s'ecrire `with (a, b) :`.
   */
  private parseWithStatement(): Stmt {
    const tok = this.advance(); // 'with'
    const items: WithItem[] = [];
    const parenthesized = this.match(TokenType.LPAREN);
    do {
      if (parenthesized && this.check(TokenType.RPAREN)) break;
      const context = this.parseExpression();
      let target: AssignTarget | null = null;
      if (this.match(TokenType.AS)) target = this.parseForTarget(false);
      items.push({ context, target });
    } while (this.match(TokenType.COMMA));
    if (parenthesized) this.consume(TokenType.RPAREN, "')' attendu apres la liste des items");
    if (items.length === 0) this.error("'with' requiert au moins un item", tok);
    const body = this.parseBlock();
    return { kind: 'with', items, body, loc: this.loc(tok) };
  }

  private parseTryStatement(): Stmt {    const tok = this.advance();
    const body = this.parseBlock();
    const handlers: ExceptClause[] = [];
    while (this.check(TokenType.EXCEPT)) {
      const exceptTok = this.advance();
      let type: Expr | null = null;
      let name: string | null = null;
      if (!this.check(TokenType.COLON)) {
        type = this.parseExpression();
        if (this.match(TokenType.AS)) {
          name = this.consume(TokenType.NAME, "nom de variable attendu apres 'as'").lexeme;
        } else if (this.match(TokenType.COMMA)) {
          name = this.consume(TokenType.NAME, 'nom de variable attendu').lexeme;
        }
      }
      const handlerBody = this.parseBlock();
      handlers.push({ kind: 'except', type, name, body: handlerBody, loc: this.loc(exceptTok) });
    }
    if (handlers.length === 0) this.error("'try' requiert au moins un bloc 'except'");

    let elseBody: Stmt[] | null = null;
    if (this.match(TokenType.ELSE)) elseBody = this.parseBlock();
    let finallyBody: Stmt[] | null = null;
    if (this.match(TokenType.FINALLY)) finallyBody = this.parseBlock();

    return {
      kind: 'try',
      body,
      handlers,
      elseBody,
      finallyBody,
      loc: this.loc(tok),
    };
  }

  /** `: NEWLINE INDENT ... DEDENT`, avec un `pass` implicite si le bloc est vide. */
  private parseBlock(): Stmt[] {
    this.consume(TokenType.COLON, "':' attendu");

    // Bloc sur une seule ligne : `if x: y = 1`
    if (!this.check(TokenType.NEWLINE)) {
      const body: Stmt[] = [this.parseSimpleStatement()];
      while (this.match(TokenType.SEMICOLON)) {
        if (this.endOfStatement) break;
        body.push(this.parseSimpleStatement());
      }
      this.match(TokenType.NEWLINE);
      return body;
    }

    this.advance();
    if (!this.check(TokenType.INDENT)) {
      // Bloc vide (commentaires seuls) : `pass` implicite.
      return [{ kind: 'pass' }];
    }
    this.advance();
    const body = this.parseStatementList(TokenType.DEDENT);
    this.consume(TokenType.DEDENT, 'fin de bloc attendue : indentation incoherente');
    return body;
  }

  // ========================================================== expressions

  parseExpression(): Expr {
    return this.parsePrecedence(0);
  }

  /**
   * Expression d'une comprehension : le `if` y est un filtre, pas un
   * conditionnel. `parsePrecedence` est donc appele au-dessus de
   * `BP_TERNARY`, ce qui laisse passer `a if b else c` explicite sans
   * confondre le filtre `if cond`.
   */
  private parseComprehensionExpression(): Expr {
    return this.parsePrecedence(BP_TERNARY + 1);
  }

  private parsePrecedence(minBp: number): Expr {
    let left = this.parsePrefix();

    for (;;) {
      const tok = this.peek();

      // Expression conditionnelle : `vraie_si cond sinon_faux`
      if (tok !== undefined && tok.type === TokenType.IF && minBp <= BP_TERNARY) {
        this.advance();
        const test = this.parsePrecedence(BP_TERNARY + 1);
        this.consume(TokenType.ELSE, "'else' attendu dans l'expression conditionnelle");
        const alternate = this.parsePrecedence(BP_TERNARY);
        left = { kind: 'conditional', test, consequent: left, alternate, loc: left.loc };
        continue;
      }

      // Operateurs de comparaison, y compris chaines : `a < b <= c`.
      // `minBp` doit etre.verifie : sans cela `2 % 2 == 0` serait lu comme
      // `2 % (2 == 0)`, puisque `%` lie plus fort que `==`.
      const firstOp = minBp <= BP_COMPARE ? this.matchComparisonOperator() : null;
      if (firstOp !== null) {
        const operands: Expr[] = [left];
        const ops: ComparisonOp[] = [];
        let op: ComparisonOp | null = firstOp;
        while (op !== null) {
          operands.push(this.parsePrecedence(BP_COMPARE + 1));
          ops.push(op);
          op = this.matchComparisonOperator();
        }
        left = { kind: 'comparison', operands, ops, loc: left.loc };
        continue;
      }

      const bp = tok === undefined ? undefined : INFIX_BINDING_POWER[tok.type];
      if (bp === undefined || bp < minBp) break;
      left = this.parseInfix(left, tok, bp);
    }

    return left;
  }

  /**
   * Reconnaît un operateur de comparaison et le consomme.
   * Gere les operateurs sur deux tokens : `is not` et `not in`.
   * Retourne `null` sans consommer si le token courant n'en est pas un.
   */
  private matchComparisonOperator(): ComparisonOp | null {
    const tok = this.peek();
    if (tok === undefined) return null;
    if (tok.type === TokenType.NOT && this.checkNext(TokenType.IN)) {
      this.advance();
      this.advance();
      return 'not in';
    }
    if (tok.type === TokenType.IS && this.checkNext(TokenType.NOT)) {
      this.advance();
      this.advance();
      return 'is not';
    }
    let op: ComparisonOp | null;
    switch (tok.type) {
      case TokenType.EQ_EQ:
        op = '==';
        break;
      case TokenType.BANG_EQ:
        op = '!=';
        break;
      case TokenType.LT:
        op = '<';
        break;
      case TokenType.LT_EQ:
        op = '<=';
        break;
      case TokenType.GT:
        op = '>';
        break;
      case TokenType.GT_EQ:
        op = '>=';
        break;
      case TokenType.IN:
        op = 'in';
        break;
      case TokenType.IS:
        op = 'is';
        break;
      default:
        return null;
    }
    this.advance();
    return op;
  }

  /** Applique un operateur infixe ; le token operateur est encore courant. */
  private parseInfix(left: Expr, tok: Token, bp: number): Expr {
    const loc = left.loc ?? this.loc(tok);
    this.advance(); // consomme l'operateur

    switch (tok.type) {
      case TokenType.PLUS:
      case TokenType.MINUS:
      case TokenType.STAR:
      case TokenType.SLASH:
      case TokenType.SLASH_SLASH:
      case TokenType.PERCENT:
      case TokenType.AT:
      case TokenType.PIPE:
      case TokenType.CARET:
      case TokenType.AMPERSAND:
      case TokenType.LT_LT:
      case TokenType.GT_GT:
      case TokenType.STAR_STAR: {
        const op = BINARY_OPERATORS[tok.type];
        if (op === undefined) this.error(`operateur inconnu ${tok.lexeme}`, tok);
        const right = this.parsePrecedence(rightBindingPower(bp, tok.type));
        return { kind: 'binary', op, left, right, loc };
      }
      case TokenType.AND:
      case TokenType.OR: {
        const right = this.parsePrecedence(rightBindingPower(bp, tok.type));
        return { kind: 'logical', op: tok.type === TokenType.AND ? 'and' : 'or', left, right, loc };
      }
      case TokenType.LPAREN:
        return this.parseCall(left, loc);
      case TokenType.LBRACKET:
        return this.parseSubscript(left, loc);
      case TokenType.DOT: {
        const nameTok = this.peek();
        if (nameTok === undefined || (nameTok.type !== TokenType.NAME && nameTok.type !== TokenType.SELF)) {
          this.error("nom d'attribut attendu apres '.'", nameTok);
        }
        this.advance();
        return { kind: 'attribute', object: left, name: nameTok.lexeme, loc };
      }
      default:
        return this.error(`operateur inattendu ${describeToken(tok)}`, tok);
    }
  }

  private parseCall(callee: Expr, loc: SourceLocation | undefined): Expr {
    const args: Argument[] = [];
    if (!this.check(TokenType.RPAREN)) {
      do {
        if (this.check(TokenType.RPAREN)) break;
        if (args.length === 0 && this.startsGeneratorArgument()) {
          const open = this.peek() as Token;
          const element = this.parseExpression();
          if (this.check(TokenType.FOR)) {
            // `f(x for x in y)` : l'expression generatrice est le seul argument
            // admissible, comme en Python. Elle produit une liste.
            const comprehension = this.parseComprehensionTail(
              this.loc(open),
              element,
              null,
              false,
              TokenType.RPAREN,
              false,
            );
            if (this.check(TokenType.COMMA)) {
              this.error(
                "une expression generatrice doit etre l'unique argument de l'appel (il faut la parentheser)",
                this.peek(),
              );
            }
            this.consume(TokenType.RPAREN, "')' attendu pour fermer l'appel");
            args.push({ kind: 'positional', value: comprehension });
            return { kind: 'call', callee, args, loc };
          }
          args.push({ kind: 'positional', value: element });
          continue;
        }
        args.push(this.parseOneArgument());
      } while (this.match(TokenType.COMMA));
    }
    this.consume(TokenType.RPAREN, "')' attendu pour fermer l'appel");
    return { kind: 'call', callee, args, loc };
  }

  /** Vrai si l'appel commence par une expression simple, donc pas par `*x` ou `x=1`. */
  private startsGeneratorArgument(): boolean {
    if (this.check(TokenType.RPAREN) || this.check(TokenType.FOR)) return false;
    if (this.check(TokenType.STAR) || this.check(TokenType.STAR_STAR)) return false;
    return !(this.check(TokenType.NAME) && this.checkNext(TokenType.EQ));
  }

  private parseOneArgument(): Argument {
    if (this.match(TokenType.STAR_STAR)) {
      return { kind: 'double-star', value: this.parseExpression() };
    }
    if (this.match(TokenType.STAR)) {
      return { kind: 'star', value: this.parseExpression() };
    }
    if (this.check(TokenType.NAME) && this.checkNext(TokenType.EQ)) {
      const name = this.advance().lexeme;
      this.advance(); // '='
      return { kind: 'keyword', name, value: this.parseExpression() };
    }
    return { kind: 'positional', value: this.parseExpression() };
  }

  /** `a[...]` : indexation ou tranche. Le '[' est deja consomme. */
  private parseSubscript(object: Expr, loc: SourceLocation | undefined): Expr {
    let result: Expr;
    if (this.check(TokenType.COLON)) {
      result = this.parseSliceTail(object, null, loc);
    } else {
      const index = this.parseExpression();
      if (this.check(TokenType.COLON)) {
        result = this.parseSliceTail(object, index, loc);
      } else {
        this.consume(TokenType.RBRACKET, "']' attendu");
        result = { kind: 'index', object, index, loc };
      }
    }
    return result;
  }

  private parseSliceTail(
    object: Expr,
    lower: Expr | null,
    loc: SourceLocation | undefined,
  ): Expr {
    this.consume(TokenType.COLON, "':' attendu dans la tranche");
    let upper: Expr | null = null;
    if (!this.check(TokenType.COLON) && !this.check(TokenType.RBRACKET)) {
      upper = this.parseExpression();
    }
    let step: Expr | null = null;
    if (this.match(TokenType.COLON)) {
      if (!this.check(TokenType.RBRACKET)) step = this.parseExpression();
    }
    this.consume(TokenType.RBRACKET, "']' attendu pour fermer la tranche");
    return { kind: 'slice', object, lower, upper, step, loc };
  }

  // ------------------------------------------------------- operandes

  private parsePrefix(): Expr {
    const tok = this.peek();
    if (tok === undefined) this.error('expression incomplete');

    const unaryOp = UNARY_OPERATORS[tok.type];
    if (unaryOp !== undefined) {
      this.advance();
      const operand = this.parsePrecedence(BP_UNARY);
      return { kind: 'unary', op: unaryOp, operand, loc: this.loc(tok) };
    }

    switch (tok.type) {
      case TokenType.LAMBDA:
        return this.parseLambda();
      case TokenType.INT: {
        this.advance();
        const value = Number.parseInt(tok.lexeme.replace(/_/g, ''), literalBase(tok.lexeme));
        return { kind: 'int', value, loc: this.loc(tok) };
      }
      case TokenType.FLOAT: {
        this.advance();
        return { kind: 'float', value: Number.parseFloat(tok.lexeme.replace(/_/g, '')), loc: this.loc(tok) };
      }
      case TokenType.STRING: {
        this.advance();
        // Concatenation implicite de chaines adjacentes : `"a" "b"`.
        let value = tok.lexeme;
        while (this.check(TokenType.STRING)) value += this.advance().lexeme;
        return { kind: 'string', value, loc: this.loc(tok) };
      }
      case TokenType.FSTRING_START:
        return this.parseFString();
      case TokenType.TRUE:
        this.advance();
        return { kind: 'bool', value: true, loc: this.loc(tok) };
      case TokenType.FALSE:
        this.advance();
        return { kind: 'bool', value: false, loc: this.loc(tok) };
      case TokenType.NONE:
        this.advance();
        return { kind: 'none', loc: this.loc(tok) };
      case TokenType.SELF:
        this.advance();
        return { kind: 'name', id: 'self', loc: this.loc(tok) };
      case TokenType.NAME:
        this.advance();
        return { kind: 'name', id: tok.lexeme, loc: this.loc(tok) };
      case TokenType.LPAREN:
        return this.parseParenthesized();
      case TokenType.LBRACKET:
        return this.parseListLiteral();
      case TokenType.LBRACE:
        return this.parseBraceLiteral();
      default:
        return this.error(`expression invalide : ${describeToken(tok)}`, tok);
    }
  }

  private parseParenthesized(): Expr {
    const tok = this.advance(); // '('
    if (this.match(TokenType.RPAREN)) {
      return { kind: 'tuple', elements: [], parenthesized: true, loc: this.loc(tok) };
    }
    const first = this.parseExpression();
    if (this.check(TokenType.FOR)) {
      // `(n for n in y)` : une expression generatrice entouree de parentheses
      // peutsuivre d'autres arguments, comme `(n for n in y), 0`.
      return this.parseComprehensionTail(
        this.loc(tok),
        first,
        null,
        false,
        TokenType.RPAREN,
      );
    }
    if (this.match(TokenType.RPAREN)) {
      return first; // simple parenthese
    }
    const elements: Expr[] = [first];
    while (this.match(TokenType.COMMA)) {
      if (this.check(TokenType.RPAREN)) break;
      elements.push(this.parseExpression());
    }
    this.consume(TokenType.RPAREN, "')' attendu");
    return { kind: 'tuple', elements, parenthesized: true, loc: this.loc(tok) };
  }

  private parseListLiteral(): Expr {
    const tok = this.advance(); // '['
    const elements: Expr[] = [];
    if (!this.check(TokenType.RBRACKET)) {
      const first = this.parseExpression();
      // `[x for ...]` : la virgule n'est pas une separation d'elements.
      if (this.check(TokenType.FOR)) {
        return this.parseComprehensionTail(this.loc(tok), first, null, false, TokenType.RBRACKET);
      }
      elements.push(first);
      while (this.match(TokenType.COMMA)) {
        if (this.check(TokenType.RBRACKET)) break;
        if (this.match(TokenType.STAR)) {
          elements.push({ kind: 'star', operand: this.parseExpression(), loc: this.loc(tok) });
        } else {
          elements.push(this.parseExpression());
        }
      }
    }
    this.consume(TokenType.RBRACKET, "']' attendu");
    return { kind: 'list', elements, loc: this.loc(tok) };
  }

  /** `{...}` : dictionnaire ou ensemble. */
  private parseBraceLiteral(): Expr {
    const tok = this.advance(); // '{'
    if (this.match(TokenType.RBRACE)) {
      return { kind: 'dict', entries: [], loc: this.loc(tok) };
    }

    // Un ensemble si le premier element n'est pas suivi de ':'.
    const firstKey = this.parseExpression();
    if (this.check(TokenType.FOR)) {
      return this.parseComprehensionTail(tok, firstKey, null, true, TokenType.RBRACE);
    }
    if (!this.check(TokenType.COLON)) {
      const elements: Expr[] = [firstKey];
      while (this.match(TokenType.COMMA)) {
        if (this.check(TokenType.RBRACE)) break;
        elements.push(this.parseExpression());
      }
      this.consume(TokenType.RBRACE, "'}' attendu");
      return { kind: 'set', elements, loc: this.loc(tok) };
    }

    const entries: Array<{ key: Expr; value: Expr }> = [];
    let key = firstKey;
    for (;;) {
      this.consume(TokenType.COLON, "':' attendu dans le dictionnaire");
      const value = this.parseExpression();
      // Comprehension de dictionnaire : `{cle: valeur for ...}`.
      if (entries.length === 0 && this.check(TokenType.FOR)) {
        return this.parseComprehensionTail(tok, key, value, false, TokenType.RBRACE);
      }
      entries.push({ key, value });
      if (!this.match(TokenType.COMMA)) break;
      if (this.check(TokenType.RBRACE)) break;
      key = this.parseExpression();
    }
    this.consume(TokenType.RBRACE, "'}' attendu");
    return { kind: 'dict', entries, loc: this.loc(tok) };
  }

  /**
   * Analyse les clauses `for ... in ...` et `if ...` d'une comprehension.
   *
   * `element` est l'expression produite, `valueElement` la seconde expression
   * d'une comprehension de dictionnaire (`{cle: valeur for ...}`).
   */
  private parseComprehensionTail(
    loc: SourceLocation,
    element: Expr,
    valueElement: Expr | null,
    asSet: boolean,
    terminator: TokenType,
    consumeTerminator: boolean = true,
  ): ComprehensionExpr {
    const clauses: ComprehensionClause[] = [];
    for (;;) {
      if (this.match(TokenType.FOR)) {
        const target = this.parseForTarget();
        this.consume(TokenType.IN, "'in' attendu dans la comprehension");
        clauses.push({ kind: 'for', target, iterable: this.parseComprehensionExpression() });
        continue;
      }
      if (this.match(TokenType.IF)) {
        clauses.push({ kind: 'if', condition: this.parseComprehensionExpression() });
        continue;
      }
      break;
    }
    if (!consumeTerminator) return { kind: 'comprehension', element, valueElement, asSet, clauses, loc };
    this.consume(
      terminator,
      terminator === TokenType.RBRACE
        ? "'}' attendu"
        : terminator === TokenType.RPAREN
          ? "')' attendu pour fermer l'appel"
          : "']' attendu",
    );
    return { kind: 'comprehension', element, valueElement, asSet, clauses, loc };
  }

  private parseLambda(): Expr {
    const tok = this.advance(); // 'lambda'
    // Pas d'annotation dans un lambda : `lambda n: ...` doit fermeture sur le
    // deuxieme `:`.
    const params = this.check(TokenType.COLON) ? [] : this.parseParamList(TokenType.COLON, false);
    this.consume(TokenType.COLON, "':' attendu dans lambda");
    const body = this.parseExpression();
    return { kind: 'lambda', params, body, loc: this.loc(tok) };
  }

  // --------------------------------------------------------- f-strings

  private parseFString(): Expr {
    const tok = this.advance(); // FSTRING_START
    const parts: FStringPart[] = [];
    for (;;) {
      if (this.match(TokenType.FSTRING_MIDDLE)) {
        parts.push({ kind: 'text', value: this.previous.lexeme });
        continue;
      }
      if (this.check(TokenType.FSTRING_END)) {
        this.advance();
        break;
      }
      this.consume(TokenType.LBRACE, "'{' attendu dans la f-string");
      const expression = this.parseExpression();
      // Expression auto-documentee : `f"{x=}"` restitue `x=` puis la valeur.
      let debug: string | undefined;
      if (this.match(TokenType.FSTRING_DEBUG)) debug = this.previous.lexeme;
      let conversion: string | undefined;
      let spec: string | undefined;
      if (this.match(TokenType.FSTRING_CONVERSION)) conversion = this.previous.lexeme;
      if (this.match(TokenType.FSTRING_SPEC)) spec = this.previous.lexeme;
      this.consume(TokenType.RBRACE, "'}' attendu dans la f-string");
      parts.push({ kind: 'interpolation', expression, conversion, spec, debug });
    }
    return { kind: 'fstring', parts, loc: this.loc(tok) };
  }

  // ----------------------------------------------- parametres et annotations

  private parseParamList(terminator: TokenType = TokenType.RPAREN, allowAnnotations = true): Param[] {
    const params: Param[] = [];
    let keywordOnly = false;

    while (!this.check(terminator)) {
      if (this.match(TokenType.COMMA)) continue;

      if (this.match(TokenType.SLASH)) {
        params.push({ name: '', isPosOnlyMarker: true });
        continue;
      }
      if (this.match(TokenType.STAR_STAR)) {
        params.push({ ...this.parseNamedParam(allowAnnotations), isDoubleVarArg: true });
        keywordOnly = true;
        continue;
      }
      if (this.check(TokenType.STAR)) {
        this.advance(); // '*'
        if (this.check(TokenType.COMMA) || this.check(terminator)) {
          params.push({ name: '', isKeywordOnlyMarker: true });
          keywordOnly = true;
          continue;
        }
        params.push({ ...this.parseNamedParam(allowAnnotations), isVarArg: true });
        keywordOnly = true;
        continue;
      }

      const param = this.parseNamedParam(allowAnnotations);
      params.push(keywordOnly ? { ...param, isKeywordOnly: true } : param);
    }
    return params;
  }

  private parseNamedParam(allowAnnotations = true): Param {
    const nameTok = this.peek();
    const name =
      nameTok !== undefined && (nameTok.type === TokenType.NAME || nameTok.type === TokenType.SELF)
        ? this.advance().lexeme
        : this.error('nom de parametre attendu', nameTok);
    let annotation: string | undefined;
    // Un parametre de `lambda` ne peut pas etre annote : son `:` introduce le
    // corps de la fonction.
    if (allowAnnotations && this.match(TokenType.COLON)) annotation = this.parseTypeAnnotation();
    let defaultValue: Expr | undefined;
    if (this.match(TokenType.EQ)) defaultValue = this.parseExpression();
    return { name, default: defaultValue, annotation };
  }

  /**
   * Annotation de type, reconstruite comme texte.
   * Accepte `int`, `MyClass`, `list[int]`, `dict[str, int]`, `int | None`.
   */
  private parseTypeAnnotation(): string {
    let text = this.parseAnnotationAtom();
    for (;;) {
      if (this.match(TokenType.PIPE)) {
        text += ` | ${this.parseAnnotationAtom()}`;
        continue;
      }
      break;
    }
    return text;
  }

  private parseAnnotationAtom(): string {
    if (this.match(TokenType.NONE)) return 'None';
    if (this.match(TokenType.SELF)) return 'self';
    let text = this.consume(TokenType.NAME, 'type attendu').lexeme;
    while (this.match(TokenType.DOT)) {
      text += `.${this.consume(TokenType.NAME, 'nom de type attendu').lexeme}`;
    }
    while (this.check(TokenType.LBRACKET)) {
      this.advance();
      const parts: string[] = [];
      while (!this.check(TokenType.RBRACKET)) {
        if (parts.length > 0) {
          if (!this.match(TokenType.COMMA)) break;
        }
        if (this.check(TokenType.RBRACKET)) break;
        parts.push(this.parseAnnotationAtom());
      }
      this.consume(TokenType.RBRACKET, "']' attendu");
      text += `[${parts.join(', ')}]`;
    }
    return text;
  }

  // ------------------------------------------------------------- utilitaires

  /** Expression, ou tuple si des virgules sont presentes. */
  private parseExpressionListAsExpr(): Expr {
    const first = this.parseExpression();
    if (!this.check(TokenType.COMMA)) return first;
    const elements: Expr[] = [first];
    while (this.match(TokenType.COMMA)) {
      if (this.endOfStatement) break;
      elements.push(this.parseExpression());
    }
    return this.makeTuple(elements, false);
  }

  private makeTuple(elements: Expr[], parenthesized: boolean): Expr {
    return { kind: 'tuple', elements, parenthesized };
  }
}

/** Base numerique d'un litteral entier, d'apres son prefixe. */
function literalBase(lexeme: string): number {
  if (lexeme.startsWith('0x') || lexeme.startsWith('0X')) return 16;
  if (lexeme.startsWith('0b') || lexeme.startsWith('0B')) return 2;
  if (lexeme.startsWith('0o') || lexeme.startsWith('0O')) return 8;
  return 10;
}
