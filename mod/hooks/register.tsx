import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'

const PANE = 'agent-flow'
// Bump the shape tag when Snapshot's fields change: older stored values are then read as `null`.
const snap = atom({ plugin: 'agent-flow-mod', key: 'snap' } as const, null, { shape: 'snap-1' })
const isBandHidden = atom({ plugin: 'agent-flow-mod', key: 'isBandHidden' } as const, false)

const ICON: Record<string, string> = { Verified: '✔', Failed: '✘', Unknown: '·' }

function leaseText(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const m = Math.round((Date.parse(iso) - now) / 60000)
  return m >= 0 ? `lease ${m}m` : 'lease expired'
}

function statusText(s: Snapshot | null): string | undefined {
  if (!s || !s.initialized) return undefined
  if (s.error) return '⚑ agent-flow: unavailable'
  const t = s.ticket
  const verified = t ? t.acceptance.filter(a => a.verdict === 'Verified').length : 0
  const head = t ? `${t.id} · ${t.status}${t.acceptance.length ? ` · AC ${verified}/${t.acceptance.length}` : ''}` : 'no ticket'
  const review = s.counts?.review ? ` · review ${s.counts.review}` : ''
  return `⚑ ${head} · ready ${s.counts?.ready ?? 0}${review}${s.loop?.active ? ' · loop' : ''}`
}

let busy = false

async function cliArgv($: EngineInterface): Promise<string[]> {
  const bin = (await $.env.get('AGENT_FLOW_BIN')) ?? 'agent-flow'
  return bin.split(/\s+/).filter(Boolean)
}

async function refresh($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    const sessionId = await $.session.id()
    const base = await cliArgv($)
    let next: Snapshot
    try {
      const res = await $.process.run([...base, 'snapshot', '--json', '--session', sessionId], { timeoutMs: 10_000 })
      next = res.exitCode === 0 ? (JSON.parse(res.stdout) as Snapshot) : { initialized: true, error: res.stderr.slice(0, 300) || `exit ${res.exitCode}` }
    } catch (err) {
      next = { initialized: true, error: String(err).slice(0, 300) }
    }
    next.at = await $.clock.now()
    const prev = await read($, snap)
    if (prev?.ticket && next.ticket && prev.ticket.id === next.ticket.id && prev.ticket.status !== next.ticket.status) {
      $.ui.toast(`agent-flow: ${next.ticket.id} ${prev.ticket.status} → ${next.ticket.status}`)
    } else if (!prev?.ticket && next.ticket) {
      $.ui.toast(`agent-flow: now on ${next.ticket.id} — ${next.ticket.title}`)
    }
    if (prev?.ticket?.status !== next.ticket?.status) await update($, isBandHidden, () => false)
    await update($, snap, () => next)
    $.ui.status(statusText(next))
  } finally {
    busy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flow-board', description: 'Show the agent-flow ticket pane (current ticket, AC, ready queue)' })
    void refresh($)
    $.clock.every(20_000, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'flow-board' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'agent-flow' })
    return { text: opened.isPlaced ? 'agent-flow pane opened.' : 'agent-flow pane is open where your surface can place it.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Bash') {
      const command = String((e as { input?: { command?: unknown } }).input?.command ?? '')
      if (/\b(agent-flow|af)\b|\bgit\s+commit\b/.test(command)) void refresh($)
    } else if (typeof e.tool === 'string' && e.tool.includes('agent-flow')) {
      void refresh($)
    }
    return ran
  }).catch(($, e, next) => next(e)) // never let the mod get in the way of a tool call

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snap)
    const now = Date.now()
    if (!s) return <Text dimColor>Loading agent-flow…</Text>
    if (!s.initialized) return <Text dimColor>No .agent-flow/ in this repo. Run `agent-flow init`.</Text>
    if (s.error) {
      return (
        <Box flexDirection="column">
          <Text color="error">agent-flow CLI failed</Text>
          <Text dimColor>{s.error}</Text>
          <Button key="retry" label="Retry" onPress={() => refresh($)} />
        </Box>
      )
    }
    const t = s.ticket
    return (
      <Box flexDirection="column">
        {t ? (
          <Box flexDirection="column">
            <Text bold>
              {t.id} · {t.status}
            </Text>
            <Text>{t.title}</Text>
            <Text dimColor>
              {[t.priority, t.owner ?? 'unowned', leaseText(t.lease_until, now), t.rework_count ? `rework ${t.rework_count}` : ''].filter(Boolean).join(' · ')}
            </Text>
            {t.blocked_reason && <Text color="error">blocked: {t.blocked_reason}</Text>}
            {t.acceptance.length > 0 && <Text bold>Acceptance criteria</Text>}
            {t.acceptance.map(a => (
              <Text color={a.verdict === 'Verified' ? 'success' : a.verdict === 'Failed' ? 'error' : undefined} dimColor={a.verdict === 'Unknown'}>
                {ICON[a.verdict] ?? '·'} {a.ac_id} {a.text}
              </Text>
            ))}
            {t.last_handoff && <Text dimColor>handoff: {t.last_handoff}</Text>}
          </Box>
        ) : (
          <Text dimColor>No ticket bound to this branch or session. /agent-flow:flow-next claims one.</Text>
        )}
        <Text bold>Ready next ({s.counts?.ready ?? 0})</Text>
        {(s.ready ?? []).length === 0 && <Text dimColor>queue empty</Text>}
        {(s.ready ?? []).map(r => (
          <Text>
            {r.id} [{r.priority}] {r.title}
          </Text>
        ))}
        <Text dimColor>
          review {s.counts?.review ?? 0} · blocked {s.counts?.blocked ?? 0} · needs human {s.counts?.needs_human ?? 0}
          {s.loop?.active ? ` · loop on (max ${s.loop.max_tickets})` : ''}
        </Text>
        <Box>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (!s || !s.initialized || s.error || (await read($, isBandHidden))) return next(e)
    const t = s.ticket
    let message: string | null = null
    if (t?.status === 'review') message = `${t.id} is in review — a reviewer (not the owner) runs /agent-flow:flow-review`
    else if (t?.status === 'blocked') message = `${t.id} is blocked: ${t.blocked_reason ?? 'see ticket'}`
    else if ((s.counts?.needs_human ?? 0) > 0) message = `${s.counts!.needs_human} agent-flow ticket(s) need a human decision`
    if (!message) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="warning">⚑ {message} </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })
}
