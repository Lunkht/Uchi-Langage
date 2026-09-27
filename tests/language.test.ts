/**
 * Tests de comportement du langage.
 *
 * Chaque test execute un extrait et compare la sortie capturee, ce qui evite
 * de dependre de l'API interne de l'interpreteur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Interpreter } from '../src/interpreter/interpreter.ts';
import { UchiSyntaxError, UchiThrow } from '../src/errors.ts';
import { UchiError, UchiInstance, type UchiValue } from '../src/interpreter/values.ts';
import { typeName } from '../src/interpreter/operations.ts';

/** Execute une source et renvoie tout ce qui a ete ecrit. */
function run(source: string): string {
  let output = '';
  const interpreter = new Interpreter({ write: (text) => { output += text; } });
  interpreter.runSource(source, 'test.uchi');
  return output;
}

/** Renvoie la valeur de la derniere expression, convertie en chaine. */
function value(source: string): string {
  const interpreter = new Interpreter({ write: () => {} });
  const result = interpreter.runSource(source, 'test.uchi');
  return result === undefined || result === null ? 'None' : String(result);
}

/** Renvoie le nom et le message de l'exception levee. */
function failure(source: string): string {
  try {
    run(source);
  } catch (error) {
    assert.ok(error instanceof UchiThrow, 'une UchiThrow est attendue');
    const value = error.value;
    if (value instanceof UchiError) return `${value.name}: ${value.message}`;
    if (value instanceof UchiInstance) {
      return `${value.klass.name}: ${String(value.get('args'))}`;
    }
    return `${typeName(value as UchiValue)}: ${String(value as UchiValue)}`;
  }
  assert.fail('aucune exception levee');
}

/** Renvoie le message d'erreur de syntaxe leve par le lexer ou le parser. */
function syntaxFailure(source: string): string {
  try {
    run(source);
  } catch (error) {
    assert.ok(error instanceof UchiSyntaxError, 'une UchiSyntaxError est attendue');
    return error.message;
  }
  assert.fail('aucune erreur de syntaxe levee');
}

// ----------------------------------------------------------------- chaines

test('les sequences d\'echappement suivent Python', () => {
  // `\uXXXX` et `\UXXXXXXXX` designent un point de code Unicode.
  assert.equal(run('print("\\u00e9", "\\u2603", "\\U0001F600")\n'), 'é ☃ 😀\n');
  // `\xXX` reste sur un octet, `\u{...}` reste une extension du langage.
  assert.equal(run('print("\\x41", "\\u{1F600}".upper() == "")\n'), 'A False\n');
  // Les chaines brutes conservent l'antislash, sauf devant le guillemet.
  assert.equal(run('print(r"\\d+", r"a\\nb")\n'), '\\d+ a\\nb\n');
  // Un nom Unicode n'est pas resolu : l'erreur est explicite.
  assert.match(syntaxFailure('print("\\N{BULLET}")\n'), /non prise en charge/);
  // Un `\u` incomplet est signale.
  assert.match(
    syntaxFailure('print("\\uZZZZ")\n'),
    /sequence d'echappement \\u attend 4 chiffres hexadecimaux/,
  );
});

// ----------------------------------------------------------------- parametres

test('les arguments positionnels et nommes se completent', () => {
  assert.equal(
    run('def f(a, b=2, *args, c, d=4, **kw):\n    return a, b, args, c, d, kw\nprint(f(1, c=3))\n'),
    '(1, 2, [], 3, 4, {})\n',
  );
  assert.equal(
    run('def f(a, b=2, *args, c, d=4, **kw):\n    return a, b, args, c, d, kw\nprint(f(1, 20, 30, 40, c=3, e=5))\n'),
    '(1, 20, [30, 40], 3, 4, {\'e\': 5})\n',
  );
  assert.equal(
    run('def f(a, b=2, *args, c, d=4, **kw):\n    return a, b, args, c, d, kw\nprint(f(b=9, a=8, c=7))\n'),
    '(8, 9, [], 7, 4, {})\n',
  );
});

