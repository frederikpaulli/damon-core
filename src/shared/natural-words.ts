const fold = (s: string): string => s.normalize('NFKC')

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu
const INVISIBLE = /[​‌⁠﻿­]/g

export function naturalWords(text: string): string {
  let s = fold(text)
  s = s.replace(INVISIBLE, '')
  s = s.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
  s = s.replace(/\s*[—–]\s*/g, ' - ')
  s = s.replace(/[•▪●‣⁃]\s*/g, '- ')
  s = s.replace(EMOJI, '')
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
  s = s.replace(/`([^`\n]*)`/g, '$1')
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
