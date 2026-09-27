/**
 * Interface en ligne de commande Uchi.
 *
 *   uchi run <fichier.uchi> [args...]   execute un script
 *   uchi repl                            ouvre l'interpreteur interactif
 *   uchi check <fichier.uchi>            analyse sans executer
 *   uchi gui [dossier]                   ouvre l'editeur web
 *   uchi version                         affiche la version
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { UchiThrow, UchiSyntaxError } from './errors.ts';
import { defaultRoot, openBrowser, openEditor } from './gui/index.ts';
import { Interpreter } from './interpreter/interpreter.ts';
import { toRepr, toStr } from './interpreter/operations.ts';
import { UchiError, UchiInstance, type UchiValue } from './interpreter/values.ts';
import { parse } from './parser/parser.ts';
import { UCHI_VERSION } from './stdlib/version.ts';

const USAGE = `Uchi ${UCHI_VERSION}

Utilisation :
  uchi run <fichier.uchi> [arguments...]   execute un script
  uchi repl                                ouvre l'interpreteur interactif
  uchi check <fichier.uchi>                analyse le fichier sans l'executer
  uchi gui [dossier] [--port N] [--no-open] ouvre l'editeur web
  uchi -e "<code>"                         execute un fragment de code
  uchi version                             affiche la version
  uchi help                                affiche cette aide
`;

export function main(argv: string[]): number {
  const [command = 'help', ...rest] = argv;

  switch (command) {
    case 'run':
      return runCommand(rest);
    case 'repl':
      return replCommand(rest);
    case 'check':
      return checkCommand(rest);
    case 'gui':
      // Le demarrage du serveur est asynchrone : le code de sortie est fourni
      // plus tard, quand l'editeur s'arrete.
      void guiCommand(rest).then((code) => {
        process.exitCode = code;
      });
      return 0;    case '-e':
      return evalCommand(rest);
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`Uchi ${UCHI_VERSION}\n`);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      // `uchi fichier.uchi` equivaut a `uchi run fichier.uchi`.
      if (command.endsWith('.uchi')) return runCommand(argv);
      process.stderr.write(`Commande inconnue : '${command}'\n\n${USAGE}`);
      return 2;
  }
}

/** Execute un script. Les arguments du script sont exposes par `sys.argv`. */
function runCommand(args: string[]): number {
  const [file, ...scriptArgs] = args;
  if (file === undefined) {
    process.stderr.write("Erreur : aucun fichier indique.\n\n" + USAGE);
    return 2;
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    process.stderr.write(`Erreur : fichier introuvable : '${file}'\n`);
    return 2;
  }

  const interpreter = new Interpreter({
    argv: [path, ...scriptArgs],
    baseDirectory: dirname(path),
  });

  try {
    const program = parse(readFileSync(path, 'utf8'), path);
    interpreter.run(program);
    return 0;
  } catch (thrown) {
    return reportError(interpreter, thrown, path);
  }
}

/** Analyse sans executer : utile en integration continue. */
function checkCommand(args: string[]): number {
  const file = args[0];
  if (file === undefined) {
    process.stderr.write('Erreur : aucun fichier indique.\n');
    return 2;
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    process.stderr.write(`Erreur : fichier introuvable : '${file}'\n`);
    return 2;
  }
  try {
    const program = parse(readFileSync(path, 'utf8'), path);
    const functions = program.body.filter((statement) => statement.kind === 'function').length;
    const classes = program.body.filter((statement) => statement.kind === 'class').length;
    process.stdout.write(
      `OK : ${path} (${program.body.length} instruction(s), ${functions} fonction(s), ${classes} classe(s))\n`,
    );
    return 0;
  } catch (thrown) {
    return reportError(null, thrown, path);
  }
}

/**
 * Editeur web : un serveur local sans dependance, ouvert dans le navigateur.
 * Le processus reste vivant jusqu'a l'arret du serveur par Ctrl+C.
 */