test('`/` rend les parametres non designables par leur nom', () => {
  assert.equal(run('def h(a, b, /, c):\n    return a, b, c\nprint(h(1, 2, c=3))\n'), '(1, 2, 3)\n');
  assert.equal(
    failure('def h(a, b, /, c):\n    return a, b, c\nh(1, b=2, c=3)\n'),
    "TypeError: h() : le parametre 'b' est positionnel et ne peut pas etre nomme",
  );
});

test('les arguments manquants ou en trop sont signales', () => {
  assert.equal(failure('def f(a):\n    return a\nf()\n'), "TypeError: f() : argument(s) manquant(s) : a");
  assert.equal(
    failure('def f(a):\n    return a\nf(1, 2)\n'),
    "TypeError: f() attend 1 argument(s) positionnel(s) mais 2 ont ete passes",
  );
});

test('les valeurs par defaut et nommes multiples sont rejetés', () => {
  assert.equal(
    failure('def f(a=1):\n    return a\nprint(f(2, a=3))\n'),
    "TypeError: f() recoit plusieurs valeurs pour l'argument 'a'",
  );
  assert.equal(
    failure('def f(a):\n    return a\nf(nom=1)\n'),
    "TypeError: f() : argument(s) nomme(s) inattendu(s) : nom",
  );
});

// ------------------------------------------------------------------- closures

test('`global` et `nonlocal` modifient la bonne portee', () => {
  assert.equal(
    run('counter = 0\ndef bump():\n    global counter\n    counter = counter + 1\nbump()\nbump()\nprint(counter)\n'),
    '2\n',
  );
  assert.equal(
    run(
      'def outer():\n    total = 0\n    def inner():\n        nonlocal total\n        total = total + 5\n    inner()\n    inner()\n    return total\nprint(outer())\n',
    ),
    '10\n',
  );
});

// ------------------------------------------------------------------ iterateurs

test('les itiseurs natifs et personnalises fonctionnent', () => {
  assert.equal(run('r = range(5)\nprint(r[0], r[-1], len(r))\n'), '0 4 5\n');
  assert.equal(run('total = 0\nfor n in range(1, 5):\n    total = total + n\nprint(total)\n'), '10\n');
  assert.equal(
    run(
      'class Compteur:\n    def __init__(self):\n        self.n = 0\n    def __iter__(self):\n        return self\n    def __next__(self):\n        self.n = self.n + 1\n        if self.n > 3:\n            raise StopIteration\n        return self.n\nprint(list(Compteur()))\n',
    ),
    '[1, 2, 3]\n',
  );
  assert.equal(
    run('it = iter([7, 8])\nprint(next(it), next(it))\n'),
    '7 8\n',
  );
});

// ------------------------------------------------------------------- tranches

test('les tranches negatives et les pas negatives suivent Python', () => {
  assert.equal(run('xs = [1, 2, 3, 4, 5]\nprint(xs[::-1])\n'), '[5, 4, 3, 2, 1]\n');
  assert.equal(run('xs = [1, 2, 3, 4, 5]\nprint(xs[:-1], xs[-2:])\n'), '[1, 2, 3, 4] [4, 5]\n');
  assert.equal(run('xs = [1, 2, 3, 4, 5]\nprint(xs[-10:2], xs[10:20])\n'), '[1, 2] []\n');
  assert.equal(run('xs = [1, 2, 3, 4, 5]\nprint(xs[::2], xs[1:4:2])\n'), '[1, 3, 5] [2, 4]\n');
  assert.equal(run('xs = [1, 2, 3]\nprint(xs[-1])\n'), '3\n');
  assert.equal(
    failure('xs = [1, 2, 3]\nprint(xs[10])\n'),
    'IndexError: index de liste hors limites : 10 (longueur 3)',
  );
  assert.equal(
    failure('xs = [1, 2, 3]\nxs[10] = 9\n'),
    'IndexError: index de liste hors limites : 10 (longueur 3)',
  );
});

// ---------------------------------------------------------------- affectations

