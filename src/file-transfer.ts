import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { HostAgent, HostAgentContext, HostToolDefinition, HostToolExecution } from './host.js'
import { FILE_TYPES, IMAGE_TYPES, MAX_MEDIA_BYTES } from './media.js'
import type { MediaTarget, Outbound } from './outbound.js'

interface FileRoute {
  agent: HostAgent
  target: MediaTarget
  cwd: string
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function safeName(name: string): string {
  const basename = name.split(/[\\/]/).at(-1) ?? ''
  let cleaned = ''
  for (const character of basename.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_')) {
    if (Buffer.byteLength(cleaned + character) > 180) break
    cleaned += character
  }
  cleaned = cleaned.replace(/[. ]+$/, '')
  return !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? 'attachment' : cleaned
}

/** 每个机器人独立持有文件通道；模型只提供路径，不提供收件人、账号或凭据。 */
export class FileTransfer {
  private readonly installed = new WeakSet<HostAgentContext>()
  private readonly routes = new Map<string, FileRoute>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly abort = new AbortController()

  constructor(
    private readonly opts: { accountId: string; outbound: Pick<Outbound, 'sendMedia'>; log(line: string): void },
  ) {}

  get signal(): AbortSignal {
    return this.abort.signal
  }

  bindSession(agent: HostAgent, target: MediaTarget, cwd: string): void {
    if (this.abort.signal.aborted) return
    this.routes.set(agent.id, {
      agent,
      target: {
        conversationType: target.conversationType,
        conversationId: target.conversationId,
        senderStaffId: target.senderStaffId,
      },
      cwd,
    })
  }

  install(ctx: HostAgentContext, agent: HostAgent): void {
    if (this.installed.has(ctx)) return
    const disposers: Array<() => void> = []
    try {
      for (const kind of ['file', 'image'] as const) disposers.push(ctx.tools.register(this.definition(kind, agent)))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    this.installed.add(ctx)
  }

  async close(): Promise<void> {
    this.routes.clear()
    this.abort.abort()
    await Promise.allSettled([...this.pending])
  }

  /** 独立随机目录与独占创建避免覆盖；逐层拒绝符号链接，不使用用户名称构造父目录。 */
  async storeInbound(
    cwd: string,
    scopeKey: string,
    name: string,
    data: Uint8Array,
  ): Promise<{ path: string; bytes: number }> {
    if (data.length > MAX_MEDIA_BYTES) throw new Error('file_too_large')
    this.abort.signal.throwIfAborted()
    const root = await realpath(cwd)
    let directory = root
    for (const segment of ['.dsh-dingtalk', 'inbox', hash(this.opts.accountId), hash(scopeKey), randomUUID()]) {
      directory = path.join(directory, segment)
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
        throw new Error('unsafe_inbox')
    }
    const file = path.join(directory, safeName(name))
    const handle = await open(file, 'wx', 0o600)
    try {
      this.abort.signal.throwIfAborted()
      await handle.writeFile(data, { signal: this.abort.signal })
    } catch (error) {
      await handle.close()
      await rm(file, { force: true })
      throw error
    }
    await handle.close()
    return { path: file, bytes: data.length }
  }

  private definition(kind: 'file' | 'image', agent: HostAgent): HostToolDefinition {
    return {
      name: kind === 'file' ? 'send_file' : 'send_image',
      description: `仅在用户要求回传文件或图片时，将当前工作区中的${kind === 'file' ? '文件（xlsx/pdf/zip/rar/doc/docx）' : '图片（jpg/jpeg/png/gif/bmp）'}发回当前钉钉会话。最大 20 MB。path 是相对于工作区或工作区内的绝对路径。接口接受不代表客户端已送达；结果未知时不要自动重发。`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: '工作区内待发送文件的路径' } },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['accepted'] }, processQueryKey: { type: 'string' } },
          required: ['status', 'processQueryKey'],
        },
        render: (_args, value) => [
          { type: 'text', text: `钉钉接口已接受发送，客户端送达尚未验证：${JSON.stringify(value)}` },
        ],
      },
      timeoutMs: 90_000,
      execute: (args, exec) => {
        const task = this.send(kind, agent, args, exec)
        this.pending.add(task)
        void task.finally(() => this.pending.delete(task)).catch(() => undefined)
        return task
      },
    }
  }

  private async send(kind: 'file' | 'image', agent: HostAgent, args: unknown, exec: HostToolExecution) {
    if (exec.agent !== agent) throw new Error('file_agent_mismatch')
    const route = this.routes.get(agent.id)
    if (!route || route.agent !== agent || this.abort.signal.aborted) throw new Error('file_route_unavailable')
    if (
      !args ||
      typeof args !== 'object' ||
      Object.keys(args).length !== 1 ||
      !('path' in args) ||
      typeof args.path !== 'string' ||
      !args.path.trim() ||
      args.path.includes('\0')
    )
      throw new Error('file_invalid_arguments')
    const signal = AbortSignal.any([exec.signal, this.abort.signal])
    signal.throwIfAborted()
    const root = await realpath(route.cwd)
    const requested = path.resolve(root, args.path)
    if (!inside(root, requested)) throw new Error('file_outside_workspace')
    const actual = await realpath(requested)
    if (!inside(root, actual)) throw new Error('file_outside_workspace')
    if (!(await lstat(actual)).isFile()) throw new Error('file_not_regular')
    const name = path.basename(actual)
    const extension = path.extname(name).slice(1).toLowerCase()
    if (!(kind === 'file' ? FILE_TYPES : IMAGE_TYPES).has(extension)) throw new Error('unsupported_file_type')
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let data: Uint8Array
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('file_not_regular')
      if (!stat.size || stat.size > MAX_MEDIA_BYTES) throw new Error('file_too_large_or_empty')
      const chunks: Buffer[] = []
      let size = 0
      while (true) {
        signal.throwIfAborted()
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_MEDIA_BYTES + 1 - size))
        const { bytesRead } = await handle.read(chunk)
        if (!bytesRead) break
        size += bytesRead
        if (size > MAX_MEDIA_BYTES) throw new Error('file_too_large')
        chunks.push(chunk.subarray(0, bytesRead))
      }
      data = new Uint8Array(Buffer.concat(chunks, size))
    } finally {
      await handle.close()
    }
    signal.throwIfAborted()
    return this.opts.outbound.sendMedia(route.target, { kind, name, data }, signal)
  }
}
