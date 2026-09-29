/**
 * Tests de la bibliotheque standard : fichiers, modules et conversions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Interpreter } from '../src/interpreter/interpreter.ts';
import { UchiThrow } from '../src/errors.ts';
import { UchiError, UchiInstance } from '../src/interpreter/values.ts';

/** Repertoire de travail jetable, propre a chaque test. */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'uchi-test-'));
}

interface RunOptions {
  baseDirectory?: string;
  readLine?: () => string | null;
  argv?: string[];
  /** Dossier auquel `open()` est confine ; absent, le programme est libre. */
  fileRoot?: string;
}

function run(source: string, options: RunOptions = {}): string {
  let output = '';
  const interpreter = new Interpreter({
    write: (text) => { output += text; },
    readLine: options.readLine,
    baseDirectory: options.baseDirectory,
    argv: options.argv,
    fileRoot: options.fileRoot,
  });
  interpreter.runSource(source, 'test.uchi');
  return output;
}

/** Verifie le type d'une exception levee par une source. */
function assertThrows(source: string, expected: string, options: RunOptions = {}): void {
  assert.throws(
    () => run(source, options),
    (error: unknown) => {
      assert.ok(error instanceof UchiThrow, 'une UchiThrow est attendue');
      const value = error.value;
      const name = value instanceof UchiError
        ? value.name
        : value instanceof UchiInstance
          ? value.klass.name
          : '';
      assert.equal(name, expected);
      return true;
    },
  );
}

test('`open` lit et ecrit un fichier texte', () => {
  const dir = workspace();
  const data = join(dir, 'donnees.txt').replaceAll('\\', '/');
  writeFileSync(join(dir, 'donnees.txt'), 'ligne un\nligne deux\n', 'utf8');

  assert.equal(
    run(`f = open("${data}")\nprint(repr(f.read()))\nf.close()\n`),
    "'ligne un\\nligne deux\\n'\n",
  );
  // `read(n)` respecte le tampon deja rempli par `readline()`.
  assert.equal(
    run(`f = open("${data}")\nf.readline()\nprint(repr(f.read(3)), repr(f.read(4)))\nf.close()\n`),
    "'lig' 'ne d'\n",
  );
  // `readlines` rend toutes les lignes, `readline` une seule.
  assert.equal(
    run(`f = open("${data}")\nprint(f.readlines(), repr(f.readline()), f.readable())\nf.close()\n`),
    "['ligne un\\n', 'ligne deux\\n'] '' True\n",
  );
});

test('un fichier s\'ecrit et se relit', () => {
  const dir = workspace();
  const out = join(dir, 'sortie.txt').replaceAll('\\', '/');
  assert.equal(
    run(`g = open("${out}", 'w')\nprint(g.write('oui'), g.writable(), g.mode())\ng.close()\nprint(repr(open("${out}").read()))\n`),
    "3 True w\n'oui'\n",
  );
});

test('les erreurs de fichier et de mode sont distinguees', () => {
  const dir = workspace();
  const absent = join(dir, 'absent.txt').replaceAll('\\', '/');
  assertThrows(`open("${absent}")\n`, 'FileNotFoundError');
  // Le mode est valide avant l'ouverture : une faute de frappe donne ValueError.
  assertThrows(`open("${absent}", 'zz')\n`, 'ValueError');
});

