/**
 * Tests de l'editeur web : serveur, API fichiers et colorateur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

import { startGuiServer, type GuiServer } from '../src/gui/server.ts';
import { collectGrammar } from '../src/gui/grammar.ts';
import { EXTENSION, LANGUAGE_NAME } from '../src/language.ts';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(PROJECT, 'src', 'gui', 'assets');

/** Fichiers d'un dossier et de ses sous-dossiers, dont le nom convient. */
function grepFiles(dir: string, motif: RegExp): string[] {
  const trouves: string[] = [];
  for (const entree of readdirSync(dir, { withFileTypes: true })) {
    const chemin = join(dir, entree.name);
    if (entree.isDirectory()) trouves.push(...grepFiles(chemin, motif));
    else if (motif.test(entree.name)) trouves.push(chemin);
  }
  return trouves;
}

/** Dossier de travail jetable, avec un petit projet Uchi. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uchi-gui-'));
  mkdirSync(join(dir, 'pkg'));
  writeFileSync(join(dir, 'bonjour.uchi'), 'print("bonjour")\n', 'utf8');
  writeFileSync(join(dir, 'pkg', '__init__.uchi'), 'VERSION = 1\n', 'utf8');
  writeFileSync(join(dir, 'notes.txt'), 'ignore\n', 'utf8');
  return dir;
}

/** Demarre un editeur sur un port libre et renvoie un client minimal. */
async function editor(
  dir: string,
  options: { runTimeout?: number } = {},
): Promise<{
  server: GuiServer;
  get: (path: string) => Promise<{ status: number; body: any }>;
  send: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
}> {
  const server = await startGuiServer({ root: dir, port: 0, ...options });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(server.url.replace(/\/$/, '') + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    server,
    get: (path) => call('GET', path),
    send: call,
    stop: () => server.close(),
  };
}

/**
 * Charge le colorateur du navigateur dans Node.
 *
 * Le fichier est un IIFE qui attend `window` : on lui fournit un objet
 * minimal, ce qui permet de tester la coloration sans navigateur.
 */
function loadHighlighter(grammar: ReturnType<typeof collectGrammar>): {
  highlight: (text: string) => string;
} {
  const code = readFileSync(join(ASSETS, 'highlight.js'), 'utf8');
  const fake: { UchiHighlight?: { configure: (g: unknown) => void; highlight: (t: string) => string } } = {};
  // eslint-disable-next-line no-new-func -- le colorateur est un script de page
  new Function('window', code)(fake);
  const api = fake.UchiHighlight;
  assert.ok(api !== undefined, 'le colorateur doit exposer UchiHighlight');
  api.configure(grammar);
  return { highlight: api.highlight };
}

