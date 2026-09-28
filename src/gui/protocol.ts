/**
 * Contrat entre le serveur et le fil d'execution.
 *
 * Ces types decrivent ce que l'editeur attend de `POST /api/run`. Ils sont
 * partages pour que le fil et le serveur ne puissent pas diverger.
 */

export interface RunRequest {
  /** Chemin absolu du fichier : sert de nom de module et de base aux imports. */
  path: string;
  /** Source a executer ; absente, le fichier est lu sur le disque. */
  text?: string;
}

export interface RunError {
  /** Type de l'erreur (`ZeroDivisionError`), ou `Erreur` si elle n'en a pas. */
  name: string;
  message: string;
  /** Ligne fautive ; `0` si elle est inconnue. */
  line: number;
}

export interface RunResult {
  /** `true` si le programme s'est termine normalement. */
  ok: boolean;
  /** Tout ce que le programme a ecrit jusqu'a la fin, eventuellement tronque. */
  stdout: string;
  /** Trace d'appels, du plus ancien au plus recent ; vide si tout va bien. */
  trace: string[];
  error: RunError | null;
  /** Duree de l'execution, en millisecondes. */
  durationMs: number;
}
