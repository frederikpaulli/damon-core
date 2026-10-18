const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const PICTURE = /\.(?:png|jpe?g|gif|webp)$/i
const OTHER_PHOTO = /\.(?:heic|heif|bmp|tiff?)$/i
const SOUND_VIDEO = /\.(?:mp3|m4a|wav|aac|ogg|flac|mp4|mov|m4v|avi|mkv|webm)$/i
const ARCHIVE = /\.(?:7z|rar|gz|tgz|tar)$/i

export function notTextRefusal(path: string, head: Uint8Array, canView: boolean): string | null {
  if (OLE.every((b, i) => head[i] === b)) return `${path} is an older Microsoft Office file of a kind Damon does not read (Publisher, Visio or Works, say). Ask the owner to save it as .docx, .xlsx, .pptx or PDF, and say what you need from it.`
  if (PICTURE.test(path)) return canView ? `${path} is a picture: look at it with view_picture.` : `${path} is a picture, and this seat is not shown pictures. Say what you needed from it.`
  const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)
  if (utf16 || !head.includes(0)) return null
  if (OTHER_PHOTO.test(path)) return `${path} is a photo in a format Damon does not open (HEIC, BMP or TIFF). Ask the owner for a JPEG or PNG copy.`
  if (SOUND_VIDEO.test(path)) return `${path} is sound or video, which Damon cannot listen to or watch. Ask the owner for a transcript, or for what you need from it in writing.`
  if (ARCHIVE.test(path)) return `${path} is an archive of a kind Damon does not open. Damon opens .zip archives: ask the owner for a .zip of it, or for the file inside it that you need.`
  return `${path} is not text and not a kind of document Damon reads. Say what you needed from it; the owner can give it as PDF or text.`
}

export function decodePlainText(bytes: Buffer): { text: string; note?: string } {
  const note = 'Stored as UTF-16 text; shown as ordinary text. sha256 is of the file as stored.'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), note }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2)
    for (let i = 2; i + 1 < bytes.length; i += 2) { swapped[i - 2] = bytes[i + 1]!; swapped[i - 1] = bytes[i]! }
    return { text: new TextDecoder('utf-16le').decode(swapped), note }
  }
  return { text: bytes.toString('utf8') }
}
