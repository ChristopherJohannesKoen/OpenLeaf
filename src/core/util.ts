import { createHash } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * JSON Merge Patch (RFC 7396): objects merge recursively, `null` deletes a
 * key, everything else replaces.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/** Deep-merge `overrides` onto `defaults` without deleting anything. */
export function deepDefaults(defaults: unknown, overrides: unknown): unknown {
  if (!isPlainObject(defaults) || !isPlainObject(overrides)) {
    return overrides === undefined ? defaults : overrides;
  }
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = deepDefaults(out[key], value);
  }
  return out;
}

export function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

/** Escape text so it can sit safely inside a LaTeX document. */
export function latexEscape(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\textbackslash{}';
      case '^':
        return '\\textasciicircum{}';
      case '~':
        return '\\textasciitilde{}';
      default:
        return `\\${c}`;
    }
  });
}

/** A filename-safe version of a project name. */
export function slugify(name: string, fallback = 'project'): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

export type { Json };