test('un interpreteur confine refuse de sortir de son dossier', () => {
  const dehors = workspace();
  const dir = workspace();
  writeFileSync(join(dehors, 'secret.txt'), 'donnees sensibles', 'utf8');
  writeFileSync(join(dir, 'propre.txt'), 'lu', 'utf8');
  const confine = { fileRoot: dir };

  // Le contenu du dossier de travail reste accessible, en lecture comme en
  // ecriture, par chemin absolu comme par chemin relatif.
  assert.equal(
    run(`f = open("propre.txt")\nprint(f.read())\nf.close()\n`, confine),
    'lu\n',
  );
  const sortie = join(dir, 'cree.txt').replaceAll('\\', '/');
  assert.equal(run(`g = open("${sortie}", 'w')\nprint(g.write('oui'))\ng.close()\n`, confine), '3\n');
  assert.equal(
    run(`f = open("cree.txt")\nprint(f.read())\nf.close()\n`, confine),
    'oui\n',
  );

  const exterieur = join(dehors, 'secret.txt').replaceAll('\\', '/');
  assertThrows(`open("${exterieur}")\n`, 'PermissionError', confine);
  assertThrows(`open("../${exterieur}")\n`, 'PermissionError', confine);
  assertThrows(`open("..\\\\..\\\\Windows\\\\win.ini")\n`, 'PermissionError', confine);
  // Un lien symbolique dans le dossier ne doit pas ouvrir la porte de l'etre.
  symlinkSync(dehors, join(dir, 'evasion'), 'junction');
  assertThrows('open("evasion/secret.txt")\n', 'PermissionError', confine);
  // Le dossier parent sort de la racine : c'est la frontiere a verifier.
  const parent = join(dir, '..').replaceAll('\\', '/');
  assertThrows(`open("${parent}")\n`, 'PermissionError', confine);

  // Sans `fileRoot`, le programme n'est pas confine : c'est le cas de
  // `uchi run`, ou l'utilisateur choisit lui-meme ses chemins.
  assert.equal(run(`f = open("${exterieur}")\nprint(f.read())\nf.close()\n`), 'donnees sensibles\n');
  // Le mode reste valide avant le confinement : la faute de frappe est la meme.
  assertThrows(`open("propre.txt", 'zz')\n`, 'ValueError', confine);
  assertThrows('open("absent.txt")\n', 'FileNotFoundError', confine);
});

test('les imports de modules et de paquets sont hierarchiques', () => {
  const dir = workspace();
  mkdirSync(join(dir, 'pkg'));
  writeFileSync(join(dir, 'pkg', '__init__.uchi'), "VERSION = '1.0'\n", 'utf8');
  writeFileSync(join(dir, 'pkg', 'outil.uchi'), 'def double(x):\n    return x * 2\n', 'utf8');

  assert.equal(
    run(
      'import pkg\nimport pkg.outil\nimport pkg.outil as outils\nfrom pkg.outil import double\n'
        + "print(pkg.VERSION, outils.double(21), double(5), pkg.outil.double(3))\n",
      { baseDirectory: dir },
    ),
    '1.0 42 10 6\n',
  );
  assert.equal(run('from pkg.outil import *\nprint(double(4))\n', { baseDirectory: dir }), '8\n');
  assertThrows('from pkg.outil import absent\n', 'ImportError', { baseDirectory: dir });
  assertThrows('import paquet_absent\n', 'ModuleNotFoundError', { baseDirectory: dir });
});

test('`input` lit la ligne fournie par l\'hebergeur', () => {
  assert.equal(run('nom = input("Nom ? ")\nprint(nom)\n', { readLine: () => 'Uchi' }), 'Nom ? Uchi\n');
  // En Python, `input()` sur une fin de flux leve EOFError.
  assertThrows('print(input())\n', 'EOFError', { readLine: () => null });
});

test('les modules `math`, `sys` et `string` sont disponibles', () => {
  // `int` et `float` partagent le meme type : `sqrt(16)` s'affiche `4`.
  assert.equal(
    run('import math\nprint(math.sqrt(16), math.floor(2.7), math.ceil(2.1), math.factorial(5))\n'),
    '4 2 3 120\n',
  );
  assert.equal(
    run('import math\nprint(math.lcm(4, 6), math.gcd(12, 18), math.isqrt(17), math.lcm(2, 3, 4))\n'),
    '12 6 4 12\n',
  );
  assert.equal(
    run('import math\nprint(math.trunc(-2.7), math.pow(2, 10), math.log(math.exp(1)), math.copysign(3, -1))\n'),
    '-2 1024 1 -3\n',
  );
  assert.equal(run('import math\nprint(math.dist([0, 0], [3, 4]), math.prod(2, 3, 4))\n'), '5 24\n');
  assert.equal(run('import string\nprint(string.ascii_lowercase, len(string.digits))\n'), 'abcdefghijklmnopqrstuvwxyz 10\n');
  // Les delegues transmettent positionnels et arguments nommes a la methode.
  assert.equal(
    run('import string\nprint(string.split("a,b,c", sep=","), string.split("a,b,c", ",", 1))\n'),
    "['a', 'b', 'c'] ['a', 'b,c']\n",
  );
  // `string.join` prend le separateur en premier, comme `_string.join`.
  assert.equal(run('import string\nprint(string.join("-", ["a", "b"]))\n'), 'a-b\n');
  assert.equal(
    run('import string\nprint(string.capwords(" aBc  dEf "))\n'),
    ' Abc  Def \n',
  );
  // Noms de constantes de Python 3.
  assert.equal(
    run('import string\nprint(string.hexdigits, string.octdigits, len(string.printable))\n'),
    '0123456789abcdefABCDEF 01234567 100\n',
  );
  assert.equal(run('import sys\nprint(sys.argv, len(sys.argv))\n'), '[] 0\n');
  assert.equal(
    run('import sys\nprint(sys.argv)\n', { argv: ['script.uchi', 'a'] }),
    "['script.uchi', 'a']\n",
  );
});

