import { tokenize } from '../src/lexer/lexer.ts';
import { parse } from '../src/parser/parser.ts';

const sources = [
  'x = 1\n',
  'x = 1',
  '# commentaire seul\n\nx = 2  # fin\n',
  'def f(a, b=2, *args, **kw):\n    return a + b\n',
  'if x > 1:\n    y = 2\nelif x == 1:\n    y = 3\nelse:\n    y = 4\n',
  'for i in range(10):\n    if i % 2 == 0:\n        continue\n    print(i)\n',
  'a, b = 1, 2\n',
  'a, *rest = [1, 2, 3]\n',
  'print(f"Bonjour {nom.upper()} : {age:d} ans")\n',
  's = f"{f\'{x}\'} et {{literal}}"\n',
  'z = 2 ** 3 ** 2\nq = -2 ** 2\n',
  'w = 1 if a else 2\n',
  'c = 0 < x <= 10 and x not in [1, 2]\n',
  'class A(B):\n    def __init__(self):\n        super().__init__()\n',
  'try:\n    risky()\nexcept ValueError as e:\n    print(e)\nfinally:\n    cleanup()\n',
  'import os.path as p\nfrom a.b import c, d as e\n',
  'xs = [1, 2, 3]\nys = xs[1:]\nzs = xs[::2]\nws = xs[0:6:2]\n',
  'f(*args, **kwargs, nom=1)\n',
  'd = {"a": 1, "b": 2}\ns = {1, 2}\nt = ()\nu = (1,)\n',
  'lam = lambda x, y=2: x + y\n',
  'm = a if b else c if d else e\n',
  'x: int = 5\ny: str\nz: list[int] = []\nw: int | None = None\n',
  'counter = 0\n\n\ndef bump():\n    global counter\n    counter += 1\n',
  'if x: y = 1\n',
  'a += 1\na //= 2\na **= 3\n',
  'v = 0xFF + 0b1010 + 0o17 + 1_000_000 + 1.5e-3\n',
  'del a, b\nassert x, "message"\n',
  'x = """\nligne 1\nligne 2\n"""\n',
  'print("a" "b" "c")\n',
  'while True:\n    if done:\n        break\nelse_marker = 1\n',
];

let failures = 0;
for (const source of sources) {
  try {
    parse(source, 'test.uchi');
  } catch (error) {
    failures++;
    console.log('ECHEC :', JSON.stringify(source));
    console.log('  ', (error as Error).message.split('\n')[0]);
  }
}
console.log(failures === 0 ? `OK : ${sources.length} sources analysees` : `${failures} echecs`);
