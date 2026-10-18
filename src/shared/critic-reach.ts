export const CRITIC_TEXT_CEILING = 1024 * 1024

export function readableByCritic(bytes: Buffer): boolean {
  const text = bytes.toString('utf8')
  const round = Buffer.from(text, 'utf8')
  return round.length <= CRITIC_TEXT_CEILING && round.equals(bytes)
}

export function pdfTextReadable(doc: { pagesRead: number; textless: number[]; cut: boolean }): boolean {
  return doc.pagesRead > 0 && doc.textless.length === 0 && !doc.cut
}

const CANNOT_READ = 'Damon cannot read '

export function ownerMustConfirm(file: string): string {
  return (
    CANNOT_READ +
    file.replace(/\\/g, '/') +
    ', so nothing inside it has been checked. Open it yourself and confirm it is the version you want to send.'
  )
}

export function isOwnerConfirmation(challenge: string): boolean {
  return challenge.startsWith(CANNOT_READ)
}

export function confirmationCard(challenge: string): { title: string; what: string; file: string } {
  const file = challenge.slice(CANNOT_READ.length).split(',')[0]!.trim()
  const name = file.split('/').pop() || file
  return {
    file,
    title: `Check ${name} yourself: Damon cannot open it`,
    what:
      `${challenge}\n` +
      `It is on disk at ${file}. Damon cannot read this kind of file, so it has been left out of the check ` +
      `rather than guessed at, and everything else in the package was checked normally.\n` +
      `Done means you have opened it and checked it yourself. After that this package can go out, so do not ` +
      `press it on trust. Send it back asks the team to remake the file instead.`
  }
}

export function criticCardHeading(challenge: string): string {
  const text = challenge.trim()
  const bold = /^\*\*([^*]{3,80}?)\*\*/.exec(text)?.[1]?.replace(/[:.]\s*$/, '').trim()
  if (bold) return bold
  const plain = text.replace(/\*\*/g, '')
  if (plain.length <= 70) return plain
  return plain.slice(0, 70).replace(/\s+\S*$/, '') + '…'
}
