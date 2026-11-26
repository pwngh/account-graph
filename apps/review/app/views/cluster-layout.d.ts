import type { KnownProfile } from './accounts'

export const PERSON: string
export const ICONS: Record<string, string>
export function typeOf(id: string): string
export function nameOf(id: string): string
export interface ClusterLayout {
  total: number
  viewBox: string
  nodes: { id: string, x: number, y: number, r: number, role: string, tx: number, ty: number }[]
  paths: { a: string, b: string, d: string, kind: string, label: string, score?: number, x: number, y: number }[]
  hulls: string[]
}
export function clusterLayout(profile: KnownProfile): ClusterLayout
