/**
 * Serveur de l'editeur web Uchi.
 *
 * Il expose une page unique (editeur multi-fichiers avec coloration
 * syntaxique) et une petite API JSON limitee au dossier de travail. Aucune
 * dependance : uniquement `node:http` et `node:fs`.
 *
 * `POST /api/run` execute le code de l'editeur dans un fil dedie, avec les
 * privileges du processus, comme `uchi run`. Le serveur ecoute donc sur la
 * boucle locale : c'est un outil de developpement, pas un service a exposer.
 *
 * Cette confiance a un prix : toute page web pourrait demander l'execution de
 * code sur cette machine. Le serveur s'en defends (voir `verifieOrigine`) :
 * il ne repond qu'a une requete dont l'origine est la sienne, et le programme
 * execute ne peut pas lire le disque hors du dossier de travail.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UchiSyntaxError } from '../errors.ts';
import { runIsolated } from '../execution/isolated.ts';
import type { RunRequest, RunResult } from '../execution/protocol.ts';
import { EXTENSION, LANGUAGE } from '../language.ts';
import { parse } from '../parser/parser.ts';
import { collectGrammar, type Grammar } from './grammar.ts';
import {
  createRequestGuard,
  injectToken,
  securityHeaders,
  TOKEN_HEADER,
  type RequestGuard,
} from '../request-guard.ts';

const ASSET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'assets');

/** Types MIME des ressources servies. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface GuiOptions {
  /** Dossier de travail : aucune ecriture n'en sort. */
  root: string;
  /** Port d'ecoute ; `0` demande un port libre. */
  port?: number;
  /** Interface d'ecoute, boucle locale par defaut. */
  host?: string;
  /** Duree maximale d'une execution, en millisecondes. */
  runTimeout?: number;
}

export interface GuiServer {
  readonly url: string;
  readonly port: number;
  readonly root: string;
  close(): Promise<void>;
}

/** Un fichier de l'arborescence, relatif au dossier de travail. */
interface FileEntry {
  path: string;
  name: string;
  directory: boolean;
  size: number;
  modified: number;
}

const MAX_BODY = 8 * 1024 * 1024;
/** Profondeur maximale de l'arborescence, pour ne pas parcourir des arbres profonds. */
const MAX_DEPTH = 8;
/** Duree maximale d'une execution avant interruption du programme. */
const DEFAULT_RUN_TIMEOUT = 10_000;

/** Ce que le serveur sait de son dossier de travail pendant une requete. */
interface Contexte {
  root: string;
  grammar: Grammar;
  /** Duree maximale d'une execution, en millisecondes. */
  runTimeout: number;
  /**
   * En-tetes `Host` acceptes. `null` lorsque l'interface a ete exposee
   * explicitement : le developpeur a alors demande d'etre joignable, et la
   * verification n'aurait plus de sens.
   */
  hotes: ReadonlySet<string> | null;
}

/** Reponse de refus a une requete dont l'origine n'est pas la sienne. */
interface Refus {
  status: number;
  message: string;
}

/**
 * Noms et adresses que la boucle locale porte.
 *
 * `localhost` et `127.0.0.1` designent la meme machine mais pas la meme
 * chaine : un navigateur compare l'origine lettre a lettre, et cette
 * verification doit donc accepter les deux formes.
 */
const BOUCLES_LOCALES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]', '::1'];

function estBoucleLocale(host: string): boolean {
  return BOUCLES_LOCALES.includes(host) || host.startsWith('127.');
}

/** En-tetes `Host` acceptes pour l'interface d'ecoute donnee. */
function hotesAutorises(host: string, port: number): Set<string> | null {
  if (!estBoucleLocale(host)) return null;
  return new Set(BOUCLES_LOCALES.map((nom) => `${nom}:${port}`));
}

/** Methodes qui changent l'etat du serveur : seuleselles subissent aux refuses d'origine. */
const METHODES_ECRIVANTES: readonly string[] = ['POST', 'PUT', 'DELETE', 'PATCH'];

