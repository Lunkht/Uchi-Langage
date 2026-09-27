/**
 * Point d'entree de l'editeur web.
 *
 * `openBrowser` separe du serveur : les tests peuvent demarrer l'editeur sans
 * toucher au navigateur de la machine.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { startGuiServer, type GuiOptions, type GuiServer } from './server.ts';

export { startGuiServer } from './server.ts';
export type { GuiOptions, GuiServer } from './server.ts';

/** Demarre l'editeur et renvoie le serveur, pret a etre arrete. */
export function openEditor(options: GuiOptions): Promise<GuiServer> {
  return startGuiServer(options);
}

/**
 * Ouvre une URL dans le navigateur du systeme.
 *
 * Le processus enfant est ignore sans arriere-plan : le navigateur doit
 * survivre a la fermeture du lanceur.
 */
export function openBrowser(url: string): void {
  const [command, args] = browserCommand(url);
  if (command === null) return;
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* le navigateur n'a pas demarre : l'URL affichee reste utilisable */
    });
    child.unref();
  } catch {
    /* idem : l'editeur reste accessible a la main */
  }
}

/** Commande d'ouverture adaptee au systeme. */
function browserCommand(url: string): [string | null, string[]] {
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  if (process.platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/** Dossier de travail par defaut : le repertoire courant. */
export function defaultRoot(): string {
  return resolve(process.cwd());
}
