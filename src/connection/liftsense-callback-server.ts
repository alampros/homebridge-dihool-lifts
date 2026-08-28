import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { Logging } from 'homebridge'

const CALLBACK_PATH = '/v1/liftsense/motor'
const MAX_BODY_BYTES = 1024

export interface LiftSenseMotorEvent {
  motorChannel1Active: boolean
  motorChannel2Active: boolean
}

interface LiftSenseMotorEventResponse {
  motor_channel_1_active?: unknown
  motor_channel_2_active?: unknown
}

interface CallbackRegistration {
  deviceId: string
  onEvent: (event: LiftSenseMotorEvent) => void
}

export function parseLiftSenseMotorEvent(body: string): LiftSenseMotorEvent {
  const data = JSON.parse(body) as LiftSenseMotorEventResponse
  if (
    typeof data.motor_channel_1_active !== 'boolean' ||
    typeof data.motor_channel_2_active !== 'boolean'
  ) {
    throw new Error('Invalid LiftSense motor callback')
  }
  return {
    motorChannel1Active: data.motor_channel_1_active,
    motorChannel2Active: data.motor_channel_2_active,
  }
}

export class LiftSenseCallbackServer {
  private readonly registrations = new Map<string, CallbackRegistration>()
  private server?: Server

  constructor(
    private readonly port: number,
    private readonly log: Logging,
  ) {}

  register(
    deviceId: string,
    token: string,
    onEvent: (event: LiftSenseMotorEvent) => void,
  ): () => void {
    const existing = this.registrations.get(token)
    if (existing && existing.deviceId !== deviceId) {
      this.log.error(
        'LiftSense callback disabled for %s: each configured lift must use a unique ESP32 API token',
        deviceId,
      )
      return () => {}
    }

    const registration = { deviceId, onEvent }
    this.registrations.set(token, registration)
    return () => {
      if (this.registrations.get(token) === registration) {
        this.registrations.delete(token)
      }
    }
  }

  hasRegistrations(): boolean {
    return this.registrations.size > 0
  }

  listeningPort(): number | undefined {
    const address = this.server?.address()
    return address && typeof address !== 'string' ? address.port : undefined
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => this.handleRequest(request, response))
      const onError = (error: Error) => {
        server.close()
        reject(error)
      }
      server.once('error', onError)
      server.listen(this.port, '0.0.0.0', () => {
        server.off('error', onError)
        server.on('error', (error) => {
          this.log.error('LiftSense callback server error: %s', error.message)
        })
        this.server = server
        this.log.info('LiftSense callback listener ready on port %d', this.port)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'POST' || request.url !== CALLBACK_PATH) {
      this.send(response, 404, 'not found')
      return
    }

    const authorization = request.headers.authorization
    const prefix = 'Bearer '
    if (!authorization?.startsWith(prefix)) {
      this.send(response, 401, 'unauthorized')
      return
    }

    const registration = this.registrations.get(authorization.slice(prefix.length))
    if (!registration) {
      this.send(response, 401, 'unauthorized')
      return
    }

    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        this.send(response, 413, 'payload too large')
        request.destroy()
      }
    })
    request.on('end', () => {
      if (response.headersSent) return
      try {
        registration.onEvent(parseLiftSenseMotorEvent(body))
        response.writeHead(204)
        response.end()
      } catch {
        this.send(response, 400, 'invalid request')
      }
    })
  }

  private send(response: ServerResponse, statusCode: number, message: string): void {
    response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(message)
  }
}