test('`re` recherche, extrait et remplace selon CPython', () => {
  assert.equal(
    run('import re\nprint(re.search(r"\\d+", "abc 123 def").group())\n'),
    '123\n',
  );
  assert.equal(
    run('import re\nm = re.search(r"(\\d+)-(\\d+)", "x 10-20 y")\nprint(m.span(), m.start(1), m.end(2))\n'),
    '[2, 7] 2 7\n',
  );
  // `match` ancre le debut, `fullmatch` la chaine entiere.
  assert.equal(
    run('import re\nprint(re.match(r"\\d+", "12ab"), re.match(r"\\d+", "ab12"), re.fullmatch(r"\\d+", "12a"))\n'),
    "<re.Match object; span=0, match=\"12\"> None None\n",
  );
  // Un seul groupe renvoie des chaines, plusieurs groupes des tuples.
  assert.equal(
    run('import re\nprint(re.findall(r"\\d+", "a1b22"), re.findall(r"(\\w)(\\d)", "a1 b2"))\n'),
    "['1', '22'] [('a', '1'), ('b', '2')]\n",
  );
  // Groupes nommes : par nom, par position et via `groupdict`.
  assert.equal(
    run('import re\nm = re.search(r"(?P<mot>\\w+)=(?P<valeur>\\d+)", "x=42")\nprint(m.group("mot"), m.group(2), m.groupdict())\n'),
    "x 42 {'mot': 'x', 'valeur': '42'}\n",
  );
  assert.equal(
    run('import re\np = re.compile(r"(?P<a>\\w)(\\d)")\nprint(p.groups, p.groupindex["a"], p.findall("a1 b2"))\n'),
    '2 1 [(\'a\', \'1\'), (\'b\', \'2\')]\n',
  );
  // `sub`/`subn` : references par numero, par nom et fonction de rappel.
  assert.equal(
    run('import re\nprint(re.sub(r"\\s+", "-", "a  b   c"), re.subn(r"\\d", "#", "a1b2"))\n'),
    "a-b-c ('a#b#', 2)\n",
  );
  assert.equal(
    run('import re\nprint(re.sub(r"(?P<cle>\\w+)@(?P<valeur>\\w+)", r"\\g<valeur>=\\g<cle>", "root@host"))\n'),
    'host=root\n',
  );
  assert.equal(
    run('import re\ndef maj(m):\n    return m.group(0).upper()\nprint(re.sub(r"[a-z]+", maj, "un deux trois"))\n'),
    'UN DEUX TROIS\n',
  );
  // `split` restitue les groupes capturants et respecte `maxsplit`.
  assert.equal(
    run('import re\nprint(re.split(r",\\s*", "a, b,c"), re.split(r",", "a,b,c", 1), re.split(r"(\\s+)", "a b"))\n'),
    "['a', 'b', 'c'] ['a', 'b,c'] ['a', ' ', 'b']\n",
  );
  // Options : `re.I` au module, drapeau au niveau motif, `escape`.
  assert.equal(
    run('import re\nprint(re.compile("abc", re.I).search("ABC").group(), re.escape("a.b*"))\n'),
    'ABC a\\.b\\*\n',
  );
  // Une erreur de motif leve `re.error`.
  assertThrows('import re\nre.compile("(unterminated")\n', 're.error');
});

