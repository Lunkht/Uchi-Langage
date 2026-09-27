/**
 * Lexer Uchi.
 *
 * Le lexer est maintenu comme une fonction pure `tokenize(source) -> Token[]`
 * afin d'etre facilement testable. Il gere :
 *  - l'indentation significative (NEWLINE / INDENT / DEDENT) ;
 *  - le jointure implicite de lignes a l'interieur de (), [] et {} ;
 *  - le jointure explicite par backslash ;
 *  - les chaines simples, brutes, multilignes et les f-strings (imbriquees).
 */

import { TokenType, KEYWORDS, token, type Token } from './tokens.ts';
import { UchiSyntaxError, type SourceFile } from '../errors.ts';

const TAB_WIDTH = 8;

const THREE_CHAR_OPERATORS: ReadonlyMap<string, TokenType> = new Map([
  ['//=', TokenType.SLASH_SLASH_EQ],
  ['**=', TokenType.STAR_STAR_EQ],
]);

const TWO_CHAR_OPERATORS: ReadonlyMap<string, TokenType> = new Map([
  ['==', TokenType.EQ_EQ],
  ['!=', TokenType.BANG_EQ],
  ['<=', TokenType.LT_EQ],
  ['>=', TokenType.GT_EQ],
  ['+=', TokenType.PLUS_EQ],
  ['-=', TokenType.MINUS_EQ],
  ['*=', TokenType.STAR_EQ],
  ['/=', TokenType.SLASH_EQ],
  ['%=', TokenType.PERCENT_EQ],
  ['@=', TokenType.AT_EQ],
  ['//', TokenType.SLASH_SLASH],
  ['**', TokenType.STAR_STAR],
  ['->', TokenType.ARROW],
  ['<<', TokenType.LT_LT],
  ['>>', TokenType.GT_GT],
  [':=', TokenType.COLON_EQ],
  ['@@', TokenType.ATAT],
]);

const SINGLE_CHAR_OPERATORS: ReadonlyMap<string, TokenType> = new Map([
  ['+', TokenType.PLUS],
  ['-', TokenType.MINUS],
  ['*', TokenType.STAR],
  ['/', TokenType.SLASH],
  ['%', TokenType.PERCENT],
  ['@', TokenType.AT],
  ['=', TokenType.EQ],
  ['<', TokenType.LT],
  ['>', TokenType.GT],
  ['(', TokenType.LPAREN],
  [')', TokenType.RPAREN],
  ['[', TokenType.LBRACKET],
  [']', TokenType.RBRACKET],
  ['{', TokenType.LBRACE],
  ['}', TokenType.RBRACE],
  [',', TokenType.COMMA],
  [':', TokenType.COLON],
  ['.', TokenType.DOT],
  [';', TokenType.SEMICOLON],
  ['!', TokenType.BANG],
  ['|', TokenType.PIPE],
  ['^', TokenType.CARET],
  ['&', TokenType.AMPERSAND],
  ['~', TokenType.TILDE],
]);

interface StringPrefix {
  isRaw: boolean;
  isFString: boolean;
  /** Distance entre le debut du lexeme et le guillemet ouvrant. */
  offset: number;
  /** Sequence de fermeture du guillemet. */
  closing: string;
}

interface FStringState {
  /** Sequence de fermeture : `"`, `'` ou `"""` etc. */
  closing: string;
  isRaw: boolean;
  /**
   * Profondeur d'accolades dans l'interpolation de *cette* f-string.
   * 0 = texte litteral, 1 = racine de `{...}`. Chaque f-string imbriquee
   * possede son propre compteur, ce qui rend l'imbrication correcte.
   */
  braceDepth: number;
  /**
   * Offset du premier caractere de l'expression courante, utilise par le
   * especificateur `=` pour retrouver le texte source (`f"{x = }"`).
   */
  exprStart: number;
}

export function tokenize(source: string, path = '<inconnu>'): Token[] {
  // Un eventuel BOM (fichier enregistre par un editeur Windows) est ignore.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return new Lexer(text, { path, text }).scan();
}

class Lexer {
  private readonly tokens: Token[] = [];
  /** Debuts de chaque ligne (index dans `text`), pour calculer line/colonne. */
  private readonly lineStarts: number[] = [0];
  private readonly indentStack: number[] = [0];
  private pos = 0;
  /** Profondeur de () [] {} : a 0 une nouvelle ligne est significative. */
  private bracketDepth = 0;
  /** Piles de f-strings ouvertes (une entree par f-string imbriquee). */
  private readonly fstrings: FStringState[] = [];

