export function extractPackReport(payload, packageName) {
  let candidates = []
  if (Array.isArray(payload)) {
    candidates = payload
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.files)) candidates = [payload]
    else if (packageName && payload[packageName]) candidates = [payload[packageName]]
    else candidates = Object.values(payload)
  }

  const reports = candidates.filter(
    (entry) => entry && Array.isArray(entry.files) && Number.isFinite(entry.unpackedSize),
  )

  if (reports.length !== 1) {
    throw new Error('无法识别 npm pack --json 输出，请检查当前 npm 版本的输出格式')
  }

  return reports[0]
}