/**
 * Verifie qu'une requete vient bien de l'editeur.
 *
 * L'editeur execute du code avec les privileges du processus : une page tierce
 * ne doit pas pouvoir y demander une execution. Les verifications se cumulent,
 * chacune couvrant une parade des navigateurs.
 *
 * 1. `Host` doit designer la boucle locale, pour toute requete. Cela bloque le
 *    *rebinding* DNS, ou un nom resolu vers `127.0.0.1` ferait passer la
 *    requete pour legitime.
 * 2. `Sec-Fetch-Site: cross-site` est un refus net : le navigateur ne permet
 *    pas de le maquiller depuis une page.
 * 3. `Origin`, quand le navigateur l'envoie, doit designer le meme hote que
 *    `Host`. C'est la regle meme-origine, et elle vaut aussi pour les requetes
 *    que le navigateur considere comme simples.
 *
 * Ces trois-la ne concernent que les ecritures : une lecture ne peut rien
 * changer, et le navigateur n'en transmet pas la reponse a la page tierce
 * sans en-tete autorise. Refuser une lecture inter-sites n'ajouterait rien et
 * empecherait d'ouvrir l'editeur depuis un lien.
 *
 * Un `POST` doit en outre porter `application/json` : un tel type declenche une
 * verification prealable (*preflight*) des que la page est distante, et le
 * serveur n'en envoie aucune, donc la requete n'aboutit jamais. Un formulaire
 * ou une image ne peuvent pas produire un `POST` en JSON.
 */
function verifieOrigine(request: IncomingMessage, contexte: Contexte, method: string): Refus | null {
  const hote = request.headers.host ?? '';
  if (contexte.hotes !== null && !contexte.hotes.has(hote)) {
    return { status: 403, message: 'hote non autorise' };
  }
  if (!METHODES_ECRIVANTES.includes(method)) return null;
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    return { status: 403, message: 'requete inter-sites refusee' };
  }
  const origine = request.headers.origin;
  if (typeof origine === 'string' && origine !== 'null' && origine !== '') {
    let depuis: URL;
    try {
      depuis = new URL(origine);
    } catch {
      return { status: 403, message: 'origine invalide' };
    }
    // L'origine doit designer le meme couple hote/port que la requete, et un
    // simple http : une origine `null` — un fichier local — ne l'est pas.
    if (depuis.host !== hote || (depuis.protocol !== 'http:' && depuis.protocol !== 'https:')) {
      return { status: 403, message: 'origine non autorisee' };
    }
  }
  if (method === 'POST' || method === 'PUT') {
    const type = request.headers['content-type'] ?? '';
    if (!/^application\/json\b/i.test(type)) {
      return { status: 415, message: 'corps de requete JSON attendu (content-type: application/json)' };
    }
  }
  return null;
}

