/*
 * Colorateur Uchi pour l'editeur web.
 *
 * Le texte est transforme en HTML balise par jeton. Ce n'est pas un analyseur
 * complet : la coloration est un confort de lecture, l'analyse reelle du
 * fichier est faite par le serveur (`/api/check`).
 *
 * Convention : chaque balayage renvoie `{html, index}` et peut mettre a jour
 * l'etat `state`, ce qui permet de poursuivre une chaine triple ouverte a la
 * ligne precedente, comme le fait le lexer.
 */
(function (global) {
  'use strict';

  /** Groupes de noms, alimentes par `/api/grammar`. */
  var tables = {
    keywords: new Set(),
    literals: new Set(),
    types: new Set(),
    functions: new Set(),
    modules: new Set(),
    exceptions: new Set(),
    dunders: new Set(),
  };

  /** Prefixes de chaine valides, comme en Python. */
  var PREFIXES = new Set(['r', 'u', 'b', 'f', 'rb', 'br', 'rf', 'fr']);

  var OPERATORS = [
    '**=', '//=', '>>=', '<<=', '...',
    '**', '//', '==', '!=', '<=', '>=', '->', ':=', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '@=',
    '+', '-', '*', '/', '%', '=', '<', '>', '(', ')', '[', ']', '{', '}', ',',
    ':', '.', ';', '@', '&', '|', '^', '~',
  ];

  var IDENT = /^[A-Za-z_À-ÖØ-öø-ÿ][A-Za-z0-9_À-ÖØ-öø-ÿ]*/;
  var NUMBER = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]*)?([eE][-+]?[0-9]+)?j?)/;

  /** Installe les tables fournies par le serveur. */
  function configure(grammar) {
    Object.keys(tables).forEach(function (group) {
      tables[group] = new Set(grammar[group] || []);
    });
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function span(className, text) {
    return text === '' ? '' : '<span class="' + className + '">' + escapeHtml(text) + '</span>';
  }

  function nameClass(name, afterImport) {
    if (tables.literals.has(name)) return 't-litteral';
    if (tables.keywords.has(name)) return 't-mot';
    if (tables.dunders.has(name)) return 't-dunder';
    if (tables.types.has(name)) return 't-type';
    if (tables.exceptions.has(name)) return 't-exception';
    if (afterImport) return 't-module';
    if (tables.functions.has(name)) return 't-fonction';
    return null;
  }

  /** Colore un texte entier et renvoie le HTML de la surcouche. */
  function highlight(text) {
    var lines = text.split('\n');
    var out = [];
    var state = { mode: 'code' };
    for (var i = 0; i < lines.length; i++) {
      var result = state.mode === 'string'
        ? readTriple(lines[i], 0, state, state)
        : readCode(lines[i], 0, state);
      // Une ligne sans jeton garde une espace, pour que la hauteur de la
      // surcouche suive exactement celle de la saisie.
      out.push(result.html === '' ? ' ' : result.html);
      state = result.state;
    }
    return out.join('\n');
  }

  /** Balaye une ligne de code ordinaire. */
  function readCode(line, from, state) {
    var out = '';
    var index = from;
    var length = line.length;
    var inImport = false;
    var expectDefinition = false;

    while (index < length) {
      var char = line[index];

      if (char === '#') {
        out += span('t-commentaire', line.slice(index));
        index = length;
        break;
      }

      // Une chaine est reconnue avant un identifiant : `f"x"` ne doit pas etre
      // lu comme le nom `f` suivi d'une chaine.
      if (isStringStart(line, index)) {
        var opened = openString(line, index);
        var result = readString(line, index, opened, state);
        out += result.html;
        index = result.index;
        state = result.state;
        continue;
      }

      if (NUMBER.test(line.slice(index)) || (char === '.' && /[0-9]/.test(line[index + 1] || ''))) {
        var number = NUMBER.exec(line.slice(index));
        if (number !== null) {
          out += span('t-nombre', number[0]);
          index += number[0].length;
          continue;
        }
      }

      if (char === '@' && IDENT.test(line.slice(index + 1))) {
        var decorator = '@' + IDENT.exec(line.slice(index + 1))[0];
        out += span('t-definition', decorator);
        index += decorator.length;
        continue;
      }

      if (IDENT.test(line.slice(index))) {
        var name = IDENT.exec(line.slice(index))[0];
        index += name.length;
        if (expectDefinition) {
          out += span('t-definition', name);
          expectDefinition = false;
        } else {
          var klass = nameClass(name, inImport);
          out += klass === null ? escapeHtml(name) : span(klass, name);
        }
        if (name === 'import' || name === 'from') inImport = true;
        else if (name === 'def' || name === 'class') expectDefinition = true;
        else if (name !== 'as' && !/^\s*[.,([{]/.test(line.slice(index))) inImport = false;
        continue;
      }

      var operator = OPERATORS.find(function (candidate) {
        return line.startsWith(candidate, index);
      });
      if (operator !== undefined) {
        out += span('t-operateur', operator);
        index += operator.length;
        continue;
      }

      out += escapeHtml(char);
      index++;
    }
    return { html: out, index: index, state: state };
  }

  /**
   * Chaine simple ou triple, brute ou formatée.
   *
   * `start` designe le debut du prefixe eventuel (`r`, `f`, `rb`) : le prefixe
   * est emis tel quel, le reste est colore comme une chaine.
   */
  function readString(line, start, opened, state) {
    var from = start + opened.prefix.length;
    var head = escapeHtml(opened.prefix);
    if (opened.triple) {
      var triple = readTriple(line, from, opened, state);
      return { html: head + triple.html, index: triple.index, state: triple.state };
    }
    if (opened.fstring) {
      var formatted = readFString(line, from, opened.quote);
      return { html: head + formatted.html, index: formatted.index, state: state };
    }
    var simple = readSimple(line, from, opened.quote);
    return { html: head + span('t-chaine', line.slice(from, simple.index)), index: simple.index, state: state };
  }

  /** Chaine simple : elle ne peut pas changer de ligne. */
  function readSimple(line, from, quote) {
    var index = from + 1;
    while (index < line.length) {
      if (line[index] === '\\') { index += 2; continue; }
      if (line[index] === quote) return { index: index + 1 };
      index++;
    }
    return { index: line.length };
  }

  /** Chaine triple : ouverte, elle se poursuit sur les lignes suivantes. */
  function readTriple(line, from, opened, state) {
    var delimiter = opened.quote + opened.quote + opened.quote;
    var end = line.indexOf(delimiter, opened.resuming ? from : from + 3);
    var className = opened.fstring ? 't-fchaine' : 't-chaine';
    if (end === -1) {
      return {
        html: span(className, line.slice(from)),
        index: line.length,
        state: { mode: 'string', quote: opened.quote, fstring: opened.fstring, resuming: true },
      };
    }
    // La chaine est fermee : la suite de la ligne redevient du code.
    return {
      html: span(className, line.slice(from, end + 3)),
      index: end + 3,
      state: { mode: 'code' },
    };
  }

  /**
   * f-chaine : les morceaux litteraux sont colores comme une chaine et les
   * expressions `{...}` comme du code.
   */
  function readFString(line, from, quote) {
    var out = '';
    var index = from + 1;
    var literalStart = from;
    while (index < line.length) {
      var char = line[index];
      if (char === '\\') { index += 2; continue; }
      if (char === quote) {
        out += span('t-fchaine', line.slice(literalStart, index + 1));
        return { html: out, index: index + 1 };
      }
      if (char === '{' && line[index + 1] === '{') {
        out += span('t-fchaine', line.slice(literalStart, index + 2));
        index += 2;
        literalStart = index;
        continue;
      }
      if (char === '{') {
        out += span('t-fchaine', line.slice(literalStart, index));
        var end = matchBrace(line, index);
        out += fstringExpression(line.slice(index, end));
        index = end;
        literalStart = index;
        continue;
      }
      index++;
    }
    out += span('t-fchaine', line.slice(literalStart));
    return { html: out, index: line.length };
  }

  /** Position juste apres le `}` qui referme l'expression ouverte a `from`. */
  function matchBrace(line, from) {
    var depth = 0;
    var index = from;
    while (index < line.length) {
      var char = line[index];
      if (char === '"' || char === "'") {
        var opened = openString(line, index);
        var start = index + opened.prefix.length;
        index = opened.triple
          ? indexOfTriple(line, start, opened.quote)
          : readSimple(line, start, opened.quote).index;
        continue;
      }
      if (char === '{' || char === '[' || char === '(') depth++;
      else if (char === '}' || char === ']' || char === ')') {
        depth--;
        if (depth === 0) return index + 1;
      }
      index++;
    }
    return line.length;
  }

  function indexOfTriple(line, from, quote) {
    var delimiter = quote + quote + quote;
    var end = line.indexOf(delimiter, from);
    return end === -1 ? line.length : end + 3;
  }

  /** Colore `{expr}`, `{expr!r:>10}` et `{expr=}` comme du code. */
  function fstringExpression(slice) {
    var inner = slice.slice(1);
    if (inner.endsWith('}')) inner = inner.slice(0, -1);
    // `{expr=}` : le `=` final met en valeur l'expression auto-documentee.
    var debug = /(^|[^=!<>])=$/.test(inner);
    if (debug) inner = inner.replace(/=$/, '');
    var html = span('t-fchaine', '{') + readCode(inner, 0, { mode: 'code' }).html;
    if (debug) html += span('t-operateur', '=');
    return html + span('t-fchaine', '}');
  }

  /** Vrai si une chaine commence ici, prefixe eventuel compris. */
  function isStringStart(line, at) {
    var rest = line.slice(at);
    var match = /^([A-Za-z]{0,2})("|')/.exec(rest);
    if (match === null) return false;
    return match[1] === '' || PREFIXES.has(match[1].toLowerCase());
  }

  /** Analyse le debut d'une chaine : prefixe, guillemets, chaine formatée. */
  function openString(line, at) {
    var match = /^([A-Za-z]{0,2})("|')/.exec(line.slice(at));
    var prefix = match === null ? '' : match[1].toLowerCase();
    var quote = match === null ? '"' : match[2];
    return {
      prefix: prefix,
      quote: quote,
      triple: line.substr(at + prefix.length, 3) === quote + quote + quote,
      fstring: prefix.indexOf('f') >= 0,
      resuming: false,
    };
  }

  global.UchiHighlight = {
    configure: configure,
    highlight: highlight,
    escapeHtml: escapeHtml,
  };
})(window);
