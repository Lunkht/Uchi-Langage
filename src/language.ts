/**
 * Identite du langage.
 *
 * L'extension des sources est ecrite une seule fois dans le projet : la ligne
 * de commande, le serveur de l'editeur et le chargeur de modules la reprennent,
 * pour qu'un fichier Uchi soit nomme de la meme facon partout. La page web la
 * reçoit par l'API, au lieu de la redcrire.
 */

/** Extension des sources, point inclus. */
export const EXTENSION = '.uchi';

/** Nom affiche du langage. */
export const LANGUAGE_NAME = 'Uchi';

/** Fichier qui rend un dossier importable. */
export const PACKAGE_FILE = `__init__${EXTENSION}`;

/** Ce que l'editeur affiche du langage : nom et extension. */
export const LANGUAGE = {
  name: LANGUAGE_NAME,
  extension: EXTENSION,
} as const;