test('le depaquetage et les affectations chainees fonctionnent', () => {
  assert.equal(run('a, *reste = [1, 2, 3, 4]\nprint(a, reste)\n'), '1 [2, 3, 4]\n');
  assert.equal(run('a = b = 7\nprint(a, b)\n'), '7 7\n');
  assert.equal(run('a, b = 1, 2\na, b = b, a\nprint(a, b)\n'), '2 1\n');
  assert.equal(
    failure('*a = [1, 2]\n'),
    "SyntaxError: une cible '*' ne peut pas etre assignee directement",
  );
});

// ------------------------------------------------------------------ operateurs

test('les operateurs utilisateur sont utilises', () => {
  assert.equal(
    run(
      'class Point:\n    def __init__(self, x):\n        self.x = x\n    def __add__(self, autre):\n        return Point(self.x + autre.x)\n    def __eq__(self, autre):\n        return self.x == autre.x\n    def __repr__(self):\n        return f"Point({self.x})"\na = Point(1) + Point(2)\nprint(a, a == Point(3))\n',
    ),
    'Point(3) True\n',
  );
  assert.equal(
    failure('print(1 + "a")\n'),
    "TypeError: operateur '+' non defini entre 'int' et 'str'",
  );
});

test('les classes heritent des methodes', () => {
  assert.equal(
    run(
      'class A:\n    def presenter(self):\n        return "A"\nclass B(A):\n    def presenter(self):\n        return "B" + super().presenter()\nprint(B().presenter())\n',
    ),
    'BA\n',
  );
});

// ------------------------------------------------------------------- exceptions

test('les exceptions constructions par l\'utilisateur sont capturables', () => {
  assert.equal(
    run('class MonErreur(Exception):\n    pass\ntry:\n    raise MonErreur("oups")\nexcept MonErreur as e:\n    print(str(e))\n'),
    'oups\n',
  );
  assert.equal(
    run('try:\n    int("x")\nexcept ValueError as e:\n    print(str(e))\nelse:\n    print("else")\nfinally:\n    print("fin")\n'),
    "int() : la chaine 'x' n'est pas un entier valide en base 10\nfin\n",
  );
  assert.equal(
    run('try:\n    print("avant")\n    raise ValueError("stop")\nexcept ValueError:\n    print("capture")\nelse:\n    print("else")\nfinally:\n    print("fin")\n'),
    'avant\ncapture\nfin\n',
  );
  assert.equal(
    failure('raise ValueError("boom")\n'),
    'ValueError: boom',
  );
});

test('`except` accepte un tuple de types et la hierarchie systeme', () => {
  assert.equal(
    run('try:\n    int("x")\nexcept (TypeError, ValueError) as e:\n    print("capture")\n'),
    'capture\n',
  );
  assert.equal(
    run('try:\n    open("C:/chemin/inexistant/zz.txt")\nexcept FileNotFoundError:\n    print("fichier")\n'),
    'fichier\n',
  );
  // Une classe de base attrape toute sa descendance.
  assert.equal(run('try:\n    1 / 0\nexcept ArithmeticError:\n    print("arith")\n'), 'arith\n');
  // Un `except` qui ne correspond pas laisse passer l'exception.
  assert.equal(failure('try:\n    1 / 0\nexcept OSError:\n    print("faux")\n'), 'ZeroDivisionError: division par zero');
  // L'instance d'erreur est bien de la classe attendue.
  assert.equal(
    run('try:\n    open("C:/chemin/inexistant/zz.txt")\nexcept OSError as e:\n    print(isinstance(e, FileNotFoundError))\n'),
    'True\n',
  );
});

test('les boucles for et while ont un bloc `else`', () => {
  const without = 'for n in [1, 2, 3]:\n    if n == 2:\n        break\nelse:\n    print("else")\n';
  assert.equal(run(without), '');
  assert.equal(
    run('for n in [1, 2, 3]:\n    if n == 9:\n        break\nelse:\n    print("else")\n'),
    'else\n',
  );
  assert.equal(run('for n in []:\n    pass\nelse:\n    print("vide")\n'), 'vide\n');
  // `continue` n'annule pas le bloc `else`.
  assert.equal(run('for n in [1]:\n    continue\nelse:\n    print("suite")\n'), 'suite\n');
  const whileWithout = 'i = 0\nwhile i < 3:\n    i += 1\n    break\nelse:\n    print("else")\n';
  assert.equal(run(whileWithout), '');
  assert.equal(run('i = 0\nwhile i < 2:\n    i += 1\nelse:\n    print("else")\n'), 'else\n');
});