async function guiCommand(args: string[]): Promise<number> {
  const options = { root: defaultRoot(), port: 0, open: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--port') {
      const port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write('Erreur : --port attend un numero de port valide.\n');
        return 2;
      }
      options.port = port;
    } else if (arg === '--no-open') {
      options.open = false;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`Option inconnue : '${arg}'\n`);
      return 2;
    } else {
      options.root = resolve(arg);
    }
  }
  if (!existsSync(options.root)) {
    process.stderr.write(`Erreur : dossier introuvable : '${options.root}'\n`);
    return 2;
  }

  try {
    const server = await openEditor({ root: options.root, port: options.port });
    process.stdout.write(`Uchi ${UCHI_VERSION} — editeur\n`);
    process.stdout.write(`  dossier : ${server.root}\n`);
    process.stdout.write(`  adresse : ${server.url}\n`);
    process.stdout.write('Ctrl+C pour arreter.\n');
    if (options.open) openBrowser(server.url);
    // Le serveur ecoute indefiniment : c'est la boucle d'evenements qui tient.
    await new Promise<void>(() => {});
    return 0;
  } catch (error) {
    process.stderr.write(`Erreur : ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function evalCommand(args: string[]): number {
  const [code, ...scriptArgs] = args;
  if (code === undefined) {
    process.stderr.write("Erreur : aucun code a executer.\n");
    return 2;
  }
  const interpreter = new Interpreter({ argv: ['-e', ...scriptArgs] });
  try {
    const value = interpreter.runSource(code, '<-e>');
    if (value !== null) process.stdout.write(`${interpreter.toInspectString(value)}\n`);
    return 0;
  } catch (thrown) {
    return reportError(interpreter, thrown, '<-e>');
  }
}

/**
 * Interpreteur interactif. Les instructions incompletes (`def`, `if`, ...)
 * attendent la ligne suivante ; une ligne vide ou `:` clot le bloc.
 */
function replCommand(args: string[]): number {
  const interpreter = new Interpreter({ argv: ['repl', ...args] });
  let pending = '';
  let depth = 0;

  process.stdout.write(`Uchi ${UCHI_VERSION} — tapez 'exit()' pour quitter.\n`);

  for (;;) {
    process.stdout.write(depth > 0 ? '... ' : '>>> ');
    const line = interpreter.readLine();
    if (line === null) break;

    const trimmed = line.trim();
    if (depth === 0 && (trimmed === 'exit()' || trimmed === 'quit()')) break;
    if (trimmed === '') {
      pending = '';
      depth = 0;
      continue;
    }

    const source = pending === '' ? line : `${pending}\n${line}`;
    pending = source;
    depth = measureDepth(source);
    if (depth > 0) continue;

    try {
      const value = interpreter.runSource(source, '<repl>');
      if (value !== null) process.stdout.write(`${interpreter.toInspectString(value)}\n`);
    } catch (thrown) {
      reportReplError(interpreter, thrown);
    }
    pending = '';
  }
  process.stdout.write('A bientot.\n');
  return 0;
}

/** Profondeur d'indentation approximative, suffisante pour la saisie en direct. */
function measureDepth(source: string): number {
  const lines = source.split('\n');
  let depth = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const isLast = index === lines.length - 1;
    const opensBlock = /:\s*(#.*)?$/.test(line);
    const closesBlock = /^\s*(else|elif|except|finally|except\s)/.test(line);
    const lowers = /^\s*(return|pass|break|continue)\b/.test(line);
    if (lowers || (closesBlock && depth > 0)) {
      depth = Math.max(0, depth - 1);
    }
    if (opensBlock && !closesBlock && !lowers) depth++;
  }
  return depth;
}

function reportReplError(interpreter: Interpreter, thrown: unknown): void {
  if (thrown instanceof UchiSyntaxError) {
    process.stderr.write(`SyntaxError : ${thrown.message}\n`);
    return;
  }
  process.stderr.write(`${describeError(interpreter, thrown)}\n`);
}

/** Affiche une erreur et renvoie le code de sortie correspondant. */
function reportError(interpreter: Interpreter | null, thrown: unknown, path: string): number {
  if (thrown instanceof UchiSyntaxError) {
    process.stderr.write(`SyntaxError : ${thrown.message}\n  fichier : ${path}\n`);
    return 1;
  }
  if (thrown instanceof UchiThrow) {
    const error = thrown.value instanceof UchiError ? thrown.value : null;
    // `sys.exit()` remonte une exception SystemExit : elle n'est pas une erreur.
    if (error !== null && error.name === 'SystemExit') {
      const code = error.args[0];
      return typeof code === 'number' ? code : 0;
    }
  }
  process.stderr.write(`${describeError(interpreter, thrown)}\n`);
  return 1;
}

function describeError(interpreter: Interpreter | null, thrown: unknown): string {
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
