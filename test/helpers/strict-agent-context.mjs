import { Context } from '@deepseek-ai/cordis'

/** 真正启用 Cordis inject 检查；不存在 agent 服务，也不伪造自有 agent 属性。 */
export function strictAgentContext(register = () => () => {}) {
  const root = new Context()
  root.provide('tools', { register })
  const fiber = root.inject(['tools'], () => {})
  const listeners = new Map()
  const scoped = fiber.ctx
  const ctx = scoped.extend({
    on(name, listener, options) {
      const off = scoped.on(name, listener, options)
      const entries = listeners.get(name) ?? []
      if (options?.prepend) entries.unshift(listener)
      else entries.push(listener)
      listeners.set(name, entries)
      return () => {
        off()
        entries.splice(entries.indexOf(listener), 1)
      }
    },
  })
  return { ctx, root, listeners, dispose: () => root.fiber.dispose() }
}