test('`with` appelle `__enter__` et `__exit__`', () => {
  const source = [
    'class Contexte:',
    '    def __init__(self, nom):',
    '        self.nom = nom',
    '    def __enter__(self):',
    '        print("enter", self.nom)',
    '        return self.nom',
    '    def __exit__(self, type, valeur, traceback):',
    '        print("exit", type is None, valeur, traceback)',
    'with Contexte("A") as c:',
    '    print("corps", c)',
    '',
  ].join('\n');
  assert.equal(run(source), 'enter A\ncorps A\nexit True None None\n');
  // Une exception traversant le bloc est transmise a `__exit__`, qui peut
  // l'etaler : une valeur veridique la supprime.
  const suppress = [
    'class Silence:',
    '    def __enter__(self):',
    '        return 1',
    '    def __exit__(self, type, valeur, traceback):',
    '        print("vu", type.__name__, valeur)',
    '        return True',
    'with Silence():',
    '    raise ValueError("boom")',
    'print("apres")',
    '',
  ].join('\n');
  assert.equal(run(suppress), 'vu ValueError boom\napres\n');
  // Sans suppression, l'exception repart et reste rattrapable.
  const relay = [
    'class Passant:',
    '    def __enter__(self):',
    '        return 1',
    '    def __exit__(self, type, valeur, traceback):',
    '        return False',
    'try:',
    '    with Passant():',
    '        raise ValueError("boom")',
    'except ValueError as e:',
    '    print("relayee", e)',
    '',
  ].join('\n');
  assert.equal(run(relay), 'relayee boom\n');
  // Un objet sans `__enter__` est refuse.
  assert.match(failure('with 3 as x:\n    pass\n'), /ne peut pas servir de gestionnaire de contexte/);
});

test('`with` accepte plusieurs items, parentheses ou non', () => {
  const source = [
    'class Trace:',
    '    def __init__(self, nom):',
    '        self.nom = nom',
    '    def __enter__(self):',
    '        print("+", self.nom)',
    '        return self',
    '    def __exit__(self, type, valeur, traceback):',
    '        print("-", self.nom)',
    'with Trace("a") as x, Trace("b") as y:',
    '    print("corps")',
    'with (Trace("c") as z):',
    '    print("corps2")',
    '',
  ].join('\n');
  assert.equal(run(source), '+ a\n+ b\ncorps\n- b\n- a\n+ c\ncorps2\n- c\n');
});

test('les lambdas ont les memes parametres que les fonctions', () => {
  assert.equal(
    run('lam = lambda x, y=2: x + y\nprint(lam(1), lam(1, 5))\n'),
    '3 6\n',
  );
  assert.equal(run('carre = lambda n: n * n\nprint(carre(4), (lambda: 42)())\n'), '16 42\n');
  assert.equal(
    run('f = lambda *args, **kw: (args, kw)\nprint(f(1, 2, a=3))\n'),
    "([1, 2], {'a': 3})\n",
  );
  // Le `:` d'un parametre de lambda introduit le corps, pas une annotation.
  assert.equal(run('tri = lambda a, b, /, c: (a, b, c)\nprint(tri(1, 2, c=3))\n'), '(1, 2, 3)\n');
  // Une annotation reste valide sur une fonction.
  assert.equal(run('def f(x: int = 1) -> int:\n    return x\nprint(f(9), f())\n'), '9 1\n');
});

