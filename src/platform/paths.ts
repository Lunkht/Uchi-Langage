/**
 * Chemins portables, equivalents POSIX de `node:path`.
 *
 * Le moteur du langage ne doit dependre de rien qui n'existe pas dans un
 * navigateur, et `node:path` n'y est pas. Ces fonctions ne sont que de la
 * logique de chaines : les reecrire coute peu et evite d'importer Node pour
 * sixoperations.
 *
 * Les chemins sont normalises enseparateur `/`, comme sous Unix. Un programme
 * Uchi qui lit des chemins ecrits avec `\` n'a pas a etre gere : il vient
 * d'un systeme ou Uchi tourne deja.
 */

/** Separateur unique, quel que soit l'hote. */
export const sep = '/';

/** Le chemin est-il absolu, c'est-a-dire commence-t-il par `/` ? */
export function isAbsolute(path: string): boolean {
  return path.startsWith('/');
}

/**
 * Normalise un chemin : `a//b`, `a/./b` et `a/x/../b` become `a/b`.
 *
 * Les `..` qui remonteraient au-dessus de la racine sont supprimes, comme
 * le fait POSIX pour `/..` qui vaut `/`.
 */
export function normalize(path: string): string {
  const absolu = isAbsolute(path);
  const morceaux: string[] = [];
  for (const morceau of path.split('/')) {
    if (morceau === '' || morceau === '.') continue;
    if (morceau === '..') {
      const dernier = morceaux[morceaux.length - 1];
      if (dernier !== undefined && dernier !== '..') morceaux.pop();
      else if (!absolu) morceaux.push('..');
      continue;
    }
    morceaux.push(morceau);
  }
  const corps = morceaux.join(sep);
  if (absolu) return sep + corps;
  return corps === '' ? '.' : corps;
}

/** Assemble des morceaux et normalise le resultat. */
export function join(...parties: string[]): string {
  const filtrees = parties.filter((partie) => partie !== '');
  if (filtrees.length === 0) return '.';
  return normalize(filtrees.join(sep));
}

/**
 * Resout un chemin relatif contre une base.
 *
 * `base` sert de depart quand `chemins` est relatif ; avec un chemin absolu,
 * c'est `chemins` qui gagne, comme sous Node.
 */
export function resolve(base: string, chemins: string): string {
  if (isAbsolute(chemins)) return normalize(chemins);
  if (chemins === '') return normalize(base);
  return normalize(base === '' ? chemins : base + sep + chemins);
}

/** Le dossier contenant `chemin`. */
export function dirname(chemin: string): string {
  const normalise = chemin.replace(/[/]+$/, '');
  if (normalise === '' || normalise === '/') return '/';
  const coupe = normalise.lastIndexOf(sep);
  if (coupe < 0) return '.';
  if (coupe === 0) return sep;
  return normalise.slice(0, coupe);
}

/**
 * Le chemin de `depart` a `arrivee`, relatif au dossier de `depart`.
 *
 * Les deux chemins doivent etre absolus et comparables : c'est ce que fait
 * `open()` pour verifier qu'un chemin ne sort pas de son dossier.
 */
export function relative(depart: string, arrivee: string): string {
  const depuis = normalize(depart).split(sep).filter(Boolean);
  const vers = normalize(arrivee).split(sep).filter(Boolean);
  let commun = 0;
  while (commun < depuis.length && commun < vers.length && depuis[commun] === vers[commun]) commun++;
  const remontes = depuis.length - commun;
  return [...Array(remontes).fill('..'), ...vers.slice(commun)].join(sep);
}

/** `dir/nom.uchi` donne `nom.uchi`, `dir/` donne `nom`. */
export function basename(chemin: string, extension?: string): string {
  const nom = normalize(chemin).split(sep).pop() ?? '';
  if (extension !== undefined && nom.endsWith(extension)) return nom.slice(0, -extension.length);
  return nom;
}

/** L'extension, point compris, ou une chaine vide s'il n'y en a pas. */
export function extname(chemin: string): string {
  const nom = basename(chemin);
  const point = nom.lastIndexOf('.');
  if (point <= 0) return '';
  return nom.slice(point);
}