  private readonly text: string;
  private readonly file: SourceFile;

  constructor(text: string, file: SourceFile) {
    this.text = text;
    this.file = file;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') this.lineStarts.push(i + 1);
    }
  }

  scan(): Token[] {
    while (!this.atEnd()) this.scanToken();

    this.newline();
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.emit(TokenType.DEDENT, '', this.text.length);
    }
    this.emit(TokenType.EOF, '', this.text.length);
    return this.tokens;
  }

  // ------------------------------------------------------------------ helpers

  private atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  private peek(offset = 0): string {
    return this.text[this.pos + offset] ?? '';
  }

  private startsWith(prefix: string): boolean {
    return this.text.startsWith(prefix, this.pos);
  }

  private locationOf(index: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - this.lineStarts[lo] };
  }

  private emit(type: TokenType, lexeme: string, startIndex: number): void {
    const { line, column } = this.locationOf(startIndex);
    this.tokens.push(token(type, lexeme, line, column));
  }

  /** NEWLINE, en evitant les doublons (fin de fichier apres un saut de ligne). */
  private newline(startIndex = this.pos): void {
    const last = this.tokens[this.tokens.length - 1];
    if (last !== undefined && last.type !== TokenType.NEWLINE) {
      this.emit(TokenType.NEWLINE, '\n', startIndex);
    }
  }

  private error(message: string, index = this.pos): never {
    const { line, column } = this.locationOf(index);
    throw new UchiSyntaxError(message, { file: this.file, line, column });
  }

  // ---------------------------------------------------------- boucle principale

  private scanToken(): void {
    const start = this.pos;
    const c = this.peek();

    // -- Espaces, tabulations
    if (c === ' ' || c === '\t' || c === '\r') {
      this.pos++;
      return;
    }

    // -- Jointure explicite par backslash
    if (c === '\\' && (this.peek(1) === '\n' || (this.peek(1) === '\r' && this.peek(2) === '\n'))) {
      this.pos += this.peek(1) === '\r' ? 3 : 2;
      return;
    }

    // -- Fins de ligne
    if (c === '\n') {
      this.pos++;
      this.handleLineBreak(start);
      return;
    }

    // -- Commentaires
    if (c === '#') {
      while (!this.atEnd() && this.peek() !== '\n') this.pos++;
      return;
    }

    // -- Textes litteral d'une f-string (avec `{{` et `}}` echappes)
    if (this.scanningFStringText()) {
      this.scanFStringText();
      return;
    }

    // -- Chaines, y compris les prefixes `r` et `f`
    const prefix = this.matchStringPrefix();
    if (prefix !== null) {
      this.beginString(prefix, start);
      return;
    }

    // -- Nombres
    if (isDigit(c)) {
      this.scanNumber(start);
      return;
    }

    // -- Noms et mots-cles
    if (isIdentStart(c)) {
      this.scanName(start);
      return;
    }

    // -- Ponctuation speciale d'une interpolation de f-string
    if (this.fstrings.length > 0) {
      const state = this.fstrings[this.fstrings.length - 1];
      if (c === '{') {
        state.braceDepth++;
        this.emit(TokenType.LBRACE, c, start);
        this.pos++;
        return;
      }
      if (c === '}') {
        state.braceDepth--;
        this.emit(TokenType.RBRACE, c, start);
        this.pos++;
        return;
      }
      if (state.braceDepth === 1 && this.matchFStringDebug(state, start)) return;
      if (state.braceDepth === 1 && this.matchFStringSuffix(start)) return;
    }

    // -- Delimitateurs : on compte la profondeur pour suspendre les NEWLINE
    if (c === '(' || c === '[' || c === '{') {
      this.bracketDepth++;
    } else if (c === ')' || c === ']' || c === '}') {
      this.bracketDepth--;
      if (this.bracketDepth < 0) this.error(`'${c}' sans ouverture correspondante`, start);
    }

    this.scanOperator(start);
  }

  private scanningFStringText(): boolean {
    const state = this.fstrings[this.fstrings.length - 1];
    return state !== undefined && state.braceDepth === 0;
  }

  // -------------------------------------------------------------- indentation

  private handleLineBreak(newlineIndex: number): void {
    if (this.bracketDepth > 0) return; // ligne logique en cours
    this.newline(newlineIndex);
    this.handleIndentation();
  }

  /** Consomme lignes vides et commentaires, puis emet INDENT ou DEDENT*. */
  private handleIndentation(): void {
    for (;;) {
      let i = this.pos;
      let column = 0;
      while (i < this.text.length) {
        const ch = this.text[i];
        if (ch === ' ') column += 1;
        else if (ch === '\t') column += TAB_WIDTH - (column % TAB_WIDTH);
        else break;
        i++;
      }
      const ch = this.text[i];

      if (ch === undefined) return; // fin de fichier
      if (ch === '\n' || ch === '\r') {
        this.pos = i + 1;
        continue;
      }
      if (ch === '#') {
        while (i < this.text.length && this.text[i] !== '\n') i++;
        this.pos = i;
        continue;
      }

      this.pos = i;
      const top = this.indentStack[this.indentStack.length - 1];
      if (column > top) {
        this.indentStack.push(column);
        this.emit(TokenType.INDENT, ' '.repeat(column), i);
      } else if (column < top) {
        while (this.indentStack.length > 1 && this.indentStack[this.indentStack.length - 1] > column) {
          this.indentStack.pop();
          this.emit(TokenType.DEDENT, '', i);
        }
        if (this.indentStack[this.indentStack.length - 1] !== column) {
          this.error(`indentation incoherente : colonne ${column}`, i);
        }
      }
      return;
    }
  }

  // ------------------------------------------------------------------ chaines

  private matchStringPrefix(): StringPrefix | null {
    let isRaw = false;
    let isFString = false;
    let i = 0;

    const first = this.peek();
    if (first !== '"' && first !== "'") {
      if (!isIdentStart(first)) return null;
      while (i < 2 && isIdentStart(this.peek(i))) {
        const c = this.peek(i).toLowerCase();
        if (c === 'r') isRaw = true;
        else if (c === 'f') isFString = true;
        else return null;
        i++;
      }
    }

    const quote = this.peek(i);
    if (quote !== '"' && quote !== "'") return null;
    const triple = this.peek(i + 1) === quote && this.peek(i + 2) === quote;
    return { isRaw, isFString, offset: i, closing: triple ? quote.repeat(3) : quote };
  }

  private beginString(prefix: StringPrefix, start: number): void {
    const closing = prefix.closing;
    const quoteStart = start + prefix.offset;

    if (prefix.isFString) {
      this.pos = quoteStart + closing.length;
      this.emit(TokenType.FSTRING_START, closing, quoteStart);
      this.fstrings.push({ closing, isRaw: prefix.isRaw, braceDepth: 0, exprStart: this.pos });
      return;
    }

    if (closing.length === 3) {
      this.scanMultilineString(prefix.isRaw, start, quoteStart);
    } else {
      this.scanSingleLineString(prefix.isRaw, start, quoteStart);
    }
  }

  private scanSingleLineString(isRaw: boolean, start: number, quoteStart: number): void {
    const quote = this.text[quoteStart];
    this.pos = quoteStart + 1;
    let value = '';
    for (;;) {
      if (this.atEnd() || this.peek() === '\n') {
        this.error('chaine non terminee : guillemet fermant manquant', start);
      }
      const c = this.peek();
      if (c === quote) {
        this.pos++;
        break;
      }
      if (c === '\\') {
        this.pos++;
        value += isRaw ? this.readRawEscape(start) : this.readEscape(start);
        continue;
      }
      value += c;
      this.pos++;
    }
    this.emit(TokenType.STRING, value, start);
  }

  /**
   * Chaine brute : l'antislash est conserve tel quel, comme en Python. Seul
   * un antislash juste avant le guillemet fermant reste une erreur.
   */
  private readRawEscape(stringStart: number): string {
    const c = this.peek();
    if (c === '' || c === '\n') this.error('antislash en fin de chaine brute', stringStart);
    this.pos++;
    return `\\${c}`;
  }

  private scanMultilineString(isRaw: boolean, start: number, quoteStart: number): void {
    const closing = this.text.slice(quoteStart, quoteStart + 3);
    this.pos = quoteStart + 3;
    let value = '';
    for (;;) {
      if (this.atEnd()) this.error('chaine multiligne non terminee', start);
      if (this.startsWith(closing)) {
        this.pos += 3;
        break;
      }
      if (this.peek() === '\\') {
        this.pos++;
        value += isRaw ? this.readRawEscape(start) : this.readEscape(start);
        continue;
      }
      value += this.peek();
      this.pos++;
    }
    // Comme Python, un saut de ligne initial est ignore.
    if (!isRaw && value.startsWith('\n')) value = value.slice(1);
    this.emit(TokenType.STRING, value, start);
  }

  private readEscape(stringStart: number): string {
    const c = this.peek();
    this.pos++;
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      case 'a':
        return '\x07';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '\\':
        return '\\';
      case "'":
        return "'";
      case '"':
        return '"';
      case 'x': {
        const hex = this.text.slice(this.pos, this.pos + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.error("sequence d'echappement \\x invalide", stringStart);
        this.pos += 2;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      case 'u': {
        // `\u{...}` est une extension du langage ; Python attend `\uXXXX`.
        if (this.peek() === '{') {
          this.pos++;
          const end = this.text.indexOf('}', this.pos);
          if (end === -1) this.error("sequence d'echappement \\u non terminee", stringStart);
          const hex = this.text.slice(this.pos, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) this.error("sequence d'echappement \\u invalide", stringStart);
          this.pos = end + 1;
          return String.fromCodePoint(Number.parseInt(hex, 16));
        }
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.error("sequence d'echappement \\u attend 4 chiffres hexadecimaux", stringStart);
        this.pos += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      case 'U': {
        // `\UXXXXXXXX` : un point de code hors du plan de base est possible.
        const hex = this.text.slice(this.pos, this.pos + 8);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) this.error("sequence d'echappement \\U attend 8 chiffres hexadecimaux", stringStart);
        this.pos += 8;
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff) this.error("sequence d'echappement \\U hors du plan Unicode", stringStart);
        return String.fromCodePoint(code);
      }
      case 'N':
        // `\N{NOM}` necessiterait la table des noms Unicode : trop couteuse.
        this.error("sequence d'echappement \\u{NOM} non prise en charge", stringStart);
        break;
      default:
        this.error(`sequence d'echappement inconnue : '\\${c}'`, stringStart);
    }
  }

  // ------------------------------------------------------------------ f-strings

  private scanFStringText(): void {
    const state = this.fstrings[this.fstrings.length - 1];
    const start = this.pos;
    let text = '';
    for (;;) {
      if (this.atEnd()) this.error('f-string non terminee', start);
      const c = this.peek();

      if (this.startsWith(state.closing)) {
        this.pos += state.closing.length;
        if (text.length > 0) this.emit(TokenType.FSTRING_MIDDLE, text, start);
        this.emit(TokenType.FSTRING_END, state.closing, this.pos);
        this.fstrings.pop();
        return;
      }
      if (c === '{') {
        if (this.peek(1) === '{') {
          text += '{';
          this.pos += 2;
          continue;
        }
        this.pos++;
        if (text.length > 0) this.emit(TokenType.FSTRING_MIDDLE, text, start);
        this.emit(TokenType.LBRACE, '{', this.pos - 1);
        state.braceDepth = 1; // la suite est tokenisee comme une expression
        state.exprStart = this.pos;
        return;
      }
      if (c === '}' && this.peek(1) === '}') {
        text += '}';
        this.pos += 2;
        continue;
      }
      if (c === '\\' && !state.isRaw) {
        this.pos++;
        text += this.readEscape(start);
        continue;
      }
      text += c;
      this.pos++;
    }
  }

  /**
   * Expressions auto-documentees : `f"{x=}"`, `f"{x = }"`, `f"{x=:.2f}"`.
   *
   * Le token emitted contient le texte source de l'expression, le `=` et les
   * espaces qui suivent le `=`, exactement comme CPython les restitue.
   */
  private matchFStringDebug(state: FStringState, start: number): boolean {
    if (this.peek() !== '=') return false;
    // `==` appartient a l'expression ; le walrus `:=` est lu par scanOperator.
    if (this.peek(1) === '=') return false;
    // Le `=` doit introduire la fin du champ : `}`, `!conversion` ou `:spec`.
    let i = this.pos + 1;
    while (this.text[i] === ' ' || this.text[i] === '\t') i++;
    const after = this.text[i];
    if (after !== '}' && after !== '!' && after !== ':') return false;

    this.pos = i;
    // Les espaces Situes apres `{` ne font pas partie du texte restitue.
    let textStart = state.exprStart;
    while (this.text[textStart] === ' ' || this.text[textStart] === '\t') textStart++;
    this.emit(TokenType.FSTRING_DEBUG, this.text.slice(textStart, this.pos), start);
    return true;
  }

  /** Detecte la conversion `!r`/`!s`/`!a` et le gabarit `:>10.2f`. */
  private matchFStringSuffix(start: number): boolean {
    if (this.peek() === '!') {
      const conv = this.peek(1);
      const after = this.peek(2);
      if ((conv === 'r' || conv === 's' || conv === 'a') && (after === '}' || after === ':')) {
        this.pos += 2;
        this.emit(TokenType.FSTRING_CONVERSION, conv, start);
        return true;
      }
      return false;
    }
    if (this.peek() === ':') {
      let i = this.pos + 1;
      while (i < this.text.length && this.text[i] !== '}' && this.text[i] !== '\n') i++;
      if (this.text[i] !== '}') return false; // un `:` qui appartient a l'expression
      const spec = this.text.slice(this.pos + 1, i);
      const specStart = this.pos;
      this.pos = i;
      this.emit(TokenType.FSTRING_SPEC, spec, specStart);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- nombres

  private scanNumber(start: number): void {
    const base = this.peek(1).toLowerCase();
    if (this.peek() === '0' && (base === 'x' || base === 'b' || base === 'o')) {
      this.pos += 2;
      const digits = base === 'x' ? '0123456789abcdefABCDEF' : base === 'b' ? '01' : '01234567';
      this.readDigits(digits, `chiffre apres 0${base}`);
      this.emit(TokenType.INT, this.text.slice(start, this.pos), start);
      return;
    }

    let isFloat = false;
    this.readDigits('0123456789', 'chiffre');
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      isFloat = true;
      this.pos++;
      this.readDigits('0123456789', 'chiffre');
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      const save = this.pos;
      this.pos++;
      if (this.peek() === '+' || this.peek() === '-') this.pos++;
      if (isDigit(this.peek())) {
        isFloat = true;
        this.readDigits('0123456789', 'chiffre');
      } else {
        this.pos = save;
      }
    }
    this.emit(isFloat ? TokenType.FLOAT : TokenType.INT, this.text.slice(start, this.pos), start);
  }

  private readDigits(valid: string, what: string): void {
    let count = 0;
    for (;;) {
      const c = this.peek();
      if (c !== '' && valid.includes(c)) {
        this.pos++;
        count++;
      } else if (c === '_') {
        this.pos++;
      } else {
        break;
      }
    }
    if (count === 0) this.error(`${what} attendu`);
  }

  // --------------------------------------------------------------------- noms

  private scanName(start: number): void {
    while (!this.atEnd() && isIdentPart(this.peek())) this.pos++;
    const lexeme = this.text.slice(start, this.pos);
    const keyword = KEYWORDS.get(lexeme);
    if (keyword !== undefined) {
      this.emit(keyword, lexeme, start);
      return;
    }
    this.emit(TokenType.NAME, lexeme, start);
  }

  // ---------------------------------------------------------------- operateurs

  private scanOperator(start: number): void {
    const three = this.text.slice(this.pos, this.pos + 3);
    const threeOp = THREE_CHAR_OPERATORS.get(three);
    if (threeOp !== undefined) {
      this.pos += 3;
      this.emit(threeOp, three, start);
      return;
    }
    const two = this.text.slice(this.pos, this.pos + 2);
    const twoOp = TWO_CHAR_OPERATORS.get(two);
    if (twoOp !== undefined) {
      this.pos += 2;
      this.emit(twoOp, two, start);
      return;
    }
    const oneOp = SINGLE_CHAR_OPERATORS.get(this.peek());
    if (oneOp !== undefined) {
      const lexeme = this.peek();
      this.pos++;
      this.emit(oneOp, lexeme, start);
      return;
    }
    const bad = this.peek();
    this.error(`caractere inattendu '${bad}' (code ${bad.charCodeAt(0)})`);
  }
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) > 127;
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
