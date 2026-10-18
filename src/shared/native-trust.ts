import { z } from 'zod'

export const acceptedNativeBuild = z.object({
  version: z.literal(1),
  provider: z.enum(['claude', 'openai']),
  path: z.string().min(1).max(2000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reportedVersion: z.string().min(1).max(200),
  replacedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  replacedVersion: z.string().max(200),
  acceptedAt: z.string().datetime(),
  acceptedUnder: z.enum(['owner-reviewed-this-build', 'owner-standing-policy']),
  signature: z.enum(['valid-expected-publisher', 'valid-other-publisher', 'invalid', 'unsigned', 'unchecked']).optional(),
  signerSubject: z.string().max(500).optional(),
  meaning: z.literal('the owner accepted this build of the provider program; it is not an independent security review')
}).strict()

export const nativeSigner = z.object({
  status: z.enum(['valid', 'invalid', 'unsigned', 'unchecked']),
  subject: z.string().max(500).optional(),
  thumbprint: z.string().max(64).optional()
}).strict()
export type NativeSigner = z.infer<typeof nativeSigner>

export const NATIVE_PUBLISHERS: Record<'claude' | 'openai', string> = { claude: 'Anthropic, PBC', openai: 'OpenAI OpCo, LLC' }
export function signerCommonName(subject: string | undefined): string | undefined {
  const match = /(?:^|, )CN=(?:"((?:[^"\\]|\\.)*)"|([^,]*))/.exec(subject ?? '')
  return match ? (match[1] ?? match[2])?.replace(/\\(.)/g, '$1').trim() : undefined
}
export function classifySigner(provider: 'claude' | 'openai', signer: NativeSigner | undefined): NonNullable<AcceptedNativeBuild['signature']> {
  if (!signer || signer.status === 'unchecked') return 'unchecked'
  if (signer.status !== 'valid') return signer.status
  return signerCommonName(signer.subject) === NATIVE_PUBLISHERS[provider] ? 'valid-expected-publisher' : 'valid-other-publisher'
}

export const nativeUpdatePolicy = z.object({
  claude: z.boolean(),
  openai: z.boolean(),
  decidedAt: z.string().datetime()
}).strict()
export type NativeUpdatePolicy = z.infer<typeof nativeUpdatePolicy>

export const nativeBuildStates = ['matches-reviewed', 'owner-accepted', 'update-pending-review', 'missing', 'unrecognised'] as const

export const nativeBuildStatus = z.object({
  provider: z.enum(['claude', 'openai']),
  state: z.enum(nativeBuildStates),
  path: z.string().max(2000),
  foundSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  foundVersion: z.string().max(200).optional(),
  reviewedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedVersion: z.string().max(200),
  signature: z.enum(['valid-expected-publisher', 'valid-other-publisher', 'invalid', 'unsigned', 'unchecked']).optional(),
  signerSubject: z.string().max(500).optional(),
  detail: z.string().min(1).max(2000)
}).strict()

export type AcceptedNativeBuild = z.infer<typeof acceptedNativeBuild>
export type NativeBuildStatus = z.infer<typeof nativeBuildStatus>
