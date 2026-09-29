/**
 * Fil d'execution d'un programme Uchi.
 *
 * L'execution se fait ici, dans un fil dedie plutot que dans le fil de
 * l'appelant : une boucle infinie ou un depilement de pile ne peut donc plus
 * immobiliser l'editeur, et l'appelant peut interrompre le programme quand la
 * limite de temps est atteinte. Le fil renvoie un `RunResult` et se termine.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { UchiSyntaxError, UchiThrow, tracebackLine } from '../errors.ts';
import { Interpreter } from '../interpreter/interpreter.ts';
import { errorSummary } from '../interpreter/report.ts';
import { UchiError } from '../interpreter/values.ts';
import { parse } from '../parser/parser.ts';
import type { OutputChunk, RunRequest, RunResult } from './protocol.ts';

/**
 * Taille maximale de la sortie conservee.
 *
 * Un programme peut ecrire indefiniment ; sans plafond, l'appelant recoit un
 * message geant. Au-dela, l'ecriture est ignoree et la sortie est annoncee
 * comme tronquee.
 */
const MAX_OUTPUT = 1_000_000;

/** Analyse puis execute un programme, et decrit ce qui s'est passe. */
function run(request: RunRequest): RunResult {
  const source = request.text ?? (existsSync(request.path) ? readFileSync(request.path, 'utf8') : null);
  if (source === null) {
    return echec({ name: 'OSError', message: 'fichier introuvable', line: 0 });
  }

  let program;
  try {
    program = parse(source, request.path);
  } catch (error) {
    if (error instanceof UchiSyntaxError) {
      return echec({ name: 'SyntaxError', message: error.message, line: error.line });
    }
    return echec({ name: 'Error', message: error instanceof Error ? error.message : String(error), line: 0 });
  }

  const argv = request.argv ?? [request.path];
  let stdout = '';
  let tronque = false;
  const ecrire = (chunk: string): void => {
    if (tronque) return;
    if (stdout.length + chunk.length <= MAX_OUTPUT) {
      stdout += chunk;
    } else {
      // Seule la part du fragment qui tient encore est conservee, pour ne pas
      // depasser le plafond.
      stdout += chunk.slice(0, MAX_OUTPUT - stdout.length);
      tronque = true;
      stdout += '\n[sortie tronquee : plus de 1 Mo]';
    }
    if (request.stream) parentPort?.postMessage({ kind: 'sortie', chunk } satisfies OutputChunk);
  };

  const interpreter = new Interpreter({
    argv,
    baseDirectory: dirname(request.path),
    // `undefined` pour `uchi run` : le programme garde l'acces complet au
    // disque, comme le demande son propre auteur.
    fileRoot: request.fileRoot,
    write: ecrire,
    // Le programme n'a pas de terminal : `input()` atteint immediatement la fin
    // du flux plutot que de bloquer l'appelant.
    readLine: () => null,
  });

  const started = performance.now();
  try {
    interpreter.run(program);
    return {
      ok: true,
      stdout,
      trace: [],
      error: null,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (thrown) {
    const { name, message } = errorSummary(interpreter, thrown);
    const trace = thrown instanceof UchiThrow ? thrown.traceback : [];
    const result: RunResult = {
      ok: false,
      stdout,
      trace,
      // Une valeur levee qui n'est pas une exception n'a pas de type : elle est
      // alors designee par le seul message.
      error: { name: name === '' ? 'Erreur' : name, message, line: tracebackLine(trace) || interpreter.currentLine },
      durationMs: Math.round(performance.now() - started),
    };
    // `sys.exit()` demande un code de sortie precis, que l'appelant doit
    // pouvoir retrouver : il ne se deduit pas du message d'erreur.
    const code = exitCodeOf(thrown);
    if (code !== null) result.exitCode = code;
    return result;
  }
}

/** Code demande par `sys.exit()`, ou `null` si l'exception n'en est pas une. */
function exitCodeOf(thrown: unknown): number | null {
  if (!(thrown instanceof UchiThrow)) return null;
  const value = thrown.value;
  if (!(value instanceof UchiError) || value.name !== 'SystemExit') return null;
  const code = value.args[0];
  return typeof code === 'number' ? code : 0;
}

function echec(error: RunResult['error']): RunResult {
  return { ok: false, stdout: '', trace: [], error, durationMs: 0 };
}

// Le fil n'attend qu'une requete : il repond puis rend la main.
parentPort?.postMessage(run(workerData as RunRequest));