test('les comprehensions produisent listes, ensembles et dictionnaires', () => {
  assert.equal(run('print([n for n in [1, 2, 3, 4] if n % 2 == 0])\n'), '[2, 4]\n');
  assert.equal(run('print([n * n for n in range(4)])\n'), '[0, 1, 4, 9]\n');
  // Plusieurs `for` se comportent comme des boucles imbriquees.
  assert.equal(
    run('print([(a, b) for a in [1, 2] for b in "xy" if a != 2])\n'),
    "[(1, 'x'), (1, 'y')]\n",
  );
  // Les filtres s'appliquent dans l'ordre.
  assert.equal(run('print([n for n in range(20) if n % 3 == 0 if n > 6])\n'), '[9, 12, 15, 18]\n');
  // Un ensemble elimine les doublons, un dictionnaire garde les paires.
  assert.equal(run('print({n % 3 for n in range(10)})\n'), '{0, 1, 2}\n');
  assert.equal(run('print({n: n * 2 for n in range(3)})\n'), '{0: 0, 1: 2, 2: 4}\n');
  // La portee de la comprehension est isolee de l'exterieur.
  assert.equal(run('n = 10\nprint([n for n in [1, 2]], n)\n'), '[1, 2] 10\n');
  // Le depaquetage fonctionne comme cible.
  assert.equal(run('paires = [(1, "a"), (2, "b")]\nprint([n for n, t in paires])\n'), '[1, 2]\n');
  assert.throws(
    () => run('print([n for n in range(3) if])\n'),
    (error: unknown) => String(error).includes('UchiSyntaxError'),
  );
});

test('le modulo suit Python, y compris avec les operandes negatifs', () => {
  assert.equal(run('print(7 % 3, 1 % 3, 0 % 3)\n'), '1 1 0\n');
  assert.equal(run('print(-7 % 3, 7 % -3, -7 % -3)\n'), '2 -2 -1\n');
  assert.equal(run('print(7 // 2, -7 // 2, 7 // -2)\n'), '3 -4 -4\n');
});

// ---------------------------------------------------------------- conversions

test('les types integres servent de convertisseur et de classe', () => {
  assert.equal(run('print(list(range(3)), tuple([1, 2]), str(12), int("7"))\n'), '[0, 1, 2] (1, 2) 12 7\n');
  assert.equal(run('print(isinstance([], list), isinstance([], dict), isinstance(1, int))\n'), 'True False True\n');
  assert.equal(run('print(type([1]) == list, type(1) == int, type("a") == str)\n'), 'True True True\n');
  assert.equal(
    failure('int("pas un nombre")\n'),
    "ValueError: int() : la chaine 'pas un nombre' n'est pas un entier valide en base 10",
  );
});

test('`bool` se comporte comme un sous-type d\'`int`', () => {
  // Heritage : `bool` derive d'`int`, `int` ne derive pas de `float`.
  assert.equal(run('print(issubclass(bool, int), issubclass(int, float))\n'), 'True False\n');
  assert.equal(
    run('print(isinstance(True, int), isinstance(1, bool), isinstance(1.5, int))\n'),
    'True False False\n',
  );
  // Tour numerique : tout entier est aussi un `float` pour `isinstance`.
  assert.equal(run('print(isinstance(1, float), isinstance(True, float))\n'), 'True True\n');
  // Arithmetique : un booleen vaut 0 ou 1.
  assert.equal(run('print(True + 1, -True, ~False, True + 1.5)\n'), '2 -1 -1 2.5\n');
  assert.equal(run('print("ab" * True, [0] * True, (1, 2) * False)\n'), "ab [0] ()\n");
  // Egalite et comparaison, comme en Python.
  assert.equal(
    run('print(True == 1, 1 == True, True < 2, [True] == [1], True in [1])\n'),
    'True True True True True\n',
  );
  // Conversions et fonctions natives. Note : Uchi ne distingue pas `int` de
  // `float` en interne (les deux sont des `number` JavaScript), donc
  // `float(False)` s'affiche `0` la ou CPython affiche `0.0`.
  assert.equal(run('print(int(True), sum([True, True]), abs(-True), round(True))\n'), '1 2 1 1\n');
  assert.equal(run('print(max(1, True), min(3, True), list(range(True)))\n'), '1 True [0]\n');
});

// ------------------------------------------------------------------ formatage

