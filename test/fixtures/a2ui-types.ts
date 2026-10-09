import type { A2uiInteractions } from '../../lib/a2ui.js'
import type { AgentSetup, HostAgent, HostAgentContext } from '../../lib/host.js'

declare const manager: A2uiInteractions
declare const ctx: HostAgentContext
declare const agent: HostAgent
declare const legacy: HostAgentContext & { readonly agent: HostAgent }

manager.install(ctx, agent)
manager.install(legacy)
manager.install(ctx)
// @ts-expect-error 通用宿主 Context 没有 agent 服务；兼容属性只属于 A2UI 输入。
ctx.agent
const setup: AgentSetup = (scope, owner) => {
  manager.install(scope, owner)
  return { commit() {} }
}
const asyncSetup: AgentSetup = async (scope, owner) => {
  manager.install(scope, owner)
}
void setup
void asyncSetup
