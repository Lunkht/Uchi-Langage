/**
 * Interface en ligne de commande Uchi.
 *
 *   uchi run <fichier.uchi> [args...]   execute un script
 *   uchi repl                            ouvre l'interpreteur interactif
 *   uchi check <fichier.uchi>            analyse sans executer
 *   uchi gui [dossier] [options]         ouvre l'editeur web
 *   uchi version                         affiche la version
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runIsolated } from './execution/isolated.ts';
import { UchiThrow, UchiSyntaxError } from './errors.ts';
import { defaultRoot, openBrowser, openEditor } from './gui/index.ts';
import { Interpreter } from './interpreter/interpreter.ts';
import { describeError } from './interpreter/report.ts';
import { EXTENSION } from './language.ts';
import { UchiError } from './interpreter/values.ts';
import { parse } from './parser/parser.ts';
import { UCHI_VERSION } from './stdlib/version.ts';

/** Duree max d'une execution, en secondes, si `--timeout` n'est pas precise. */
const DEFAULT_TIMEOUT = 10;

/**
 * Options qui appartiennent a l'editeur, avec le nombre de valeurs qu'elles
 * consomment.
 *
 * `run` et `repl` les recoivent sans les connaitre : elles sont transmises a
 * l'appelant, qui les interprete ou les refuse.
 */
const DELEGATED_OPTIONS: Readonly<Record<string, number>> = {
  '--port': 1,
  '--no-open': 0,
};

const USAGE = `Uchi ${UCHI_VERSION}

Utilisation :
  uchi run <fichier${EXTENSION}> [arguments...]   execute un script
                                       --timeout S   duree max d'une execution (${DEFAULT_TIMEOUT} s)
                                       --no-timeout  execute sans limite de temps ni fil dedie
  uchi repl                            ouvre l'interpreteur interactif
                                       --timeout S   duree max d'une instruction saisie (${DEFAULT_TIMEOUT} s)
  uchi check <fichier${EXTENSION}>                analyse le fichier sans l'executer
  uchi gui [dossier] [options]        ouvre l'editeur web
                                       --port N      port d'ecoute
                                       --timeout S   duree max d'une execution (${DEFAULT_TIMEOUT} s)
                                       --no-open     n'ouvre pas le navigateur
  uchi -e "<code>"                         execute un fragment de code
  uchi version                             affiche la version
  uchi help                                affiche cette aide

'run' execute le script dans un fil dedie : --timeout peut donc etre place
avant ou apres le fichier. Ce qui suit le fichier apartient au script, sauf si
un '--' le separe des options d'Uchi :

  uchi run jeu${EXTENSION} --timeout 5     limite l'execution a 5 s
  uchi run jeu${EXTENSION} -- --timeout    le script recoit '--timeout'

Le delai du repl s'applique aux boucles du langage : il interrompt un 'while'
ou un 'for', pas une operation native comme une expression reguliere
catastrophique. Contre celle-ci, seul Ctrl+C arrete le programme : le delai
n'est pose que dans 'run', qui s'execute dans un fil interruptible.
`;

/** Options communes a `run` et `repl`. */
interface ExecutionOptions {
  /** Delai maximal, en millisecondes ; `0` signifie aucune limite. */
  timeoutMs: number;
  /** `true` pour `--no-timeout` : execution dans le fil appelant. */
  withoutTimeout: boolean;
}

function defaultExecutionOptions(): ExecutionOptions {
  return { timeoutMs: DEFAULT_TIMEOUT * 1000, withoutTimeout: false };
}

/**
 * Lit les options d'execution communes a `run`, `repl` et `gui`.
 *
 * `--timeout` et `--no-timeout` sont consommees ici ; les options de l'editeur
 * sont transmises telles quelles a l'appelant, qui les interprete ou les
 * refuse. Toute autre option inconnue est signalee.
 *
 * @param scriptEnd `true` pour `run` : le fichier du script arrete la lecture
 *   des options dites du script, car tout ce qui suit lui appartient, y compris
 *   des arguments comme `-v` qu'Uchi ne connait pas. `--timeout` et
 *   `--no-timeout` font exception : ce sont des regles d'execution, pas des
 *   arguments du script.
 *
 * Un `--` isole les arguments du script : apres lui, plus rien n'est lu comme
 * une option, ce qui permet de transmettre `--timeout` a un script.
 */