test('le formatage respecte les specifications Python', () => {
  assert.equal(run('print(f"{1234567:,}")\n'), '1,234,567\n');
  assert.equal(run('print(f"{1234.5678:.2f}")\n'), '1234.57\n');
  assert.equal(run('print(f"{42:5d}|")\n'), '   42|\n');
  assert.equal(run('print("{0}-{1}".format(1, 2), format(1.5, ".1f"))\n'), '1-2 1.5\n');
  assert.equal(failure('f"{inconnu}"\n'), "NameError: le nom 'inconnu' n'est pas defini");
});

test('les f-strings auto-documentees restituent le `=`', () => {
  // Le defaut est `repr`, les espaces autour du `=` sont conserves.
  assert.equal(run('x = 3\nprint(f"{x=}")\n'), 'x=3\n');
  assert.equal(run('x = 3\nprint(f"{x = }")\n'), 'x = 3\n');
  assert.equal(run('x = 3\nprint(f"{x= }")\n'), 'x= 3\n');
  assert.equal(run('x = 3\nprint(f"{ x = }")\n'), 'x = 3\n');
  assert.equal(run('s = "hi"\nprint(f"{s=}", f"{s=!s}")\n'), "s='hi' s=hi\n");
  // Un gabarit ramene la conversion par defaut a `str` et s'applique ensuite.
  assert.equal(run('x = 3\nprint(f"{x=:.2f}", f"{x=:}")\n'), 'x=3.00 x=3\n');
  assert.equal(run('x = 3\nprint(f"*{x=!r:^20}*")\n'), '*x=         3          *\n');
  // Le texte source est restitue tel quel, conversions et indices compris.
  assert.equal(run('x = 3\nprint(f"{3*x+15=}")\n'), '3*x+15=24\n');
  assert.equal(run('x = 3\nprint(f"X{x =}Y")\n'), 'Xx =3Y\n');
  assert.equal(run('d = {"a": 1}\nprint(f"{d[\'a\']=}")\n'), "d['a']=1\n");
  // Les f-strings imbriquees restent correctes.
  assert.equal(run('print(f\'{f"{3.1415=:.1f}":*^20}\')\n'), '*****3.1415=3.1*****\n');
  // Les comparaisons ne sont pas prises pour un `=` de debogage.
  assert.equal(run('x = 3\nprint(f"{x==3}", f"{x!=3}", f"{x>=3}")\n'), 'True False True\n');
});

// ----------------------------------------------------------------- methodes

test('les crochets de protocole sont lisibles sur les valeurs natives', () => {
  assert.equal(
    run('print([].__class__.__name__, "a".__class__.__name__, (1).__class__.__name__, None.__class__.__name__)\n'),
    'list str int NoneType\n',
  );
  assert.equal(run('print(type(None), NoneType(), isinstance(None, NoneType))\n'), '<classe NoneType> None True\n');
  // Longueur, containment, indexation et conversions.
  assert.equal(run('print([].__len__(), [].__contains__(1), (3).__add__(4))\n'), '0 False 7\n');
  assert.equal(run('print("ab".__add__("c"), [1].__mul__(2), (2).__pow__(10))\n'), 'abc [1, 1] 1024\n');
  assert.equal(run('print((5).__str__(), [1, 2].__repr__(), (-3).__abs__(), (-3).__neg__())\n'), '5 [1, 2] 3 3\n');
  // Iterateur explicite et ecriture par crochet.
  assert.equal(run('print(len(list("abc".__iter__())))\n'), '3\n');
  assert.equal(run('x = [1]\nx.__setitem__(0, 9)\nprint(x)\n'), '[9]\n');
  // Comparaisons.
  assert.equal(run('print((1).__lt__(2), (2).__ge__(2), (1).__eq__(1), (1).__ne__(2))\n'), 'True True True True\n');
  // `__class__` existe sur une instance ; un dunder absent reste une erreur.
  assert.equal(run('class P:\n    pass\nprint(P().__class__.__name__)\n'), 'P\n');
  assert.equal(failure('print([].__abs__())\n'), "TypeError: abs() attend un nombre, recu list");
});
test('les methodes natives recoivent bien leur recepteur', () => {
  assert.equal(run('s = "  Bonjour  "\nprint(s.strip().lower(), len(s))\n'), 'bonjour 11\n');
  assert.equal(run('print("a-b-c".rsplit("-", 1), "ab".partition("b"))\n'), "['a-b', 'c'] ('a', 'b', '')\n");
  assert.equal(run('print([1, 2, 2, 3].count(2), (1, 2, 2).count(2))\n'), '2 2\n');
  assert.equal(run('print("abc".rfind("c"), "x".ljust(3, "."))\n'), '2 x..\n');
});

