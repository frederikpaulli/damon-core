import { CONNECTOR_PRESETS, type Connection, type ConnectorPreset } from './connectors'

export type ConnectionNeed = 'sign-in-on-provider-page' | 'api-key-in-connections-screen' | 'account-choice' | 'nothing'

export type ConnectionRequestStatus = 'asked' | 'connected' | 'declined'

export interface ConnectionRequest {
  id: string
  projectId: string
  provider: string
  presetKey?: string
  purpose: string
  needs: ConnectionNeed[]
  status: ConnectionRequestStatus
  at: string
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

export function matchPreset(provider: string, presets: ConnectorPreset[] = CONNECTOR_PRESETS): ConnectorPreset | undefined {
  const asked = norm(provider)
  if (!asked) return undefined
  return (
    presets.find((p) => norm(p.key) === asked || norm(p.name) === asked) ??
    (asked.length >= 3 ? presets.find((p) => norm(p.name).includes(asked) || norm(p.key).includes(asked)) : undefined)
  )
}

export function needsFor(provider: string, presets: ConnectorPreset[] = CONNECTOR_PRESETS): ConnectionNeed[] {
  const preset = matchPreset(provider, presets)
  if (!preset) return ['account-choice']
  if (preset.auth === 'oauth') return ['sign-in-on-provider-page']
  if (preset.auth === 'api-key' || Object.keys(preset.env ?? {}).length > 0) return ['api-key-in-connections-screen']
  return ['nothing']
}

export function needWords(need: ConnectionNeed): string {
  switch (need) {
    case 'sign-in-on-provider-page':
      return "Open Connections, switch it on, and sign in on the service's own page when it opens. Your password stays with them; Damon never sees it."
    case 'api-key-in-connections-screen':
      return 'Open Connections, switch it on, and put the key in the field that appears there. That field is the only place the key goes.'
    case 'account-choice':
      return 'Open Connections and pick the account to use; Damon has no ready-made connection for this, so it is your choice which one. If it asks for a key, that goes in the field there.'
    case 'nothing':
      return 'Open Connections and switch it on. It needs nothing else from you.'
  }
}

export function planConnectionRequest(
  input: { provider: string; purpose: string },
  presets: ConnectorPreset[] = CONNECTOR_PRESETS,
  connections: Pick<Connection, 'name' | 'enabled' | 'preset'>[] = []
): { provider: string; presetKey?: string; providerName: string; needs: ConnectionNeed[]; alreadyConnected: boolean } {
  const preset = matchPreset(input.provider, presets)
  const provider = preset ? preset.key : input.provider.trim()
  const asked = norm(provider)
  const alreadyConnected = connections.some((c) => c.enabled && (preset ? c.preset === preset.key : norm(c.name) === asked || (asked.length >= 3 && norm(c.name).includes(asked))))
  return { provider, presetKey: preset?.key, providerName: preset?.name ?? provider, needs: needsFor(input.provider, presets), alreadyConnected }
}

export function connectCard(request: ConnectionRequest, presets: ConnectorPreset[] = CONNECTOR_PRESETS): { title: string; what: string } {
  const preset = request.presetKey ? presets.find((p) => p.key === request.presetKey) : undefined
  const name = preset?.name ?? request.provider
  const todo = request.needs.map(needWords).join(' ')
  const have = preset?.needs && preset.needs !== 'Nothing.' ? ` Needs: ${preset.needs}` : ''
  return {
    title: `Connect ${name}`,
    what: [
      `What needs you: Damon wants ${name} for ${request.purpose.trim().replace(/[.]+$/, '')}. Only you can connect it.`,
      `What to do: ${todo}${have}`,
      'Then: the figures and the work that were waiting on it pick up by themselves. Nothing is connected until you do this.'
    ].join('\n')
  }
}

export const NOT_YET_CONNECTED = 'Nothing is connected until the owner acts; until then any figure from it shows "Not connected", so do not report a number from it, and never ask the owner to paste a key or a password into the chat.'

export function requestNote(o: { providerName: string; needs: ConnectionNeed[]; alreadyConnected: boolean }): string {
  if (o.alreadyConnected) return `${o.providerName} is already connected and switched on; its tools are in front of you as mcp__ tools. Use it rather than asking again.`
  return `Asked. The owner has a card on their list: "Connect ${o.providerName}". What they must do: ${o.needs.map(needWords).join(' ')} ${NOT_YET_CONNECTED}`
}

export function toolAnswer(result: { id: string; needs: string[]; note: string }): { id: string; needs: string[]; what_the_owner_must_do: string[]; note: string } {
  const known = new Set<string>(['sign-in-on-provider-page', 'api-key-in-connections-screen', 'account-choice', 'nothing'])
  const words = result.needs.map((need) => (known.has(need) ? needWords(need as ConnectionNeed) : need))
  const note = result.note.includes(NOT_YET_CONNECTED) || result.needs.length === 0 ? result.note : `${result.note} ${NOT_YET_CONNECTED}`
  return { id: result.id, needs: result.needs, what_the_owner_must_do: words, note }
}