function readExecutionOptions(
  args: string[],
  scriptEnd = false,
): { options: ExecutionOptions; rest: string[] } | { error: string } {
  const options = defaultExecutionOptions();
  const rest: string[] = [];
  const separator = args.indexOf('--');
  const head = separator === -1 ? args : args.slice(0, separator);
  const tail = separator === -1 ? [] : args.slice(separator + 1);
  // Passe a vrai des que le fichier du script a ete lu.
  let scriptArgs = false;

  for (let i = 0; i < head.length; i++) {
    const arg = head[i] as string;
    // `--timeout` et `--no-timeout` restent des options d'Uchi meme apres le
    // nom du fichier : c'est la forme naturelle, `run jeu.uchi --timeout 5`.
    if (arg === '--timeout') {
      const secondes = Number(head[++i]);
      if (!Number.isFinite(secondes) || secondes <= 0) {
        return { error: 'Erreur : --timeout attend un nombre de secondes positif.\n' };
      }
      options.timeoutMs = secondes * 1000;
    } else if (arg === '--no-timeout') {
      options.withoutTimeout = true;
    } else if (scriptArgs) {
      // Le fichier du script est lu : tout le reste lui appartient.
      rest.push(arg);
    } else if (arg.startsWith('-') && arg !== '-') {
      const values = DELEGATED_OPTIONS[arg];
      if (values === undefined) return { error: `Option inconnue : '${arg}'\n` };
      rest.push(arg, ...head.slice(i + 1, i + 1 + values));
      i += values;
    } else {
      rest.push(arg);
      scriptArgs = scriptEnd;
    }
  }
  rest.push(...tail);
  return { options, rest };
}

export function main(argv: string[]): number {
  const [command = 'help', ...rest] = argv;

  switch (command) {
    case 'run':
      return launch(runCommand(rest));
    case 'repl':
      return launch(replCommand(rest));
    case 'check':
      return checkCommand(rest);
    case 'gui':
      return launch(guiCommand(rest));
    case '-e':
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
      if (command.endsWith(EXTENSION)) return launch(runCommand(argv));
      process.stderr.write(`Commande inconnue : '${command}'\n\n${USAGE}`);
      return 2;
  }
}

/**
 * Lance une commande asynchrone et rend la main.
 *
 * Le code de sortie est fourni plus tard, quand la commande se termine ; tant
 * qu'elle tourne, c'est la boucle d'evenements qui tient le processus.
 */
function launch(action: Promise<number>): number {
  void action.then(
    (code) => {
      process.exitCode = code;
    },
    // Une commande qui echoue ne doit pas se perdre en rejet sans trace.
    (erreur: unknown) => {
      const message = erreur instanceof Error ? erreur.message : String(erreur);
      process.stderr.write(`Erreur interne : ${message}\n`);
      process.exitCode = 70;
    },
  );
  return 0;
}

/**
 * Execute un script.
 *
 * Par defaut le programme tourne dans un fil dedie : un delai atteint, ou un
 * programme qui plante l'hote, n'interrompt que lui. `sys.argv` est transmis au
 * fil, qui n'a pas le terminal : `input()` atteint donc la fin du flux.
 * `--no-timeout` rend la main au programme pour un script qui a besoin de lire
 * l'entree standard, au prix de toute protection.
 */
async function runCommand(args: string[]): Promise<number> {
  const parsed = readExecutionOptions(args, true);
  if ('error' in parsed) {
    process.stderr.write(parsed.error);
    return 2;
  }
  const { options, rest } = parsed;
  const [file, ...scriptArgs] = rest;
  if (file === undefined) {
    process.stderr.write("Erreur : aucun fichier indique.\n\n" + USAGE);
    return 2;
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    process.stderr.write(`Erreur : fichier introuvable : '${file}'\n`);
    return 2;
  }

  if (options.withoutTimeout) return runInProcess(path, scriptArgs);

  const result = await runIsolated({ path, argv: [path, ...scriptArgs], stream: true }, options.timeoutMs, (chunk) => {
    process.stdout.write(chunk);
  });
  if (result.error !== null) {
    // `sys.exit(n)` se presente comme une exception, mais ce n'en est pas une :
    // le code demande fait foi et rien ne doit etre signale a l'utilisateur.
    if (result.exitCode !== undefined) return result.exitCode;
    process.stderr.write(`${result.error.name} : ${result.error.message}\n`);
    for (const frame of result.trace) process.stderr.write(`${frame}\n`);
    return 1;
  }
  return result.exitCode ?? 0;
}

