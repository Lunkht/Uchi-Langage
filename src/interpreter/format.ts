/**
 * Formatage de valeurs, style `format()` de Python.
 *
 * Le gabarit est de la forme :
 *   [[fill]align][sign][#][0][width][,][.precision][type]
 *
 * Utilise par les f-strings (`f"{valeur:>10.2f}"`) et par `str.format()`.
 */

import { makeError } from './error-registry.ts';
import { toStr, typeName } from './operations.ts';
import type { UchiValue } from './values.ts';

const SPEC_PATTERN =
  /^(?:(.)?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?(,)?(?:\.(\d+))?([sdfegFExXob%])?$/;

const GROUPING = /\B(?=(\d{3})+(?!\d))/g;

export function parseFormatSpec(spec: string): FormatSpec {
  const match = SPEC_PATTERN.exec(spec);
  if (match === null) {
    throw makeError('ValueError', `gabarit de format invalide : '${spec}'`);
  }
  return {
    fill: match[1],
    align: (match[2] as '<' | '>' | '=' | '^' | undefined) ?? null,
    sign: (match[3] as '+' | '-' | ' ' | undefined) ?? null,
    alternate: match[4] !== undefined,
    zeroPad: match[5] !== undefined,
    width: match[6] === undefined ? null : Number.parseInt(match[6], 10),
    grouping: match[7] !== undefined,
    precision: match[8] === undefined ? null : Number.parseInt(match[8], 10),
    type: match[9] ?? null,
  };
}

export interface FormatSpec {
  fill: string | undefined;
  align: '<' | '>' | '=' | '^' | null;
  sign: '+' | '-' | ' ' | null;
  alternate: boolean;
  zeroPad: boolean;
  width: number | null;
  grouping: boolean;
  precision: number | null;
  type: string | null;
}

/** Applique un gabarit a une valeur et renvoie la chaine resultante. */
export function applyFormat(value: UchiValue, specText: string): string {
  const spec = parseFormatSpec(specText);
  // Sans type explicite, un nombre reste un nombre : `f"{1234:,}"` doit produire
  // `1,234` et non `1234`.
  const numericValue = typeof value === 'number';
  const isNumericType = spec.type !== null ? spec.type !== 's' : numericValue;

  let body: string;
  if (isNumericType) {
    body = formatNumber(value, spec);
  } else if (typeof value === 'string') {
    if (spec.type !== null && spec.type !== 's') {
      throw makeError('ValueError', `le gabarit '${spec.type}' ne s'applique pas a une chaine`);
    }
    body = spec.precision === null ? value : value.slice(0, spec.precision);
  } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    body = toStr(value);
  } else if (spec.type !== null && spec.type !== 's') {
    throw makeError('ValueError', `le gabarit '${spec.type}' ne s'applique pas a '${typeName(value)}'`);
  } else {
    body = toStr(value);
  }

  return pad(body, spec, isNumericType);
}

function formatNumber(value: UchiValue, spec: FormatSpec): string {
  if (typeof value === 'boolean' || value === null) {
    throw makeError('ValueError', `le gabarit '${spec.type}' ne s'applique pas a '${typeName(value)}'`);
  }
  if (typeof value !== 'number') {
    throw makeError('ValueError', `le gabarit '${spec.type}' ne s'applique pas a '${typeName(value)}'`);
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : Number.isNaN(value) ? 'nan' : '-inf';
  }

  const type = spec.type ?? (Number.isInteger(value) ? 'd' : 'g');
  const precision = spec.precision;

  let body: string;
  switch (type) {
    case 'd': {
      if (!Number.isInteger(value)) {
        throw makeError('ValueError', `le gabarit 'd' exige un entier, recu ${value}`);
      }
      body = String(Math.abs(value));
      break;
    }
    case 'b':
      body = Math.abs(value).toString(2);
      if (spec.alternate) body = `0b${body}`;
      break;
    case 'o':
      body = Math.abs(value).toString(8);
      if (spec.alternate) body = `0o${body}`;
      break;
    case 'x':
      body = Math.abs(value).toString(16);
      if (spec.alternate) body = `0x${body}`;
      break;
    case 'X':
      body = Math.abs(value).toString(16).toUpperCase();
      if (spec.alternate) body = `0X${body}`;
      break;
    case 'F':
    case 'f':
      body = Math.abs(value).toFixed(precision ?? 6);
      break;
    case 'e':
      body = (precision === null ? Math.abs(value) : Number(Math.abs(value).toFixed(precision))).toExponential(
        precision === null ? 6 : precision,
      );
      break;
    case 'E':
      body = Math.abs(value).toExponential(precision ?? 6).toUpperCase();
      break;
    case 'g': {
      body = formatGeneral(Math.abs(value), precision);
      break;
    }
    case '%':
      body = `${(Math.abs(value) * 100).toFixed(precision ?? 6)}%`;
      break;
    default:
      body = String(Math.abs(value));
  }

  if (spec.grouping && (type === 'd' || type === 'f' || type === 'F')) {
    const [whole, fraction] = body.split('.');
    const grouped = (whole as string).replace(GROUPING, ',');
    body = fraction === undefined ? grouped : `${grouped}.${fraction}`;
  }

  if (value < 0) return `-${body}`;
  if (spec.sign === '+') return `+${body}`;
  if (spec.sign === ' ') return ` ${body}`;
  return body;
}

function formatGeneral(value: number, precision: number | null): string {
  if (value === 0) return '0';
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= (precision ?? 6)) {
    const text = value.toExponential(precision === null ? 5 : precision);
    // `1e+05` -> `1e+05` : on conserve la notation Python telle quelle.
    return text;
  }
  const digits = precision === null ? 6 : precision;
  return String(Number(value.toPrecision(digits)));
}

function pad(body: string, spec: FormatSpec, numeric: boolean): string {
  const width = spec.width;
  if (width === null || body.length >= width) return body;

  let align = spec.align;
  if (align === null) {
    if (spec.zeroPad && numeric) return padZero(body, width);
    align = numeric ? '>' : '<';
  }

  const fill = spec.fill ?? (spec.zeroPad && numeric ? '0' : ' ');
  const missing = width - body.length;
  switch (align) {
    case '>':
      return fill.repeat(missing) + body;
    case '<':
      return body + fill.repeat(missing);
    case '^': {
      const left = Math.floor(missing / 2);
      return fill.repeat(left) + body + fill.repeat(missing - left);
    }
    case '=': {
      // Le remplissage s'insere apres le signe.
      const signLength = /^[-+ ]/.test(body) ? 1 : 0;
      return body.slice(0, signLength) + fill.repeat(missing) + body.slice(signLength);
    }
    default:
      return body;
  }
}

function padZero(body: string, width: number): string {
  const signLength = /^[-+ ]/.test(body) ? 1 : 0;
  return body.slice(0, signLength) + '0'.repeat(width - body.length) + body.slice(signLength);
}
