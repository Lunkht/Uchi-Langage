/**
 * Fichiers : builtin `open()` et classe `File`.
 *
 * Un fichier est une instance de la classe native `File`. Son etat (descripteur,
 * mode, tampon de lecture) vit dans `payload`, invisible depuis le code Uchi.
 * La lecture se fait par blocs, ce qui evite de charger un fichier entier en
 * memoire pour un simple `readline()`.
 */

import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { makeError } from '../interpreter/error-registry.ts';
import { arityCheck, expectInt, expectString } from '../interpreter/context.ts';
import type { NativeCallArgs } from '../interpreter/context.ts';
import {
  UchiClass,
  UchiInstance,
  UchiNativeFunction,
  type UchiValue,
} from '../interpreter/values.ts';

/** Etat natif d'un fichier ouvert. */
interface FileState {
  descriptor: number;
  mode: string;
  path: string;
  closed: boolean;
  /** Texte lu mais pas encore consommé par `readline`. */
  pending: string;
}

const CHUNK_SIZE = 8192;

/** Translue un mode Python en indicateurs de `fs`. */
function toFlags(mode: string): string {
  // `r`, `w`, `a`, `x`, suivis eventuellement de `b`, `t` et `+`, dans
  // n'importe quel ordre.
  if (!/^[rwax][bt+]*$/.test(mode)) {
    throw makeError('ValueError', `mode invalide : '${mode}'`);
  }
  const letter = mode[0] as string;
  switch (letter) {
    case 'r':
      return mode.includes('+') ? 'r+' : 'r';
    case 'w':
      return mode.includes('+') ? 'w+' : 'w';
    case 'a':
      return mode.includes('+') ? 'a+' : 'a';
    case 'x':
      return mode.includes('+') ? 'wx+' : 'wx';
    default:
      throw makeError('ValueError', `mode invalide : '${mode}'`);
  }
}

function isWritable(mode: string): boolean {
  return mode[0] !== 'r';
}

/** Correspondance entre les codes d'erreur de `fs` et les types Python. */
const ERROR_TYPES: Record<string, string> = {
  ENOENT: 'FileNotFoundError',
  EACCES: 'PermissionError',
  EPERM: 'PermissionError',
  EEXIST: 'FileExistsError',
  EISDIR: 'IsADirectoryError',
  ENOTDIR: 'NotADirectoryError',
  ENOTEMPTY: 'OSError',
};

/** Traduit une erreur de `fs` en exception Uchi, avec le message de Python. */
function fileError(action: string, path: string, thrown: unknown): ReturnType<typeof makeError> {
  const code = typeof thrown === 'object' && thrown !== null && 'code' in thrown
    ? String((thrown as { code: unknown }).code)
    : null;
  const name = code === null ? 'OSError' : ERROR_TYPES[code] ?? 'OSError';
  return makeError(name, `${action}('${path}') : ${code === null ? String(thrown) : code}`);
}

function stateOf(self: UchiValue, who: string): FileState {
  if (!(self instanceof UchiInstance) || self.payload === null) {
    throw makeError('TypeError', `${who} attend un fichier ouvert`);
  }
  const state = self.payload as FileState;
  if (state.closed) {
    throw makeError('ValueError', `operation sur un fichier ferme : '${state.path}'`);
  }
  return state;
}

/** Remplit le tampon de lecture si necessaire. */
function fillBuffer(state: FileState): boolean {
  if (state.pending.length > 0) return true;
  const buffer = Buffer.alloc(CHUNK_SIZE);
  const read = readSome(state, buffer, CHUNK_SIZE, 'readline()');
  if (read === 0) return false;
  state.pending = buffer.toString('utf8', 0, read);
  return state.pending.length > 0;
}

/** Lecture bas niveau, traduite en exception Uchi. */
function readSome(state: FileState, buffer: Buffer, length: number, who: string): number {
  try {
    return readSync(state.descriptor, buffer, 0, length, null);
  } catch (thrown) {
    throw fileError(who, state.path, thrown);
  }
}

