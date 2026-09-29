/**
 * Execution isolee d'un programme Uchi, avec coupure par le temps.
 *
 * Le programme tourne dans un fil dedie. Si le delai expire, l'appelant
 * recoit quand meme un `RunResult` decrivant l'interruption, et le fil est
 * arrete : un programme qui tourne ne survit pas a son delai.
 *
 * Le fil etant un `worker_thread` et non un processus, il partage la memoire de
 * l'appelant. C'est une garde-fou de robustesse — un programme plante ou
 * indefini n'immobilise plus l'editeur — et non une frontiere de securite.
 */

import { Worker } from 'node:worker_threads';

import { isOutputChunk, type RunRequest, type RunResult, type WorkerMessage } from './protocol.ts';

/**
 * Execute un programme dans un fil isole.
 *
 * @param request Programme a executer.
 * @param timeout Delai maximal, en millisecondes.
 * @param onOutput Recoit la sortie fragment par fragment si `request.stream`.
 */
export async function runIsolated(
  request: RunRequest,
  timeout: number,
  onOutput?: (chunk: string) => void,
): Promise<RunResult> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: request });
  try {
    return await new Promise<RunResult>((resolvePromise) => {
      let repondu = false;
      const minuteur = setTimeout(() => {
        repondre({
          ok: false,
          stdout: '',
          trace: [],
          error: {
            name: 'TimeoutError',
            message: `delai depasse (${Math.round(timeout / 1000)} s) : execution interrompue`,
            line: 0,
          },
          durationMs: timeout,
        });
      }, timeout);

      function repondre(result: RunResult): void {
        if (repondu) return;
        repondu = true;
        clearTimeout(minuteur);
        resolvePromise(result);
      }

      worker.on('message', (message: WorkerMessage) => {
        if (isOutputChunk(message)) {
          onOutput?.(message.chunk);
          return;
        }
        repondre(message);
      });
      // Un plantage du programme (pile profunda, memoire) est rattrape ici.
      worker.on('error', (erreur: Error) => {
        repondre({
          ok: false,
          stdout: '',
          trace: [],
          error: { name: 'RuntimeError', message: erreur.message, line: 0 },
          durationMs: 0,
        });
      });
      // Un fil qui s'arrete sans avoir repondu a ete arrete par le systeme.
      worker.on('exit', (code: number) => {
        repondre({
          ok: false,
          stdout: '',
          trace: [],
          error: { name: 'RuntimeError', message: `le programme s'est arrete (code ${code})`, line: 0 },
          durationMs: 0,
        });
      });
    });
  } finally {
    // Le fil est arrete dans tous les cas : apres une reponse comme apres un
    // delai, un programme encore actif ne doit pas continuer en arriere-plan.
    await worker.terminate();
  }
}