/** Demarre l'editeur web et renvoie son URL. */
export function startGuiServer(options: GuiOptions): Promise<GuiServer> {
  const root = resolve(options.root);
  const host = options.host ?? '127.0.0.1';
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return Promise.reject(new Error(`dossier de travail introuvable : '${root}'`));
  }
  const contexte: Contexte = {
    root,
    grammar: collectGrammar(),
    runTimeout: options.runTimeout ?? DEFAULT_RUN_TIMEOUT,
    maxRuns: Math.max(1, options.maxConcurrentRuns ?? DEFAULT_MAX_RUNS),
    activeRuns: 0,
    // Renseigne a l'ecoute, quand le port est connu.
    hotes: null,
  };

  const server = createServer((request, response) => {
    handle(request, response, contexte).catch((error: unknown) => {
      sendJson(response, 500, { error: message(error) });
    });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.on('error', rejectPromise);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      // Le port etant connu, les en-tetes `Host` acceptes le deviennent aussi.
      (contexte as { hotes: ReadonlySet<string> | null }).hotes = hotesAutorises(host, port);
      resolvePromise({
        url: `http://${host}:${port}/`,
        port,
        root,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
}

/** Aiguille une requete vers l'API ou vers un fichier statique. */
async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  contexte: Contexte,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  const route = url.pathname;

  // Avant tout routage : une requete qui ne vient pas de l'editeur n'a rien a
  // faire ici. L'en-tete `Host` est verifie pour toute requete, y compris de
  // lecture : c'est lui qui distingue un vrai navigateur d'un nom resolu vers
  // la boucle locale.
  const refus = verifieOrigine(request, contexte, method);
  if (refus !== null) {
    sendJson(response, refus.status, { error: refus.message });
    return;
  }

  // Seules les methodes de lecture et d'ecriture des fichiers sont acceptees.
  if (route.startsWith('/api/')) {
    try {
      await handleApi(request, response, contexte, route, method, url);
    } catch (error) {
      // Un chemin hors du dossier de travail est une erreur de la requete.
      const bad = message(error).startsWith('chemin hors');
      sendJson(response, bad ? 400 : 500, { error: message(error) });
    }
    return;
  }
  // L'API n'accepte que les methodes prevues.
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { error: 'methode non autorisee' });
    return;
  }
  const name = route === '/' ? '/index.html' : route;
  const file = join(ASSET_DIR, name);
  if (!file.startsWith(ASSET_DIR + sep)) {
    send(response, 403, 'text/plain; charset=utf-8', 'acces refuse');
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    send(response, 404, 'text/plain; charset=utf-8', 'introuvable');
    return;
  }
  send(response, 200, CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file));
}

/** Repond a l'API JSON de l'editeur. */
async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  contexte: Contexte,
  route: string,
  method: string,
  url: URL,
): Promise<void> {
  const { root, grammar, runTimeout } = contexte;
  switch (`${method} ${route}`) {
    case 'GET /api/grammar':
      // `language` permet a la page de nommer les nouveaux fichiers sans
      // recopier l'extension du langage.
      sendJson(response, 200, { root, language: LANGUAGE, grammar });
      return;
    case 'GET /api/tree':
      sendJson(response, 200, { root, files: listTree(root) });
      return;
    case 'GET /api/file': {
      const path = requirePath(url, root);
      if (!existsSync(path) || !statSync(path).isFile()) {
        sendJson(response, 404, { error: 'fichier introuvable' });
        return;
      }
      sendJson(response, 200, { path: relative(root, path), text: readFileSync(path, 'utf8') });
      return;
    }
    case 'PUT /api/file': {
      const path = requirePath(url, root);
      const body = await readBody(request);
      const text = body.text;
      if (typeof text !== 'string') {
        sendJson(response, 400, { error: 'champ "text" manquant' });
        return;
      }
      writeFileSync(path, text, 'utf8');
      sendJson(response, 200, { path: relative(root, path), size: text.length });
      return;
    }
    case 'POST /api/file': {
      const body = await readBody(request);
      const path = resolveWithin(root, typeof body.path === 'string' ? body.path : '');
      if (path === null || !path.endsWith(EXTENSION)) {
        sendJson(response, 400, { error: `un nom de fichier ${EXTENSION} est attendu` });
        return;
      }
      if (existsSync(path)) {
        sendJson(response, 409, { error: 'le fichier existe deja' });
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '', 'utf8');
      sendJson(response, 201, { path: relative(root, path) });
      return;
    }
    case 'DELETE /api/file': {
      const path = requirePath(url, root);
      if (!existsSync(path) || !statSync(path).isFile()) {
        sendJson(response, 404, { error: 'fichier introuvable' });
        return;
      }
      unlinkSync(path);
      sendJson(response, 200, { path: relative(root, path) });
      return;
    }
    case 'GET /api/check': {
      const path = requirePath(url, root);
      sendJson(response, 200, checkFile(path));
      return;
    }
    case 'POST /api/check': {
      // L'editeur analyse le tampon non enregistre : le texte prime sur le
      // contenu du disque.
      const body = await readBody(request);
      const path = typeof body.path === 'string' ? resolveWithin(root, body.path) : null;
      if (path === null) {
        sendJson(response, 400, { error: 'chemin hors du dossier de travail' });
        return;
      }
      const text = typeof body.text === 'string' ? body.text : undefined;
      sendJson(response, 200, check(path, text));
      return;
    }
    case 'POST /api/run': {
      // Le tampon de l'editeur est execute tel quel : `Ctrl+S` n'est pas
      // necessaire pour voir le resultat.
      const body = await readBody(request);
      const path = typeof body.path === 'string' ? resolveWithin(root, body.path) : null;
      if (path === null) {
        sendJson(response, 400, { error: 'chemin hors du dossier de travail' });
        return;
      }
      const text = typeof body.text === 'string' ? body.text : undefined;
      // Le programme herite du dossier de travail : il ne peut ni lire ni
      // ecrire ailleurs, meme si la page demandait autre chose.
      const execution: RunRequest = { path, text, fileRoot: root };
      sendJson(response, 200, await runIsolated(execution, runTimeout));
      return;
    }
    default:
      sendJson(response, 404, { error: 'route inconnue' });
  }
}