/** Execute le script dans le fil appelant, sans limite de temps. */
function runInProcess(path: string, scriptArgs: string[]): number {
  const interpreter = new Interpreter({ argv: [path, ...scriptArgs], baseDirectory: dirname(path) });
  try {
    interpreter.run(parse(readFileSync(path, 'utf8'), path));
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
  const parsed = readExecutionOptions(args);
  if ('error' in parsed) {
    process.stderr.write(parsed.error);
    return 2;
  }
  const options = { root: defaultRoot(), port: 0, open: true, runTimeout: parsed.options.timeoutMs / 1000 };
  for (let i = 0; i < parsed.rest.length; i++) {
    const arg = parsed.rest[i] as string;
    if (arg === '--port') {
      const port = Number(parsed.rest[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write('Erreur : --port attend un numero de port valide.\n');
        return 2;
      }
      options.port = port;
    } else if (arg === '--no-open') {
      options.open = false;
    } else {
      options.root = resolve(arg);
    }
  }
  if (parsed.options.withoutTimeout) {
    process.stderr.write('Erreur : --no-timeout n\'a pas de sens pour un editeur.\n');
    return 2;
  }
  if (!existsSync(options.root)) {
    process.stderr.write(`Erreur : dossier introuvable : '${options.root}'\n`);
    return 2;
  }

  try {
    const server = await openEditor({
      root: options.root,
      port: options.port,
      runTimeout: options.runTimeout * 1000,
    });
    process.stdout.write(`Uchi ${UCHI_VERSION} — editeur\n`);
    process.stdout.write(`  dossier : ${server.root}\n`);
    process.stdout.write(`  adresse : ${server.url}\n`);
    process.stdout.write(`  execution : ${options.runTimeout} s maximum\n`);
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
 * Interpreteur interactif.
 *
 * Une instruction qui ouvre un bloc (`def`, `if`, ...) attend la ligne suivante ;
 * la ligne vide clot la saisie et declenche l'execution. L'etat de la session
 * est conserve d'une ligne a l'autre, ce qui exclut un fil dedie : c'est
 * pourquoi chaque instruction est bornee par `deadlineMs` plutot que par une
 * coupure du fil, qui interromprait la session.
 */
function replCommand(args: string[]): Promise<number> {
  const parsed = readExecutionOptions(args);
  if ('error' in parsed) {
    process.stderr.write(parsed.error);
    return Promise.resolve(2);
  }
  const interpreter = new Interpreter({ argv: ['repl', ...parsed.rest], deadlineMs: parsed.options.timeoutMs });
  let pending = '';
  let depth = 0;

  /** Execute la saisie en cours et rend la main a l'invite. */
  function executer(source: string): void {
    pending = '';
    depth = 0;
    try {
      const value = interpreter.runSource(source, '<repl>');
      if (value !== null) process.stdout.write(`${interpreter.toInspectString(value)}\n`);
    } catch (thrown) {
      reportReplError(interpreter, thrown);
    }
  }

  process.stdout.write(`Uchi ${UCHI_VERSION} — tapez 'exit()' pour quitter.\n`);
  if (parsed.options.timeoutMs > 0) {
    // La limite est annoncee avec sa portee : un delai qui laisse passer une
    // expression reguliere catastrophique ferait croire a une garantie.
    process.stdout.write(
      `Delai de ${parsed.options.timeoutMs / 1000} s par instruction (boucles Uchi ; Ctrl+C reste necessaire contre une operation native). Ctrl+C pour interrompre.\n`,
    );
  }

  for (;;) {
    process.stdout.write(depth > 0 ? '... ' : '>>> ');
    const line = interpreter.readLine();
    if (line === null) break;

    const trimmed = line.trim();
    if (depth === 0 && (trimmed === 'exit()' || trimmed === 'quit()')) break;
    // La ligne vide clot une saisie en cours ; au repos, elle est ignoree.
    if (trimmed === '') {
      if (depth > 0) executer(pending);
      continue;
    }

    pending = pending === '' ? line : `${pending}\n${line}`;
    depth = measureDepth(pending);
    if (depth > 0) continue;
    executer(pending);
  }
  process.stdout.write('A bientot.\n');
  return Promise.resolve(0);
}

/**
 * Nombre de blocs encore ouverts dans une saisie en cours.
 *
 * Le compte ne sert qu'a savoir si une saisie est encore incomplete. Une ligne
 * qui ouvre un bloc (`if x:`) l'incremente ; une ligne comme `else:` referme un
 * bloc et en ouvre un autre, donc ne change rien. Aucune autre ligne n'y touche :
 * la ligne vide, et non le dedent, clot la saisie.
 */
function measureDepth(source: string): number {
  let depth = 0;
  for (const line of source.split('\n')) {
    if (line.trim() === '') continue;
    const opensBlock = /:\s*(#.*)?$/.test(line);
    // `else:`, `elif x:`, `except E:`, `finally:` : un bloc se ferme, un autre
    // s'ouvre, la profondeur reste la meme.
    const closesBlock = /^\s*(else|elif|except|finally)\b/.test(line);
    if (opensBlock && !closesBlock) depth++;
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