test('`json` encode et decode comme CPython', () => {
  assert.equal(
    run('import json\nprint(json.dumps({"nom": "Uchi", "version": 1, "ok": True, "rien": None}))\n'),
    '{"nom": "Uchi", "version": 1, "ok": true, "rien": null}\n',
  );
  // Un tuple s'encode comme une liste, les separators changent avec `indent`.
  assert.equal(
    run('import json\nprint(json.dumps((1, 2)), json.dumps({"a": 1, "b": [1, 2]}, indent=2))\n'),
    '[1, 2] {\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n',
  );
  assert.equal(
    run('import json\nprint(json.dumps({"b": 1, "a": 2}, sort_keys=True), json.dumps({"a": 1}, separators=(",", ":")))\n'),
    '{"a": 2, "b": 1} {"a":1}\n',
  );
  // `ensure_ascii` echappe les caracteres hors ASCII.
  assert.equal(
    run('import json\nprint(json.dumps("caf\\u00e9 \\u2603"), json.dumps("caf\\u00e9", ensure_ascii=False))\n'),
    '"caf\\u00e9 \\u2603" "café"\n',
  );
  // Les cles non-chaînes sont converties, `skipkeys` les ignore.
  assert.equal(
    run('import json\nprint(json.dumps({True: 1, None: 2, 3: "trois"}))\n'),
    '{"true": 1, "null": 2, "3": "trois"}\n',
  );
  assert.equal(
    run('import json\nprint(json.dumps({(1, 2): "x"}, skipkeys=True))\n'),
    '{}\n',
  );
  assertThrows('import json\njson.dumps({(1, 2): "x"})\n', 'TypeError');
  // `loads` reconstruit listes et dictionnaires ; les constantes de Python sont
  // acceptees et une cle en double garde la derniere valeur.
  assert.equal(
    run('import json\nd = json.loads("{\\"nom\\": \\"Uchi\\", \\"tags\\": [1, 2.5, true, null]}")\nprint(d["nom"], d["tags"], d)\n'),
    "Uchi [1, 2.5, True, None] {'nom': 'Uchi', 'tags': [1, 2.5, True, None]}\n",
  );
  assert.equal(
    run('import json\nprint(json.loads("[1, [2, [3]]]"), json.loads(" \\"texte\\" "), json.loads("null"))\n'),
    "[1, [2, [3]]] texte None\n",
  );
  assert.equal(
    run('import json\nprint(json.loads("{\\"a\\": 1, \\"a\\": 2}"), repr(json.loads("\\"\\\\u2603 \\\\n\\"")))\n'),
    "{'a': 2} '☃ \\n'\n",
  );
  // Aller-retour : l'objet retrouve est equivalent a l'original.
  assert.equal(
    run('import json\nsource = {"a": [1, 2], "b": "x"}\nprint(json.loads(json.dumps(source)) == source)\n'),
    'True\n',
  );
  // `json.dump` ecrit sur un flux.
  const dir = workspace();
  const file = join(dir, 'donnees.json').replaceAll('\\', '/');
  assert.equal(
    run(`import json\nf = open("${file}", "w")\njson.dump({"a": 1}, f, indent=2)\nf.close()\nprint(repr(open("${file}").read()))\n`),
    '\'{\\n  "a": 1\\n}\'\n',
  );
  // Une erreur de syntaxe est un `json.JSONDecodeError`, donc un `ValueError`.
  assert.equal(
    run('import json\ntry:\n    json.loads("{oups}")\nexcept json.JSONDecodeError:\n    print("JSONDecodeError")\nexcept ValueError:\n    print("ValueError")\n'),
    'JSONDecodeError\n',
  );
  assert.equal(
    run('import json\ntry:\n    json.loads("[1, 2")\nexcept ValueError:\n    print("ValueError")\n'),
    'ValueError\n',
  );
  // Le message reprend la position, comme `json.decoder.JSONDecodeError`.
  assert.equal(
    run('import json\ntry:\n    json.loads("{oups}")\nexcept ValueError as e:\n    print(e)\n'),
    'json.JSONDecodeError : Expecting property name enclosed in double quotes: line 1 column 2 (char 1)\n',
  );
});
