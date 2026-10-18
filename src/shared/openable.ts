export const RUNNABLE = [
  '.exe', '.com', '.bat', '.cmd', '.scr', '.pif', '.msi', '.msp', '.msc', '.cpl',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.lnk',
  '.reg', '.jar', '.application', '.gadget', '.inf', '.scf', '.url'
]

export function insideProject(file: string): boolean {
  const f = file.trim()
  if (!f) return false
  if (/^([a-z]:)?[\\/]/i.test(f)) return false
  return !f.split(/[\\/]+/).some((seg) => seg === '..')
}

export function safeToOpen(file: string): boolean {
  const dot = file.lastIndexOf('.')
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  if (dot <= slash + 1) return false
  return !RUNNABLE.includes(file.slice(dot).toLowerCase())
}