export function createFileBuiltins(): Array<[string, UchiValue]> {
  const klass = new UchiClass('File', []);

  // Les methodes sont d'abord decrites comme des fonctions pures sur l'etat,
  // puis enregistrees sur la classe : `readlines` peut ainsi reutiliser
  // `readline` sans passer par un aller-retour dans la table de classe.
  const readAll = (self: UchiValue, size: number | undefined): string => {
    const state = stateOf(self, 'read()');
    if (size === undefined) {
      // `read()` sans argument vide le fichier, comme en Python : le tampon
      // alimente par `readline()` est d'abord chasse.
      let out = state.pending;
      state.pending = '';
      const chunk = Buffer.alloc(CHUNK_SIZE);
      for (;;) {
        const read = readSome(state, chunk, CHUNK_SIZE, 'read()');
        if (read === 0) break;
        out += chunk.toString('utf8', 0, read);
      }
      return out;
    }
    if (size < 0) return '';
    // Avec une taille, le tampon peut deja contenir plus que demande : on rend
    // les caracteres demandes et on conserve le reste pour la lecture suivante.
    let out = state.pending.slice(0, size);
    state.pending = state.pending.slice(size);
    let remaining = size - out.length;
    while (remaining > 0) {
      const buffer = Buffer.alloc(remaining);
      const read = readSome(state, buffer, remaining, 'read()');
      if (read === 0) break;
      out += buffer.toString('utf8', 0, read);
      remaining -= read;
    }
    return out;
  };

  const readLine = (self: UchiValue): string => {
    const state = stateOf(self, 'readline()');
    let out = '';
    for (;;) {
      if (!fillBuffer(state)) break;
      const newline = state.pending.indexOf('\n');
      if (newline === -1) {
        out += state.pending;
        state.pending = '';
        continue;
      }
      out += state.pending.slice(0, newline + 1);
      state.pending = state.pending.slice(newline + 1);
      break;
    }
    return out;
  };

  const readLines = (self: UchiValue): UchiValue[] => {
    const lines: UchiValue[] = [];
    for (;;) {
      const line = readLine(self);
      if (line === '') break;
      lines.push(line);
    }
    return lines;
  };

  const write = (self: UchiValue, text: string): number => {
    const state = stateOf(self, 'write()');
    if (!isWritable(state.mode)) {
      throw makeError('ValueError', `le fichier '${state.path}' n'est pas ouvert en ecriture`);
    }
    try {
      writeSync(state.descriptor, text);
    } catch (thrown) {
      throw fileError('write', state.path, thrown);
    }
    return text.length;
  };

  const method = (name: string, body: (self: UchiValue, args: NativeCallArgs) => UchiValue): void => {
    klass.set(name, new UchiNativeFunction(name, (args) => body(args.positional[0] as UchiValue, args)));
  };

  method('read', (self, args) => {
    arityCheck(args, 'read', 1, 2);
    const size = args.positional[1] === undefined ? undefined : expectInt(args.positional[1], 'read()');
    return readAll(self, size);
  });

  method('readline', (self) => readLine(self));
  method('readlines', (self) => readLines(self));

  method('write', (self, args) => {
    arityCheck(args, 'write', 2);
    return write(self, expectString(args.positional[1] as UchiValue, 'write()'));
  });

  method('writelines', (self, args) => {
    arityCheck(args, 'writelines', 2);
    const lines = args.positional[1] as UchiValue;
    if (!Array.isArray(lines)) {
      throw makeError('TypeError', "writelines() attend une liste de chaines");
    }
    let total = 0;
    for (const line of lines) {
      total += write(self, expectString(line, 'writelines()'));
    }
    return total;
  });

  method('close', (self) => {
    if (!(self instanceof UchiInstance) || self.payload === null) {
      throw makeError('TypeError', 'close() attend un fichier ouvert');
    }
    const state = self.payload as FileState;
    if (!state.closed) {
      closeSync(state.descriptor);
      state.closed = true;
    }
    return null;
  });

  method('readable', (self) => !stateOf(self, 'readable()').mode.startsWith('w'));
  method('writable', (self) => isWritable(stateOf(self, 'writable()').mode));
  method('closed', (self) => {
    if (!(self instanceof UchiInstance) || self.payload === null) return true;
    return (self.payload as FileState).closed;
  });
  method('name', (self) => {
    if (!(self instanceof UchiInstance) || self.payload === null) return null;
    return (self.payload as FileState).path;
  });
  method('mode', (self) => {
    if (!(self instanceof UchiInstance) || self.payload === null) return null;
    return (self.payload as FileState).mode;
  });

  // Support du futur `with` : la classe agira comme gestionnaire de contexte.
  method('__enter__', (self) => {
    stateOf(self, '__enter__()');
    return self;
  });
  method('__exit__', (self) => {
    if (self instanceof UchiInstance && self.payload !== null) {
      const state = self.payload as FileState;
      if (!state.closed) {
        closeSync(state.descriptor);
        state.closed = true;
      }
    }
    return false;
  });
  method('__repr__', (self) => {
    if (!(self instanceof UchiInstance) || self.payload === null) return '<fichier ferme>';
    const state = self.payload as FileState;
    return state.closed
      ? `<fichier ferme '${state.path}'>`
      : `<fichier '${state.path}' mode '${state.mode}'>`;
  });

  const open = new UchiNativeFunction('open', (args) => {
    arityCheck(args, 'open', 1, 3);
    const path = expectString(args.positional[0] as UchiValue, 'open()');
    const mode = args.positional[1] === undefined ? 'r' : expectString(args.positional[1], 'open()');
    // La conversion du mode est validee avant toute tentative d'ouverture : une
    // mauvaise ecriture doit lever `ValueError`, pas `FileNotFoundError`.
    const flags = toFlags(mode);
    let descriptor: number;
    try {
      descriptor = openSync(path, flags);
    } catch (thrown) {
      throw fileError('open', path, thrown);
    }
    const instance = new UchiInstance(klass);
    instance.payload = { descriptor, mode, path, closed: false, pending: '' } satisfies FileState;
    return instance;
  });

  return [
    ['open', open],
    ['File', klass],
  ];
}
