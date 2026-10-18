import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { extname, basename } from 'node:path'
import type { WorkNeedsStore } from './work-needs-store'

const TYPES: Record<string,string> = {'.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}
export type MediaPreview = { url:string; kind:'video'|'audio'|'pdf'|'image' }
export class MediaPreviews {
  private entries = new Map<string,{resolve:()=>string;type:string;filename:string;expires:number}>()
  private server?: Server
  private starting?: Promise<number>
  private port = 0
  private start(): Promise<number> {
    if (this.starting) return this.starting
    this.starting = new Promise((resolve,reject) => {
      this.server = createServer((req,res) => {
        const entry = this.entries.get(req.url?.slice(1) ?? '')
        if (!entry || entry.expires < Date.now() || !['GET','HEAD'].includes(req.method ?? '')) { res.writeHead(404).end();return }
        try {
          const file = entry.resolve(), stat = statSync(file), size=stat.size
          if (!stat.isFile() || size > 256*1024*1024) throw Error('Unsupported preview size')
          let start=0,end=size-1,status=200
          if (req.headers.range) {
            const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
            if (!m || (!m[1]&&!m[2])) { res.writeHead(416).end();return }
            if (!m[1]) start=Math.max(0,size-Number(m[2]));else start=Number(m[1])
            end=m[1]&&m[2]?Math.min(size-1,Number(m[2])):size-1
            if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size) {res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return}
            status=206
          }
          res.writeHead(status,{'Content-Type':entry.type,'Content-Disposition':`inline; filename*=UTF-8''${entry.filename}`,'Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})})
          if (req.method==='HEAD'||!size) {res.end();return}
          const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res)
        } catch {res.writeHead(404).end()}
      })
      this.server.once('error',reject)
      this.server.listen(0,'127.0.0.1',()=>{this.port=(this.server!.address() as {port:number}).port;this.server!.unref();resolve(this.port)})
    })
    return this.starting
  }
  async open(needs: WorkNeedsStore, file: string): Promise<MediaPreview | null> {
    const type=TYPES[extname(file).toLowerCase()];if(!type)return null
    const target=needs.pathFor(file),stat=statSync(target)
    if(!stat.isFile()||stat.size>256*1024*1024)throw Error('This media exceeds the 256 MB preview limit. Open the original file instead.')
    const port=await this.start()
    for(const [key,e] of this.entries)if(e.expires<Date.now())this.entries.delete(key)
    while(this.entries.size>=128)this.entries.delete(this.entries.keys().next().value!)
    const token=randomBytes(24).toString('hex');this.entries.set(token,{resolve:()=>needs.pathFor(file),type,filename:encodeURIComponent(basename(file)),expires:Date.now()+60*60*1000})
    return {url:`http://127.0.0.1:${port}/${token}`,kind:type.startsWith('video/')?'video':type.startsWith('audio/')?'audio':type==='application/pdf'?'pdf':'image'}
  }
  close():void {this.entries.clear();this.server?.close()}
}
