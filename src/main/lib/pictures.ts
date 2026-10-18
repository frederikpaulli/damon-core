import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveInside } from './file-browser'

export const PICTURE_MAX_BYTES = 450 * 1024
export const PICTURE_MAX_SIDE = 1568
export const PICTURES_PER_TURN = 6
export const MANAGER_PICTURES_PER_TURN = 3
export const PICTURE_FILE_MAX_BYTES = 15 * 1024 * 1024
export const PICTURE_MAX_PIXELS = 25_000_000

export interface EncodedPicture { data: Buffer; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; width: number; height: number }
export interface PictureEncoder {
  fit(bytes: Buffer): EncodedPicture | null
  fromPixels(pixels: Uint8ClampedArray, width: number, height: number, channels: 1 | 3 | 4): EncodedPicture | null
}

export function isPictureFile(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(path)
}
export const PASS_THROUGH_PICTURE = /\.(?:webp|gif)$/i
export function isDamonsOwnPicture(path: string): boolean {
  const parts = path.split('/')
  return parts[0] === 'damon-shots' && parts.length >= 2 && parts.length <= 3 && parts.slice(1).every(p => p.length > 0 && p.length <= 160 && p !== '.' && p !== '..' && !/[\\:*?"<>|]/.test(p)) && isPictureFile(path)
}
export async function readDamonsPicture(projectRoot: string, path: string): Promise<Buffer> {
  if (!isDamonsOwnPicture(path)) throw new Error('That is not one of the pictures Damon took.')
  const target = resolveInside(projectRoot, path)
  if (!target) throw new Error('That picture is not inside the project folder.')
  const found = await lstat(target).catch(() => undefined)
  if (!found?.isFile()) throw new Error(`There is no picture at ${path}.`)
  if (found.size > PICTURE_FILE_MAX_BYTES) throw new Error(`${path} is larger than ${PICTURE_FILE_MAX_BYTES / 1048576} MB.`)
  return readFile(target)
}

export function pictureSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.subarray(12, 16).toString('latin1') === 'IHDR') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = bytes.subarray(12, 16).toString('latin1')
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') { const b = bytes.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 } }
    if (kind === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
    return null
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]!
    if (marker === 0xff) { i += 1; continue }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) }
    i += 2 + bytes.readUInt16BE(i + 2)
  }
  return null
}

export function toBgra(pixels: Uint8ClampedArray, width: number, height: number, channels: 1 | 3 | 4): Buffer {
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const r = pixels[j]!, g = channels === 1 ? r : pixels[j + 1]!, b = channels === 1 ? r : pixels[j + 2]!
    out[i * 4] = b; out[i * 4 + 1] = g; out[i * 4 + 2] = r; out[i * 4 + 3] = channels === 4 ? pixels[j + 3]! : 255
  }
  return out
}

export function passThroughPicture(path: string, bytes: Buffer): EncodedPicture | string {
  const mimeType = /\.webp$/i.test(path) ? 'image/webp' : 'image/gif'
  const name = mimeType === 'image/webp' ? 'WebP' : 'GIF'
  const size = pictureSize(bytes)
  if (!size) return `${path} is not a ${name} picture inside, so there is nothing to show.`
  if (bytes.length > PICTURE_MAX_BYTES || Math.max(size.width, size.height) > PICTURE_MAX_SIDE) return `${path} is ${size.width} x ${size.height} px and ${Math.round(bytes.length / 1024)} KB, larger than Damon hands over as it is, and Damon does not make ${name} pictures smaller. Ask the owner for a PNG or JPEG copy.`
  return { data: bytes, mimeType, width: size.width, height: size.height }
}

export const KEPT_PREFIX = 'damon-kept'
export function keptFolder(taskId: string): string { return taskId.replace(/[^A-Za-z0-9_-]/g, '_') }
export function keptPath(path: string): { folder: string; file?: string } | null {
  const parts = path.split('/')
  if (parts[0] !== KEPT_PREFIX || parts.length < 2 || parts.length > 3) return null
  const folder = parts[1]!, file = parts[2]
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(folder)) return null
  if (file === undefined) return { folder }
  if (!file || file.length > 160 || file === '.' || file === '..' || /[\\/:*?"<>|]/.test(file) || !isPictureFile(file)) return null
  return { folder, file }
}
export function keptForModel(kept: string[] | undefined, taskId: string): string[] | undefined {
  if (!kept?.length) return undefined
  return kept.map(abs => `${KEPT_PREFIX}/${keptFolder(taskId)}/${abs.split(/[\\/]/).pop()}`)
}
export async function keptPictures(stateDir: string, folder: string): Promise<string[]> {
  const dir = resolveInside(join(stateDir, 'shots'), folder)
  if (!dir) return []
  return (await readdir(dir).catch(() => [] as string[])).filter(name => isPictureFile(name)).sort().slice(0, 50)
}
export async function readKeptPicture(stateDir: string, folder: string, file: string): Promise<Buffer> {
  const target = resolveInside(join(stateDir, 'shots'), `${folder}/${file}`)
  if (!target) throw new Error('That picture is not among the pictures Damon kept.')
  const found = await lstat(target).catch(() => undefined)
  if (!found?.isFile()) throw new Error(`There is no kept picture ${KEPT_PREFIX}/${folder}/${file}.`)
  if (found.size > PICTURE_FILE_MAX_BYTES) throw new Error(`${KEPT_PREFIX}/${folder}/${file} is larger than ${PICTURE_FILE_MAX_BYTES / 1048576} MB.`)
  return readFile(target)
}
