export interface PendantBrokerStartResult {
  brokerUrl: string
  port: number
}

interface PendantBrokerHostResponse {
  ok?: boolean
  error?: string
  brokerUrl?: string
  port?: number
}

const HOST_API = '/__liencam/pendant-broker'

async function hostRequest(action: 'start' | 'stop'): Promise<PendantBrokerHostResponse> {
  const response = await fetch(`${HOST_API}/${action}`, {
    method: 'POST',
    headers: { 'X-LienCAM-Host': 'pendant' },
  })
  let payload: PendantBrokerHostResponse = {}
  try {
    payload = await response.json() as PendantBrokerHostResponse
  } catch {
    // A non-LienCAM static host normally returns HTML here. Translate that
    // into one useful operator error rather than leaking a JSON parse failure.
  }
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? 'This LienCAM host cannot manage the mobile pendant service.')
  }
  return payload
}

export async function startPendantBroker(): Promise<PendantBrokerStartResult> {
  const payload = await hostRequest('start')
  if (!payload.brokerUrl || typeof payload.port !== 'number') {
    throw new Error('LienCAM started the pendant service but did not return its connection details.')
  }
  return { brokerUrl: payload.brokerUrl, port: payload.port }
}

export async function stopPendantBroker(): Promise<void> {
  await hostRequest('stop')
}
