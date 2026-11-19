/// <reference path="../src/index.d.ts" />
import type { Client } from 'minecraft-protocol'

declare const client: Client
const unsubscribe: () => void = client.addPacketBodyObserver((body, state) => {
  const bytes: Buffer = body
  const parserState: string = state
  bytes.toString(parserState === 'play' ? 'hex' : 'base64')
})
unsubscribe()
// @ts-expect-error Only function observers may be registered.
client.addPacketBodyObserver(null)
// @ts-expect-error The body is a Buffer, not a packet object.
client.addPacketBodyObserver((body: { name: string }) => {})

const writing: boolean | undefined = client.getReceiveDiagnostics().inbound.deserializer?.writing
client.on('receiveListenerError', report => {
  const event: string = report.event
  const error: unknown = report.error
  return void [event, error, writing]
})
