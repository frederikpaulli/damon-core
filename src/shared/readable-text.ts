export function readableText(path: string, text: string): { text: string; laidOut: boolean } {
  if (!/\.json$/i.test(path) || text.length <= 20000 || text.slice(0, 20000).includes('\n')) return { text, laidOut: false }
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 1), laidOut: true }
  } catch {
    return { text, laidOut: false }
  }
}
