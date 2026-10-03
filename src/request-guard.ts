/**
 * Garde de requêtes de l'éditeur Uchi (correctif de l'audit S1, S6).
 *
 * Trois défenses indépendantes, appliquées à CHAQUE requête avant tout routage :
 *
 *  1. `Host`  : doit être l'un des noms de bouclage (ou `extraHosts`) avec le
 *               port réel d'écoute. Bloque le DNS rebinding.
 *  2. Origine : `Sec-Fetch-Site` doit valoir `same-origin` ou `none`, et
 *               `Origin` (s'il est présent) doit être l'origine du serveur.
 *               Bloque les sites tiers, y compris un autre service
 *               `localhost:<autre port>` (« same-site »).
 *  3. Jeton   : toute requête qui modifie l'état (tout sauf GET/HEAD) doit
 *               porter l'en-tête `X-Uchi` égal au jeton aléatoire de la
 *               session. Un site tiers ne peut ni lire ce jeton ni envoyer
 *               un en-tête personnalisé sans préflight (que le serveur
 *               n'accepte jamais : aucun `Access-Control-Allow-*` n'est émis).
 *
 * Aucune dépendance. Compatible `erasableSyntaxOnly` / `verbatimModuleSyntax`.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Sous-ensemble structurel de `http.IncomingMessage` (facilite les tests). */
export interface GuardRequest {
  readonly method?: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403 | 421; readonly reason: string };

export interface GuardOptions {
  /** Port d'écoute réel. Fonction si le port n'est connu qu'après `listen()`. */
  readonly port: number | (() => number);
  /** Noms d'hôte supplémentaires acceptés. Vide par défaut (bouclage seul). */
  readonly extraHosts?: readonly string[];
  /** Jeton imposé (tests uniquement). Sinon 32 octets aléatoires. */
  readonly token?: string;
}

export interface RequestGuard {
  /** Jeton de session : à injecter dans la page et à renvoyer dans `X-Uchi`. */
  readonly token: string;
  check(req: GuardRequest): GuardVerdict;
}

/** Nom de l'en-tête porteur du jeton (en minuscules, comme Node les expose). */
export const TOKEN_HEADER = 'x-uchi';

const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

const OK: GuardVerdict = { ok: true };

function deny(status: 403 | 421, reason: string): GuardVerdict {
  return { ok: false, status, reason };
}

/** Valeur d'un en-tête à occurrence unique ; `undefined` si absent ; `null` si invalide (doublons). */
function singleHeader(
  headers: GuardRequest['headers'],
  name: string,
): string | undefined | null {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createRequestGuard(options: GuardOptions): RequestGuard {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const names = [...LOOPBACK_HOSTS, ...(options.extraHosts ?? [])].map((n) =>
    n.toLowerCase(),
  );

  function currentPort(): number {
    return typeof options.port === 'function' ? options.port() : options.port;
  }

  function check(req: GuardRequest): GuardVerdict {
    const port = currentPort();
    const hosts = new Set(names.map((name) => `${name}:${port}`));

    // 1. Host : bloque le DNS rebinding.
    const host = singleHeader(req.headers, 'host');
    if (typeof host !== 'string' || !hosts.has(host.toLowerCase())) {
      return deny(421, 'hôte non autorisé');
    }

    // 2a. Sec-Fetch-Site (navigateurs modernes) : refuse tout ce qui n'est
    //     pas strictement même origine ou saisi par l'utilisateur.
    const site = singleHeader(req.headers, 'sec-fetch-site');
    if (site === null || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      return deny(403, 'requête inter-sites refusée');
    }

    // 2b. Origin (si présent) : doit être l'origine du serveur. « null » est refusé.
    const origin = singleHeader(req.headers, 'origin');
    if (origin === null) return deny(403, 'origine non autorisée');
    if (origin !== undefined) {
      const origins = new Set([...hosts].map((h) => `http://${h}`));
      if (!origins.has(origin.toLowerCase())) {
        return deny(403, 'origine non autorisée');
      }
    }

    // Lecture seule : Host + origine suffisent.
    const method = (req.method ?? 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return OK;

    // 3. Requête modifiante (POST, PUT, DELETE, OPTIONS, …) : jeton obligatoire.
    const given = singleHeader(req.headers, TOKEN_HEADER);
    if (typeof given !== 'string' || !safeEqual(given, token)) {
      return deny(403, 'jeton de session manquant ou invalide');
    }
    return OK;
  }

  return { token, check };
}

/**
 * Insère `<meta name="uchi-token">` dans la page servie. Le jeton est en
 * base64url : aucun échappement HTML n'est nécessaire.
 */
export function injectToken(html: string, token: string): string {
  const meta = `<meta name="uchi-token" content="${token}">`;
  return html.includes('</head>')
    ? html.replace('</head>', () => `${meta}</head>`)
    : meta + html;
}

/**
 * En-têtes de réponse défensifs (audit S6). `no-store` reste posé par le
 * serveur. Le CSP autorise les styles en ligne (`style-src 'unsafe-inline'`)
 * par prudence : à resserrer après vérification dans un vrai navigateur.
 */
export function securityHeaders(): Readonly<Record<string, string>> {
  return {
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
      "form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
  };
}