/** Resultat d'une analyse : premiere erreur, ou `null` si tout est correct. */
interface CheckResult {
  ok: boolean;
  error: { message: string; line: number; column: number } | null;
}

/** Analyse un fichier du disque. */
function checkFile(path: string): CheckResult {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { ok: false, error: { message: 'fichier introuvable', line: 1, column: 0 } };
  }
  return check(path, undefined);
}

/** Analyse un texte ; sans `text`, le fichier `path` est lu sur le disque. */
function check(path: string, text: string | undefined): CheckResult {
  const source = text ?? (existsSync(path) ? readFileSync(path, 'utf8') : null);
  if (source === null) {
    return { ok: false, error: { message: 'fichier introuvable', line: 1, column: 0 } };
  }
  try {
    parse(source, path);
    return { ok: true, error: null };
  } catch (error) {
    if (error instanceof UchiSyntaxError) {
      return { ok: false, error: { message: error.message, line: error.line, column: error.column } };
    }
    return { ok: false, error: { message: message(error), line: 1, column: 0 } };
  }
}

/** Chemin demande dans la requete, verifie comme etant dans le dossier racine. */
function requirePath(url: URL, root: string): string {
  const requested = url.searchParams.get('path') ?? '';
  const path = resolveWithin(root, requested);
  if (path === null) {
    throw new Error('chemin hors du dossier de travail');
  }
  return path;
}

/**
 * Resout un chemin relatif et refuse toute evasion du dossier racine.
 * Renvoie `null` si le chemin sort, y compris via `..` ou un lien absolu.
 */
function resolveWithin(root: string, requested: string): string | null {
  if (requested === '') return null;
  const path = resolve(root, requested);
  if (path === root || !path.startsWith(root + sep)) return null;
  return path;
}

/** Arborescence des fichiers Uchi, sans les dossiers caches. */
function listTree(root: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith('.')) continue;
      const full = join(directory, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue; // lien rompu ou fichier disparu entre-temps
      }
      if (stats.isDirectory()) {
        entries.push({
          path: relative(root, full).split(sep).join('/'),
          name,
          directory: true,
          size: 0,
          modified: stats.mtimeMs,
        });
        walk(full, depth + 1);
        continue;
      }
      if (extname(name) === EXTENSION) {
        entries.push({
          path: relative(root, full).split(sep).join('/'),
          name,
          directory: false,
          size: stats.size,
          modified: stats.mtimeMs,
        });
      }
    }
  };
  walk(root, 0);
  return entries;
}

/** Corps JSON d'une requete, avec une taille maximale. */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('corps de requete trop volumineux');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('corps de requete JSON invalide');
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function send(response: ServerResponse, status: number, contentType: string, body: Buffer | string): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    // L'editeur n'a besoin d'aucune ressource externe.
    'cache-control': 'no-store',
    // Le contenu est du code servi par le serveur lui-meme : un navigateur ne
    // doit ni le renifler ni transmettre l'adresse a un tiers.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
