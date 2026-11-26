import type { Practice } from './practice.ts'

export interface Scene {
  title: string
  text: string
  see: [string, string]
  stage?: string
  spot?: string[]
  open?: string
  shown?: { phone?: string, caption?: string, seconds?: number, desk?: {name: string, fields: [string,string][], done: string} }
}
export interface SceneResult {
  lines: string[]
  credit?: { share: number, campaign: string | null }
  card?: {title: string, path: string, fields: [string,string][]}
  checked?: string
}
export interface StageState {
  revision: number
  boot: string
  next: number
  scenes: Scene[]
  ready: boolean
  running: boolean
  progress: string
  error: string
  site: string
  ms: number
  told: SceneResult
  clock: number
  practice: Practice['stage']
}
export interface Stage {
  state(): StageState
  subscribe(change: () => void): () => void
  change(intent: string, boot: string, expected: number): Promise<string | undefined>
}