test('l\'editeur sert sa page et ses ressources', async () => {
  const dir = workspace();
  const client = await editor(dir);
  try {
    for (const asset of ['/', '/style.css', '/app.js', '/highlight.js']) {
      const response = await fetch(client.server.url.replace(/\/$/, '') + asset);
      assert.equal(response.status, 200, `${asset} doit etre servi`);
      assert.match(response.headers.get('content-type') ?? '', /text|javascript/);
    }
    // Le logo est ecrit dans la page : l'editeur ne demande aucune image.
    const page = await (await fetch(client.server.url.replace(/\/$/, '') + '/')).text();
    assert.match(page, /<svg class="logo" viewBox="0 0 75 74"/);
    assert.match(page, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
    // Aucune icone tactile : l'editeur est un serveur local, personne ne
    // l'ajoute a un ecran d'accueil iOS, et le PNG coutait 6 Ko de base64.
    assert.ok(!page.includes('apple-touch-icon'), 'l\'icone tactile doit avoir disparu');
    assert.ok(!page.includes('.png'), 'la page ne doit embarquer aucun PNG');
    // Le SVG in-line et le favicon doivent venir du meme logo, trait pour
    // trait, couleur comprise : le fichier de la page peut deriver du source
    // sans qu'aucun test ne le voie autrement.
    const source = readFileSync(join(PROJECT, 'logo_uchi.svg'), 'utf8');
    const couleurs = new Map(
      [...source.matchAll(/\.(cls-\d)\s*\{\s*fill:\s*(#[0-9a-fA-F]{3,6})/g)].map(([, c, f]) => [c, f]),
    );
    const tracés = [...source.matchAll(/<path class="(cls-\d)" d="([^"]+)"/g)]
      .map(([, c, d]) => [couleurs.get(c), d] as const);
    assert.ok(tracés.length > 0, 'le SVG source doit contenir des tracés');
    for (const [fill, d] of tracés) {
      assert.ok(fill !== undefined, 'chaque classe du SVG source doit avoir une couleur');
      assert.ok(page.includes(`<path fill="${fill}" d="${d}"/>`), `le tracé ${d.slice(0, 20)}... manque ou a change de couleur`);
    }
    assert.equal(
      (page.match(/<svg class="logo" viewBox="([^"]+)"/) ?? [])[1],
      (source.match(/viewBox="([^"]+)"/) ?? [])[1],
      'le viewBox de la page doit suivre la source',
    );
    // Les anciennes routes d'image ont disparu : plus rien a servir.
    for (const route of ['/icon.svg', '/apple-touch-icon.png']) {
      const reponse = await fetch(client.server.url.replace(/\/$/, '') + route);
      assert.equal(reponse.status, 404, `${route} ne doit plus exister`);
    }
    // Une ressource inconnue est refusee, comme un chemin hors de `assets`.
    assert.equal((await fetch(client.server.url + 'absent.css')).status, 404);
    assert.equal((await fetch(client.server.url.replace(/\/$/, '') + '/../package.json')).status, 404);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('le langage est declare une seule fois et expose par l\'API', async () => {
  // Un seul litteral dans le code : tout le reste passe par la constante. Les
  // commentaires, eux, peuvent nommer l'extension.
  for (const file of grepFiles(join(PROJECT, 'src'), /\.ts$/)) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const occurrences = code.match(/['"`]\.uchi['"`]/g) ?? [];
    if (file.endsWith(join('language.ts'))) {
      assert.equal(occurrences.length, 1, 'language.ts declare l\'extension');
      continue;
    }
    assert.deepEqual(occurrences, [], `${file} doit utiliser EXTENSION`);
  }

  const dir = workspace();
  const client = await editor(dir);
  try {
    const grammaire = await client.get('/api/grammar');
    assert.deepEqual(grammaire.body.language, { name: LANGUAGE_NAME, extension: EXTENSION });
    // Le serveur refuse un fichier qui ne porte pas l'extension du langage.
    const refuse = await client.send('POST', '/api/file', { path: 'liste.txt' });
    assert.equal(refuse.status, 400);
    assert.match(refuse.body.error, /\.uchi/);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la grammaire est derivee du langage, pas recopiee', () => {
  const grammar = collectGrammar();
  for (const keyword of ['def', 'class', 'while', 'with', 'None', 'True', 'self']) {
    assert.ok(grammar.keywords.includes(keyword), `${keyword} doit etre un mot-cle`);
  }
  for (const type of ['int', 'str', 'list', 'dict', 'NoneType']) {
    assert.ok(grammar.types.includes(type), `${type} doit etre un type`);
  }
  for (const fn of ['print', 'len', 'range', 'sorted', 'isinstance']) {
    assert.ok(grammar.functions.includes(fn), `${fn} doit etre une fonction native`);
  }
  for (const name of ['math', 're', 'json', 'string', 'sys']) {
    assert.ok(grammar.modules.includes(name), `${name} doit etre un module`);
  }
  assert.ok(grammar.exceptions.includes('ValueError'));
  assert.ok(grammar.dunders.includes('__enter__'));
});

test('l\'API liste, lit, ecrit, cree et supprime des fichiers', async () => {
  const dir = workspace();
  const client = await editor(dir);
  try {
    const tree = await client.get('/api/tree');
    assert.equal(tree.status, 200);
    const paths = tree.body.files.map((entry: { path: string }) => entry.path);
    // Seuls les `.uchi` et les dossiers apparaissent, jamais les autres files.
    assert.deepEqual(paths, ['bonjour.uchi', 'pkg', 'pkg/__init__.uchi']);

    const file = await client.get('/api/file?path=bonjour.uchi');
    assert.equal(file.body.text, 'print("bonjour")\n');

    const written = await client.send('PUT', '/api/file?path=bonjour.uchi', { text: 'print("salut")\n' });
    assert.equal(written.status, 200);
    assert.equal((await client.get('/api/file?path=bonjour.uchi')).body.text, 'print("salut")\n');

    // Un corps sans texte est refuse, et rien n'est ecrit.
    assert.equal((await client.send('PUT', '/api/file?path=bonjour.uchi', {})).status, 400);

    const created = await client.send('POST', '/api/file', { path: 'pkg/nouveau.uchi' });
    assert.equal(created.status, 201);
    assert.equal((await client.get('/api/file?path=pkg/nouveau.uchi')).body.text, '');
    // Un nom deja pris, ou d'une autre extension, est refuse.
    assert.equal((await client.send('POST', '/api/file', { path: 'pkg/nouveau.uchi' })).status, 409);
    assert.equal((await client.send('POST', '/api/file', { path: 'liste.txt' })).status, 400);

    assert.equal((await client.send('DELETE', '/api/file?path=pkg/nouveau.uchi')).status, 200);
    assert.equal((await client.get('/api/file?path=pkg/nouveau.uchi')).status, 404);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('l\'API refuse toute evasion du dossier de travail', async () => {
  const dir = workspace();
  const client = await editor(dir);
  try {
    for (const chemin of ['../secret.uchi', 'pkg/../../secret.uchi', '/etc/passwd', '']) {
      const lecture = await client.get('/api/file?path=' + encodeURIComponent(chemin));
      assert.equal(lecture.status, 400, `lecture de '${chemin}' doit etre refusee`);
      const ecriture = await client.send('PUT', '/api/file?path=' + encodeURIComponent(chemin), { text: 'x' });
      assert.equal(ecriture.status, 400, `ecriture dans '${chemin}' doit etre refusee`);
    }
    // Le repertoire racine lui-meme n'est pas un fichier editable.
    assert.equal((await client.get('/api/file?path=.')).status, 400);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('l\'analyse porte sur le tampon, pas sur le fichier', async () => {
  const dir = workspace();
  const client = await editor(dir);
  try {
    const bon = await client.send('POST', '/api/check', { path: 'bonjour.uchi', text: 'print("ok")\n' });
    assert.equal(bon.body.ok, true);
    assert.equal(bon.body.error, null);

    // Le texte envoye n'est pas enregistre : le fichier reste intact.
    const mauvais = await client.send('POST', '/api/check', { path: 'bonjour.uchi', text: 'def f(:\n' });
    assert.equal(mauvais.body.ok, false);
    assert.equal(mauvais.body.error.line, 1);
    assert.equal((await client.get('/api/file?path=bonjour.uchi')).body.text, 'print("bonjour")\n');

    // Sans texte, l'analyse porte sur le fichier du disque.
    const surDisque = await client.get('/api/check?path=bonjour.uchi');
    assert.equal(surDisque.body.ok, true);
    assert.equal((await client.get('/api/check?path=absent.uchi')).body.ok, false);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('l\'execution renvoie la sortie du tampon', async () => {
  const dir = workspace();
  const client = await editor(dir);
  try {
    const resultat = await client.send('POST', '/api/run', {
      path: 'bonjour.uchi',
      text: 'import math\nprint("coucou")\nprint(math.floor(2.7))\n',
    });
    assert.equal(resultat.body.ok, true);
    assert.equal(resultat.body.stdout, 'coucou\n2\n');
    assert.deepEqual(resultat.body.trace, []);
    assert.equal(resultat.body.error, null);
    assert.equal(typeof resultat.body.durationMs, 'number');

    // Le fichier du disque n'a pas ete modifie par l'execution.
    assert.equal((await client.get('/api/file?path=bonjour.uchi')).body.text, 'print("bonjour")\n');
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('une erreur d\'execution est tracee avec sa ligne', async () => {
  const dir = workspace();
  const client = await editor(dir);
  try {
    const resultat = await client.send('POST', '/api/run', {
      path: 'bonjour.uchi',
      text: 'def divise(a, b):\n    return a / b\n\n\nprint("avant")\ndivise(1, 0)\nprint("apres")\n',
    });
    assert.equal(resultat.body.ok, false);
    // La sortie ecrite avant l'echec est conservee.
    assert.equal(resultat.body.stdout, 'avant\n');
    assert.equal(resultat.body.error.name, 'ZeroDivisionError');
    assert.equal(resultat.body.error.line, 2);
    // La trace va de l'appel externe a l'appel fautif.
    assert.deepEqual(resultat.body.trace, ['ligne 6, dans <module>', 'ligne 2, dans divise']);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('une erreur de syntaxe empeche l\'execution', async () => {
  const dir = workspace();
  const client = await editor(dir);
  try {
    const resultat = await client.send('POST', '/api/run', { path: 'bonjour.uchi', text: 'def f(:\n' });
    assert.equal(resultat.body.ok, false);
    assert.equal(resultat.body.error.name, 'SyntaxError');
    assert.equal(resultat.body.error.line, 1);
    assert.equal(resultat.body.stdout, '');
    assert.deepEqual(resultat.body.trace, []);

    // Un chemin hors du dossier de travail est refuse comme pour l'analyse.
    const echappement = await client.send('POST', '/api/run', { path: '../secret.uchi', text: '' });
    assert.equal(echappement.status, 400);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('une boucle infinie est interrompue sans figer l\'editeur', async () => {
  const dir = workspace();
  const client = await editor(dir, { runTimeout: 300 });
  try {
    const resultat = await client.send('POST', '/api/run', { path: 'bonjour.uchi', text: 'while True:\n    pass\n' });
    assert.equal(resultat.body.ok, false);
    assert.equal(resultat.body.error.name, 'TimeoutError');
    assert.match(resultat.body.error.message, /delai depasse/);

    // Le serveur a survécu : le fichier est toujours lisible et enregistrable.
    assert.equal((await client.get('/api/file?path=bonjour.uchi')).body.text, 'print("bonjour")\n');
    const ecrit = await client.send('PUT', '/api/file?path=bonjour.uchi', { text: 'print("toujours la")\n' });
    assert.equal(ecrit.status, 200);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la sortie d\'un programme bavard est bornee', async () => {
  const dir = workspace();
  const client = await editor(dir);
  try {
    // Deux megaoctets demandes, un megaoctet conserve.
    const bavard = 'for i in range(2000):\n    print("a" * 1000)\n';
    const resultat = await client.send('POST', '/api/run', { path: 'bonjour.uchi', text: bavard });
    assert.equal(resultat.body.ok, true);
    const sortie = resultat.body.stdout as string;
    assert.ok(sortie.length < 2_000_000, `sortie de ${sortie.length} caracteres : elle doit etre bornee`);
    assert.match(sortie, /\[sortie tronquee/);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('le colorateur reconnait les jetons du langage', () => {
  const { highlight } = loadHighlighter(collectGrammar());
  const code = [
    '# un commentaire',
    'import re',
    'class Point:',
    '    def __len__(self):',
    '        return print(42, 0x1f, "texte", ValueError, True)',
    'taille = donnees.__len__()',
  ].join('\n');
  const html = highlight(code);
  assert.match(html, /class="t-commentaire"># un commentaire/);
  assert.match(html, /class="t-module">re/);
  assert.match(html, /class="t-mot">class/);
  assert.match(html, /class="t-definition">Point/);
  // Un nom defini par `def` reste une definition, meme s'il est un dunder.
  assert.match(html, /class="t-definition">__len__/);
  // Utilise comme attribut, le dunder retrouve sa couleur.
  assert.match(html, /class="t-dunder">__len__/);
  assert.match(html, /class="t-nombre">42/);
  assert.match(html, /class="t-nombre">0x1f/);
  assert.match(html, /class="t-chaine">&quot;texte&quot;|<span class="t-chaine">"texte"/);
  assert.match(html, /class="t-exception">ValueError/);
  assert.match(html, /class="t-litteral">True/);
  // Le HTML produit ne doit jamais contenir de balise non fermee.
  assert.equal((html.match(/<span/g) ?? []).length, (html.match(/<\/span>/g) ?? []).length);
});

test('le colorateur suit les chaines brutes, f-strings et commentaires', () => {
  const { highlight } = loadHighlighter(collectGrammar());
  // Le prefixe d'une chaine brute reste hors du jeton, son contenu non.
  const brut = highlight('motif = r"\\d+"');
  assert.match(brut, /r<span class="t-chaine">"\\d\+"/);
  const fchaine = highlight('x = f"{nom!r:>10} et {taille=}"');
  assert.match(fchaine, /class="t-fchaine">"/);
  // L'expression `{nom!r:>10}` est colorée comme du code, le reste comme un texte.
  assert.match(fchaine, /class="t-fchaine">\{<\/span>nom!r/);
  assert.match(fchaine, /class="t-nombre">10/);
  assert.match(fchaine, /class="t-fchaine"> et <\/span>/);
  // `{taille=}` met l'expression en valeur, comme une f-string auto-documentee.
  assert.match(fchaine, /taille<span class="t-operateur">=<\/span><span class="t-fchaine">}/);
  // Un triple guillemet ouvert se poursuit sur les lignes suivantes, puis le
  // code reprend des que la chaine est fermee.
  const doc = highlight('"""\nligne un\nligne deux\n"""\nprint(1)');
  const docLignes = doc.split('\n');
  assert.match(docLignes[0] as string, /class="t-chaine">"""/);
  assert.match(docLignes[1] as string, /class="t-chaine">ligne un/);
  assert.match(docLignes[3] as string, /class="t-chaine">"""/);
  assert.match(docLignes[4] as string, /class="t-fonction">print/);
  // Un dièse coupe toujours la ligne, meme dans une chaine de documentation.
  assert.match(highlight('x = 1  # fin'), /class="t-commentaire"># fin/);
  // Une ligne vide garde une espace : la hauteur de la surcouche suit la saisie.
  assert.equal(highlight('a\n\nb').split('\n')[1], ' ');
});

// ============================================================ editeur (DOM)

/**
 * Element de page minimal.
 *
 * Seules les proprietes utilisees par `app.js` sont implementees, avec les
 * quelques coercitions du DOM qui comptent : poser `innerHTML` vide les
 * enfants, `classList` passe par `className`.
 */
class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList: { add(c: string): void; remove(c: string): void; toggle(c: string): void; contains(c: string): boolean };
  value = '';
  textContent = '';
  className = '';
  title = '';
  hidden = false;
  focused = false;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  selectionStart = 0;
  selectionEnd = 0;
  private html = '';
  private listeners: Record<string, ((event: unknown) => void)[]> = {};

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    const element = this;
    this.classList = {
      add: (c) => { element.className = (element.className + ' ' + c).trim(); },
      remove: (c) => { element.className = element.className.split(' ').filter((x) => x !== c).join(' '); },
      toggle: (c) => { if (element.classList.contains(c)) element.classList.remove(c); else element.classList.add(c); },
      contains: (c) => element.className.split(' ').includes(c),
    };
  }

  /** Poser `innerHTML` remplace le contenu : les enfants disparaissent. */
  get innerHTML(): string { return this.html; }
  set innerHTML(valeur: string) {
    this.html = valeur;
    if (valeur === '') this.children.length = 0;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }

  setRangeText(texte: string, debut: number, fin: number): void {
    this.value = this.value.slice(0, debut) + texte + this.value.slice(fin);
    this.selectionStart = this.selectionEnd = debut + texte.length;
  }

  setSelectionRange(debut: number, fin: number): void {
    this.selectionStart = debut;
    this.selectionEnd = fin;
  }

  focus(): void { this.focused = true; }

  /** Declenche les écouteurs `click` enregistres. */
  click(): void { for (const fn of this.listeners.click ?? []) fn({ preventDefault: () => {} }); }

  /** Renvoie la classe de chaque numero de ligne de la gouttiere. */
  get lignesGouttiere(): string[] {
    return [...this.innerHTML.matchAll(/<div class="([^"]*)">/g)].map((m) => m[1] as string);
  }
}

/** Page factice construite a partir des identifiants de la vraie page. */
function fakePage(): { elements: Map<string, FakeElement>; document: Record<string, unknown> } {
  const html = readFileSync(join(ASSETS, 'index.html'), 'utf8');
  const elements = new Map<string, FakeElement>();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id as string, new FakeElement('div'));
  const store = new Map<string, string>();
  const documentListeners: Record<string, ((event: unknown) => void)[]> = {};
  const document = {
    title: '',
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (documentListeners[type] ??= []).push(fn);
    },
    localStorage: {
      getItem: (cle: string) => (store.has(cle) ? (store.get(cle) as string) : null),
      setItem: (cle: string, valeur: string) => { store.set(cle, valeur); },
      removeItem: (cle: string) => { store.delete(cle); },
    },
  };
  return { elements, document };
}

const attendre = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('l\'editeur s\'ouvre, colorise et affiche le resultat d\'une execution', async () => {
  const { elements, document } = fakePage();
  const global = globalThis as Record<string, unknown>;
  const sauvegarde = { ...global };
  const api = {
    'GET /api/grammar': {
      root: 'C:/demo',
      language: { name: LANGUAGE_NAME, extension: EXTENSION },
      grammar: collectGrammar(),
    },
    'GET /api/tree': {
      root: 'C:/demo',
      files: [{ name: 'essai.uchi', path: 'essai.uchi', directory: false, size: 24 }],
    },
    'GET /api/file': { path: 'essai.uchi', text: 'def f():\n    return 1 / 0\n' },
    'POST /api/file': { path: 'x.uchi' },
    'POST /api/check': { ok: true, error: null },
    'POST /api/run': {
      ok: false,
      stdout: 'debut\n',
      trace: ['ligne 1, dans <module>', 'ligne 2, dans f'],
      error: { name: 'ZeroDivisionError', message: 'division par zero', line: 2 },
      durationMs: 3,
    },
  };
  const appels: string[] = [];
  const defauts: string[] = [];

  try {
    // Les scripts de la page s'executent dans la portee globale du navigateur.
    global.window = {
      document,
      addEventListener: () => {},
      confirm: () => true,
      prompt: (_message: string, defaut: string) => {
        defauts.push(defaut);
        return 'x.uchi';
      },
    };
    global.document = document;
    global.localStorage = document.localStorage;
    // eslint-disable-next-line no-new-func -- scripts de page, comme le colorateur
    new Function(readFileSync(join(ASSETS, 'highlight.js'), 'utf8'))();
    global.UchiHighlight = (global.window as { UchiHighlight: unknown }).UchiHighlight;
    global.fetch = (url: string, options: { method?: string; body?: string } = {}) => {
      const cle = (options.method ?? 'GET') + ' ' + String(url).split('?')[0];
      appels.push(cle);
      const data = (api as Record<string, unknown>)[cle] ?? { error: 'route inconnue' };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    // eslint-disable-next-line no-new-func -- script de page
    new Function(readFileSync(join(ASSETS, 'app.js'), 'utf8'))();
    await attendre();

    // Demarrage : grammaire, arborescence, puis ouverture du premier fichier.
    assert.deepEqual(appels, ['GET /api/grammar', 'GET /api/tree', 'GET /api/file']);
    // Le nom affiche vient de l'API, comme le nom de fichier propose ensuite.
    assert.equal(elements.get('langue')?.textContent, LANGUAGE_NAME);
    const saisie = elements.get('saisie') as FakeElement;
    assert.equal(saisie.value, 'def f():\n    return 1 / 0\n');
    assert.equal(elements.get('titre')?.textContent, 'essai.uchi');
    // La surcouche est coloree, la gouttiere compte les lignes du fichier.
    assert.match(elements.get('surcouche')?.innerHTML ?? '', /class="t-definition">f/);
    assert.equal((elements.get('gouttiere') as FakeElement).lignesGouttiere.length, 3);

    // Execution : la sortie s'affiche, la trace se lit, la ligne fautive est
    // marquee dans la gouttiere.
    (elements.get('executer') as FakeElement).click();
    await attendre();
    assert.ok(appels.includes('POST /api/run'));
    assert.equal(elements.get('sortie')?.textContent, 'debut\n');
    assert.equal(elements.get('erreur-titre')?.textContent, 'ZeroDivisionError : division par zero');
    assert.equal(elements.get('resume')?.textContent, 'échec après 3 ms');
    const cadres = (elements.get('cadres') as FakeElement).children;
    assert.deepEqual(cadres.map((c) => c.textContent), ['ligne 1, dans <module>', 'ligne 2, dans f']);
    // Le dernier cadre designe l'appel fautif.
    assert.match(cadres[1]?.className ?? '', /fautif/);
    assert.deepEqual((elements.get('gouttiere') as FakeElement).lignesGouttiere, ['', 'ligne-erreur', '']);
    assert.equal(elements.get('executer')?.textContent, 'Exécuter');

    // Cliquer un cadre place le curseur sur la ligne designee.
    cadres[1]?.click();
    assert.equal(saisie.value.slice(saisie.selectionStart, saisie.selectionEnd), '    return 1 / 0');

    // Replier puis effacer remet la console a zero.
    (elements.get('replier') as FakeElement).click();
    assert.match(elements.get('console')?.className ?? '', /replie/);
    (elements.get('effacer') as FakeElement).click();
    assert.equal(elements.get('sortie')?.textContent, '');
    assert.equal((elements.get('cadres') as FakeElement).children.length, 0);
    assert.equal((elements.get('erreur') as FakeElement).hidden, true);
    assert.deepEqual((elements.get('gouttiere') as FakeElement).lignesGouttiere, ['', '', '']);

    // Le nom propose pour un nouveau fichier porte l'extension du langage.
    (elements.get('nouveau') as FakeElement).click();
    await attendre();
    assert.deepEqual(defauts, ['nouveau' + EXTENSION]);
  } finally {
    for (const cle of ['window', 'document', 'localStorage', 'UchiHighlight', 'fetch']) {
      if (sauvegarde[cle] === undefined) delete global[cle];
      else global[cle] = sauvegarde[cle];
    }
  }
});

test('chaque identifiant demande par app.js existe dans la page', () => {
  const html = readFileSync(join(ASSETS, 'index.html'), 'utf8');
  const script = readFileSync(join(ASSETS, 'app.js'), 'utf8');
  const presents = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const demandes = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1] as string);
  assert.ok(demandes.length > 10, 'app.js doit demander plusieurs elements');
  for (const id of demandes) assert.ok(presents.has(id), `l'identifiant '${id}' manque dans index.html`);
});

/**
 * Requete avec controle direct des en-tetes.
 *
 * `fetch` forbid le nom d'hote, or c'est justement ce qu'un navigateur
 * verifie : la seule facon de reproduire une requete hostile est de passer par
 * le module `http`.
 */
function brut(
  server: GuiServer,
  methode: string,
  chemin: string,
  entetes: Record<string, string> = {},
  corps?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const requete = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path: chemin,
        method: methode,
        headers: { 'content-type': 'application/json', ...entetes },
      },
      (reponse) => {
        let data = '';
        reponse.setEncoding('utf8');
        reponse.on('data', (fragment) => { data += fragment; });
        reponse.on('end', () => resolve({ status: reponse.statusCode ?? 0, body: data }));
      },
    );
    requete.on('error', reject);
    requete.end(corps === undefined ? undefined : JSON.stringify(corps));
  });
}

test('le serveur refuse les requetes qui ne viennent pas de l\'editeur', async () => {
  const dir = workspace();
  const { server, stop } = await editor(dir);
  try {
    const corps = { path: 'bonjour.uchi' };

    // Un nom d'hote etranger signe d'un rebinding DNS : la page joignable
    // sous un nom resolu vers la boucle locale ne doit rien obtenir.
    const etranger = await brut(server, 'POST', '/api/run', { host: 'attaquant.example' }, corps);
    assert.equal(etranger.status, 403);
    assert.match(etranger.body, /hote non autorise/);
    assert.equal((await brut(server, 'GET', '/api/tree', { host: 'attaquant.example' })).status, 403);

    // Une origine tierce qui tente d'ecrire : c'est la requete forgee d'un
    // formulaire, d'une image ou d'un script tiers.
    const origine = await brut(
      server,
      'POST',
      '/api/run',
      { origin: 'http://attaquant.example' },
      corps,
    );
    assert.equal(origine.status, 403);
    assert.match(origine.body, /origine non autorisee/);

    // Le navigateur annonce lui-meme le site source : ce refus ne peut pas etre
    // contourne en forgeant une requete.
    const intersites = await brut(
      server,
      'POST',
      '/api/run',
      { 'sec-fetch-site': 'cross-site' },
      corps,
    );
    assert.equal(intersites.status, 403);
    assert.match(intersites.body, /inter-sites refusee/);

    // Un formulaire ne peut pas produire un POST en JSON : le type impose
    // declenche une verification prealable que le serveur ne valide jamais.
    const formulaire = await brut(
      server,
      'POST',
      '/api/run',
      { 'content-type': 'text/plain' },
      corps,
    );
    assert.equal(formulaire.status, 415);
    assert.match(formulaire.body, /content-type: application\/json/);
  } finally {
    await stop();
  }
});

test('l\'editeur continue de fonctionner pour lui-meme', async () => {
  const dir = workspace();
  const { server, send, stop } = await editor(dir);
  try {
    const port = server.port;
    // Meme origine, y compris par le nom `localhost` : le navigateur compare
    // l'origine lettre a lettre, l'editeur doit donc accepter les deux formes.
    for (const hote of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const reponse = await brut(
        server,
        'POST',
        '/api/run',
        { host: hote, origin: `http://${hote}` },
        { path: 'bonjour.uchi' },
      );
      assert.equal(reponse.status, 200, `hote '${hote}' refuse a tort`);
      const resultat = JSON.parse(reponse.body);
      assert.equal(resultat.ok, true);
      assert.equal(resultat.stdout, 'bonjour\n');
    }
    // Ouvrir l'editeur par un lien reste possible : une lecture ne change
    // rien, et le navigateur n'en transmet pas la reponse a la page source.
    const page = await brut(server, 'GET', '/', { origin: 'http://attaquant.example' });
    assert.equal(page.status, 200);
    assert.match(page.body, /<!DOCTYPE html>/);
    assert.equal((await send('GET', '/api/tree')).status, 200);
  } finally {
    await stop();
  }
});

test('le programme execute par l\'editeur est confine a son dossier', async () => {
  const dir = workspace();
  const dehors = mkdtempSync(join(tmpdir(), 'uchi-dehors-'));
  writeFileSync(join(dehors, 'secret.txt'), 'donnees sensibles', 'utf8');
  const { server, send, stop } = await editor(dir);
  try {
    const executer = async (source: string): Promise<any> => {
      const reponse = await send('POST', '/api/run', { path: 'bonjour.uchi', text: source });
      assert.equal(reponse.status, 200);
      return reponse.body;
    };

    // Un fichier du dossier de travail reste lisible.
    const interne = await executer('print(open("notes.txt").read().strip())\n');
    assert.equal(interne.ok, true);
    assert.equal(interne.stdout, 'ignore\n');

    for (const chemin of [join(dehors, 'secret.txt').replaceAll('\\', '/'), '../../../Windows/win.ini']) {
      const echec = await executer(
        `try:\n    f = open("${chemin}")\nexcept PermissionError:\n    print("refuse")\n`,
      );
      assert.equal(echec.stdout, 'refuse\n', `le chemin '${chemin}' aurait du etre refuse`);
    }
  } finally {
    await stop();
  }
});
