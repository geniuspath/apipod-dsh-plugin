/** Total readers for untrusted JSON: a wrong shape reads as absent, never as a throw. */

export type Json = Readonly<Record<string, unknown>>

export function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function asStrings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string' && item !== '')
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
