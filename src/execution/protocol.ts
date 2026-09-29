/**
 * Contrat entre l'appelant et le fil d'execution.
 *
 * Ces types decrivent le resultat d'une execution isolee. Ils sont partages
 * pour que le fil, le serveur de l'editeur et la ligne de commande ne puissent
 * pas diverger.
 */

export interface RunRequest {
  /** Chemin absolu du fichier : sert de nom de module et de base aux imports. */
  path: string;
  /** Source a executer ; absente, le fichier est lu sur le disque. */
  text?: string;
  /** Arguments du programme, exposes par `sys.argv`. */
  argv?: string[];
  /**
   * `true` pour recevoir la sortie fragment par fragment au lieu de la seule
   * dans le resultat final.
   */
  stream?: boolean;
  /**
   * Dossier auquel `open()` est confine. Absent, le programme lit et ecrit
   * n'importe ou : c'est le cas de `uchi run`, ou l'utilisateur choisit
   * lui-meme ses chemins. L'editeur le renseigne pour que le programme execute
   * depuis une page web n'atteigne que son dossier de travail.
   */
  fileRoot?: string;
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
  /** Code demande par `sys.exit()` ; absent si le programme ne l'a pas appele. */
  exitCode?: number;
}

/** Fragment de sortie envoye par le fil quand le flux est demande. */
export interface OutputChunk {
  kind: 'sortie';
  chunk: string;
}

/** Message emis par le fil : un fragment de sortie, puis le resultat. */
export type WorkerMessage = OutputChunk | RunResult;

/** Distingue un fragment de sortie du resultat final. */
export function isOutputChunk(message: WorkerMessage): message is OutputChunk {
  return (message as OutputChunk).kind === 'sortie';
}
