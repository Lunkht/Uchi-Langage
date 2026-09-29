/**
 * Tests de l'execution isolee : fil dedie, delai de temps, et delai cooperatif
 * de l'interpreteur pour le REPL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runIsolated } from '../src/execution/isolated.ts';
import { UchiThrow } from '../src/errors.ts';
import { Interpreter } from '../src/interpreter/interpreter.ts';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UCHI = join(PROJECT, 'bin', 'uchi.mjs');

/** Depassement de delai maximal tolere par un test qui doit rester rapide. */
const MARGE = 3000;

/** Dossier jetable contenant un script Uchi. */
function script(source: string, name = 'essai.uchi'): string {
  const dir = mkdtempSync(join(tmpdir(), 'uchi-exec-'));
  const path = join(dir, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

/** Nom du type d'une exception levee par l'interpreteur. */
function typeDe(thrown: unknown): string {
  if (thrown instanceof UchiThrow && thrown.value instanceof Object && 'name' in thrown.value) {
    return String((thrown.value as { name: unknown }).name);
  }
  return thrown instanceof Error ? thrown.constructor.name : String(thrown);
}

// ------------------------------------------------------------- fil dedie

test('le fil dedie renvoie la sortie du programme', async () => {
  const path = script("print('bonjour')\n");
  const resultat = await runIsolated({ path }, 10_000);
  assert.equal(resultat.ok, true);
  assert.equal(resultat.error, null);
  assert.match(resultat.stdout, /bonjour/);
});

test('le fil dedie transmet sys.argv', async () => {
  const path = script("import sys\nprint(sys.argv[1], sys.argv[2])\n");
  const resultat = await runIsolated({ path, argv: [path, 'un', 'deux'] }, 10_000);
  assert.equal(resultat.ok, true);
  assert.match(resultat.stdout, /un deux/);
});

test('le fil dedie rend la sortie fragment par fragment', async () => {
  const path = script("for i in range(3):\n    print(i)\n");
  const fragments: string[] = [];
  const resultat = await runIsolated({ path, stream: true }, 10_000, (chunk) => fragments.push(chunk));
  assert.equal(resultat.ok, true);
  assert.ok(fragments.length >= 3, `un fragment par ecriture, recu ${fragments.length}`);
  assert.equal(fragments.join(''), resultat.stdout);
});

test('une erreur du programme revient avec son type et sa trace', async () => {
  const path = script('def f():\n    return 1 // 0\n\nf()\n');
  const resultat = await runIsolated({ path }, 10_000);
  assert.equal(resultat.ok, false);
  assert.equal(resultat.error?.name, 'ZeroDivisionError');
  assert.ok(resultat.trace.length > 0, 'la trace d appels est renseignee');
});

test('une erreur de syntaxe est signalee sans planter le fil', async () => {
  const path = script('def f(:\n');
  const resultat = await runIsolated({ path }, 10_000);
  assert.equal(resultat.ok, false);
  assert.equal(resultat.error?.name, 'SyntaxError');
});

test('sys.exit fournit le code de sortie demande', async () => {
  const path = script("import sys\nprint('avant')\nsys.exit(3)\nprint('apres')\n");
  const resultat = await runIsolated({ path }, 10_000);
  assert.equal(resultat.exitCode, 3);
  assert.match(resultat.stdout, /avant/);
  assert.doesNotMatch(resultat.stdout, /apres/);
});

test('un delai atteint interrompt le programme', async () => {
  const path = script('while True:\n    pass\n');
  const debut = Date.now();
  const resultat = await runIsolated({ path }, 300);
  const ecoule = Date.now() - debut;
  assert.equal(resultat.ok, false);
  assert.equal(resultat.error?.name, 'TimeoutError');
  assert.ok(ecoule < 300 + MARGE, `coupe a temps (${ecoule} ms)`);
});

test('le processus se termine apres une coupure, fil arrete compris', () => {
  // Un fil vivant retiendrait la boucle d'evenements : le processus ne
  // rendrait jamais la main, et cet appel depasserait son propre delai.
  const path = script("for i in range(2000000000):\n    pass\n");
  const debut = Date.now();
  const sortie = cli(['run', path, '--timeout', '1']);
  const ecoule = Date.now() - debut;
  assert.equal(sortie.code, 1);
  assert.match(sortie.stderr, /TimeoutError/);
  assert.ok(ecoule < 1000 + MARGE, `le processus a rendu la main (${ecoule} ms)`);
});

// ------------------------------------------------- delai cooperatif du REPL

test('le delai de l interpreteur interrompt une boucle while', () => {
  const interpreter = new Interpreter({ deadlineMs: 200 });
  assert.throws(
    () => interpreter.runSource('while True:\n    pass\n'),
    (thrown: unknown) => typeDe(thrown) === 'TimeoutError',
  );
});

test('le delai de l interpreteur interrompt une boucle for', () => {
  const interpreter = new Interpreter({ deadlineMs: 200 });
  assert.throws(
    () => interpreter.runSource("for c in 'x' * 20000000:\n    pass\n"),
    (thrown: unknown) => typeDe(thrown) === 'TimeoutError',
  );
});

test('le delai se rearme a chaque instruction du REPL', () => {
  const interpreter = new Interpreter({ deadlineMs: 200 });
  // La premiere instruction est interrompue...
  assert.throws(() => interpreter.runSource('while True:\n    pass\n'));
  // ...mais la session reste utilisable, avec l'etat conserve.
  assert.equal(interpreter.runSource('x = 41'), null);
  assert.equal(interpreter.runSource('x + 1'), 42);
});

test('sans delai configure, une boucle courte aboutit', () => {
  const interpreter = new Interpreter();
  interpreter.runSource('total = 0');
  assert.equal(interpreter.runSource('for i in range(100):\n    total = total + 1\n'), null);
  assert.equal(interpreter.runSource('total'), 100);
});

test('TimeoutError est rattrapable par le programme', () => {
  const interpreter = new Interpreter({ deadlineMs: 200 });
  const source = 'try:\n    while True:\n        pass\nexcept TimeoutError:\n    rattrape = 1\n';
  interpreter.runSource(source);
  assert.equal(interpreter.runSource('rattrape'), 1);
});

// -------------------------------------------------------------- ligne de commande

/** Resultat d'un appel de la ligne de commande. */
interface Sortie {
  code: number;
  stdout: string;
  stderr: string;
}

/** Appelle `uchi` comme le ferait un terminal. */
function cli(args: string[], saisie = ''): Sortie {
  const resultat = spawnSync(process.execPath, [UCHI, ...args], {
    encoding: 'utf8',
    input: saisie,
    // Un programme que rien n'arrete a tuer le test plutot que la suite.
    timeout: 60_000,
  });
  assert.equal(resultat.error, undefined, `appel interrompu : ${resultat.error?.message}`);
  return { code: resultat.status ?? -1, stdout: resultat.stdout, stderr: resultat.stderr };
}

test('la ligne de commande execute un script et rend son code', () => {
  const path = script("print('bonjour')\n");
  const sortie = cli(['run', path]);
  assert.equal(sortie.code, 0);
  assert.match(sortie.stdout, /bonjour/);
});

test('la ligne de commande respecte le code de sortie de sys.exit', () => {
  const path = script("import sys\nsys.exit(3)\n");
  const sortie = cli(['run', path]);
  assert.equal(sortie.code, 3);
  assert.doesNotMatch(sortie.stderr, /SystemExit/);
});

test('la ligne de commande rend le code 1 et la trace sur une erreur', () => {
  const path = script('def f():\n    return 1 // 0\n\nf()\n');
  const sortie = cli(['run', path]);
  assert.equal(sortie.code, 1);
  assert.match(sortie.stderr, /ZeroDivisionError/);
});

test('la ligne de commande coupe un programme trop long', () => {
  const path = script('while True:\n    pass\n');
  const debut = Date.now();
  const sortie = cli(['run', path, '--timeout', '1']);
  const ecoule = Date.now() - debut;
  assert.equal(sortie.code, 1);
  assert.match(sortie.stderr, /TimeoutError/);
  assert.ok(ecoule < 1000 + MARGE, `coupe a temps (${ecoule} ms)`);
});

test('--timeout se place avant ou apres le fichier', () => {
  const path = script("import sys\nprint(sys.argv)\n");
  for (const args of [
    ['run', '--timeout', '5', path],
    ['run', path, '--timeout', '5'],
  ]) {
    const sortie = cli(args);
    assert.equal(sortie.code, 0, `forme : ${args.join(' ')}`);
    assert.doesNotMatch(sortie.stdout, /--timeout/);
  }
});

test('un separateur rend --timeout au script', () => {
  const path = script("import sys\nprint(sys.argv[1])\n");
  const sortie = cli(['run', path, '--', '--timeout']);
  assert.equal(sortie.code, 0);
  assert.match(sortie.stdout, /--timeout/);
});

test('les arguments du script sont transmis apres le fichier', () => {
  const path = script("import sys\nprint(sys.argv[1], sys.argv[2])\n");
  const sortie = cli(['run', path, '-v', '--bidule']);
  assert.equal(sortie.code, 0);
  assert.match(sortie.stdout, /-v --bidule/);
});

test('--no-timeout rend le terminal au script', () => {
  const path = script("nom = input('nom ? ')\nprint('salut', nom)\n");
  const sortie = cli(['run', path, '--no-timeout'], 'Mathis\n');
  assert.equal(sortie.code, 0);
  assert.match(sortie.stdout, /salut Mathis/);
});

test('sans --no-timeout, le fil dedie n a pas de terminal', () => {
  const path = script("nom = input('nom ? ')\nprint('salut', nom)\n");
  const sortie = cli(['run', path], 'Mathis\n');
  assert.notEqual(sortie.code, 0);
  assert.doesNotMatch(sortie.stdout, /salut/);
});

test('le REPL interrompt une boucle trop longue et garde sa session', () => {
  // La boucle ne touche pas `x` : la valeur affichee ensuite prouve que la
  // session survit a l'interruption.
  const sortie = cli(['repl', '--timeout', '1'], 'x = 41\nwhile True: pass\nx + 1\nexit()\n');
  assert.match(sortie.stderr, /TimeoutError/);
  assert.match(sortie.stdout, /42/, "l'etat de la session est conserve");
  assert.equal(sortie.code, 0);
});

test('le REPL execute une fonction saisie ligne par ligne', () => {
  const sortie = cli(['repl'], 'def double(x):\n    return x * 2\n\ndouble(21)\nexit()\n');
  assert.equal(sortie.code, 0);
  assert.doesNotMatch(sortie.stderr, /SyntaxError/);
  assert.match(sortie.stdout, /\b42\b/);
});

test('le REPL execute un if / else saisi ligne par ligne', () => {
  const sortie = cli(['repl'], "if 1 > 2:\n    print('faux')\nelse:\n    print('vrai')\n\nexit()\n");
  assert.equal(sortie.code, 0);
  assert.doesNotMatch(sortie.stderr, /SyntaxError/);
  assert.match(sortie.stdout, /vrai/);
  assert.doesNotMatch(sortie.stdout, /faux/);
});

test('le REPL execute un try / except saisi ligne par ligne', () => {
  const saisie = "try:\n    1 // 0\nexcept ZeroDivisionError:\n    print('rattrape')\n\nexit()\n";
  const sortie = cli(['repl'], saisie);
  assert.equal(sortie.code, 0);
  assert.doesNotMatch(sortie.stderr, /SyntaxError/);
  assert.match(sortie.stdout, /rattrape/);
});

test('le REPL execute des blocs imbriques', () => {
  const saisie = 'def somme():\n    t = 0\n    for n in range(4):\n        t = t + n\n    return t\n\nsomme()\nexit()\n';
  const sortie = cli(['repl'], saisie);
  assert.equal(sortie.code, 0);
  assert.doesNotMatch(sortie.stderr, /SyntaxError/);
  assert.match(sortie.stdout, /\b6\b/);
});

test('le REPL interrompt un bloc while saisi ligne par ligne', () => {
  // Le cas que seule la saisie multi-lignes rend possible : le delai doit
  // s'appliquer au bloc entier, et la session rester utilisable.
  const sortie = cli(['repl', '--timeout', '1'], 'n = 0\nwhile True:\n    n = n + 1\n\nn >= 0\nprint(\'vivant\')\nexit()\n');
  assert.match(sortie.stderr, /TimeoutError/);
  assert.match(sortie.stdout, /vivant/);
  assert.equal(sortie.code, 0);
});

test('une ligne vide au repos est ignoree', () => {
  const sortie = cli(['repl'], '\n\n1 + 1\n\n\nexit()\n');
  assert.equal(sortie.code, 0);
  assert.doesNotMatch(sortie.stderr, /SyntaxError/);
  assert.match(sortie.stdout, /\b2\b/);
});

test('les options invalides sont refusees', () => {
  const path = script('pass\n');
  for (const args of [
    ['run', path, '--timeout', '0'],
    ['run', path, '--timeout', 'zeste'],
    ['run', '--bidule', path],
    ['repl', '--bidule'],
    ['gui', '--no-timeout'],
  ]) {
    assert.equal(cli(args).code, 2, `forme refusee : ${args.join(' ')}`);
  }
});
