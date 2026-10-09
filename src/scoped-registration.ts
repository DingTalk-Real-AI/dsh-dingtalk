/** 安装失败时撤销已完成的注册；去重状态应在本函数成功返回后记录。 */
export function registerScoped(registrations: ReadonlyArray<() => () => void>): () => void {
  const disposers: Array<() => void> = []
  try {
    for (const register of registrations) disposers.push(register())
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}
