export type AcRow = { ac_id: string; text: string; verdict: 'Verified' | 'Failed' | 'Unknown' }
export type TicketView = {
  id: string
  title: string
  status: string
  owner: string | null
  priority: string
  lease_until: string | null
  branch: string | null
  blocked_reason: string | null
  rework_count: number
  acceptance: AcRow[]
  last_handoff: string | null
}
export type ReadyRow = { id: string; title: string; priority: string; lane: string }
export type Snapshot = {
  initialized: boolean
  root?: string
  actor?: string
  ticket?: TicketView | null
  ready?: ReadyRow[]
  counts?: { ready: number; review: number; blocked: number; needs_human: number }
  loop?: { active: boolean; max_tickets: number; label: string | null; halted?: string | null } | null
  error?: string
  at?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-flow-mod': { snap: Shaped<Snapshot | null>; isBandHidden: boolean }
  }
}
