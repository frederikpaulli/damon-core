export const BLANK_PAGE = 'about:blank'

export interface CameraPage {
  load(url: string): Promise<void>
  attach(): void
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  listen?(): void
}

export async function loadWithStateScript(page: CameraPage, url: string, o: { width: number; height: number; before?: string; scheme?: 'light' | 'dark' }): Promise<void> {
  await page.load(url)
  page.attach()
  await page.send('Page.enable')
  if (o.scheme) await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.scheme }] })
  await page.send('Runtime.enable')
  if (o.before) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: o.before })
  await page.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 2, mobile: o.width < 600 })
  await page.load(BLANK_PAGE)
  page.listen?.()
  await page.load(url)
}