test('les methodes natives acceptent les arguments nommes', () => {
  assert.equal(run('print("a,b,c".split(sep=","), "a,b,c".split(",", 1))\n'), "['a', 'b', 'c'] ['a', 'b,c']\n");
  assert.equal(run('print("aaa".replace(old="a", new="b"), "ab".zfill(width=4))\n'), 'bbb 00ab\n');
  assert.equal(run('print(" a ".strip(chars=" "), "abc".startswith(prefix="a"))\n'), 'a True\n');
  assert.equal(run('print("a-b-c".rsplit("-", maxsplit=1), "hello".find("l", start=3))\n'), "['a-b', 'c'] 3\n");
  assert.equal(run('print("ab".center(width=6, fillchar="*"), "ab".ljust(fillchar=".", width=4))\n'), '**ab** ab..\n');
  // Un nom inconnu, un doublon et un deplacement de type restent des erreurs.
  assert.match(failure('print("a".split(sepx=","))\n'), /ne accepte pas l'argument nomme 'sepx'/);
  assert.match(failure('print("a,b".split(",", sep=","))\n'), /plusieurs valeurs pour l'argument 'sep'/);
  assert.match(failure('print("a".split(",", maxsplit="x"))\n'), /split attend un entier/);
  assert.match(failure('print("a".split("a", 1, 2))\n'), /attend au plus 2 argument\(s\)/);
});

test('les expressions generatrices produisent une liste', () => {
  assert.equal(run('print(sum(n for n in [1, 2, 3]))\n'), '6\n');
  assert.equal(run('print(max(n * 2 for n in range(4)))\n'), '6\n');
  assert.equal(run('print(sorted(n for n in [3, 1, 2]))\n'), '[1, 2, 3]\n');
  // Entourée de parentheses, elle peut suivre d'autres arguments.
  assert.equal(run('print(sum((n for n in [1, 2]), 10))\n'), '13\n');
  assert.equal(run('print(sum(n for n in range(10) if n % 2 == 0))\n'), '20\n');
  // Deux expressions generatrices dans le meme appel restent valides.
  assert.equal(run('print(sum(n for n in [1, 2]), max(n for n in [3, 4]))\n'), '3 4\n');
  // Une expression generatrice nue ne peut pas avoir de voisin.
  assert.throws(
    () => run('print(sum(n for n in [1, 2], 10))\n'),
    /expression generatrice doit etre l'unique argument/,
  );
});

test('`min` et `max` acceptent des arguments variables', () => {
  assert.equal(run('print(max(1, 2, 3), min(4, 5))\n'), '3 4\n');
  assert.equal(run('print(max(*[1, 5, 2]), max([1, 2, 3]))\n'), '5 3\n');
  assert.equal(run('print(max(1, 5, key=str), max([], default=0))\n'), '5 0\n');
  assert.match(failure('print(max([]))\n'), /max\(\) sur une sequence vide/);
});

test('`__call__` recoit l\'instance comme premier argument', () => {
  const source = [
    'class Multiplicateur:',
    '    def __init__(self, base):',
    '        self.base = base',
    '    def __call__(self, x, y=10):',
    '        return self.base * x * y',
    'm = Multiplicateur(2)',
    'print(m(3), m(3, 4), m(x=1, y=5))',
    '',
  ].join('\n');
  assert.equal(run(source), '60 24 10\n');
  assert.match(failure('m = 3\nprint(m(1))\n'), /'int' n'est pas appelable/);
});
