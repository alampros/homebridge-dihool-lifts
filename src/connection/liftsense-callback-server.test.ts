import { request } from 'node:http';
import type { Logging } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import {
  LiftSenseCallbackServer,
  parseLiftSenseMotorEvent,
  type LiftSenseMotorEvent,
} from './liftsense-callback-server.js';

function postMotorEvent(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      motor_channel_1_active: true,
      motor_channel_2_active: false,
    });
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/v1/liftsense/motor',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('parseLiftSenseMotorEvent', () => {
  it('parses raw motor channel states', () => {
    expect(parseLiftSenseMotorEvent(JSON.stringify({
      motor_channel_1_active: true,
      motor_channel_2_active: false,
    }))).toEqual({
      motorChannel1Active: true,
      motorChannel2Active: false,
    });
  });

  it('rejects missing or malformed channel states', () => {
    expect(() => parseLiftSenseMotorEvent('{}')).toThrow('Invalid LiftSense motor callback');
    expect(() => parseLiftSenseMotorEvent(JSON.stringify({
      motor_channel_1_active: 'true',
      motor_channel_2_active: false,
    }))).toThrow('Invalid LiftSense motor callback');
  });
});

describe('LiftSenseCallbackServer', () => {
  it('authenticates and dispatches motor events', async () => {
    const log = {
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as Logging;
    const server = new LiftSenseCallbackServer(0, log);
    const events: LiftSenseMotorEvent[] = [];
    server.register('lift-1', 'correct-token', (event) => events.push(event));

    try {
      await server.start();
      const port = server.listeningPort();
      expect(port).toBeTypeOf('number');
      expect(await postMotorEvent(port!, 'wrong-token')).toBe(401);
      expect(await postMotorEvent(port!, 'correct-token')).toBe(204);
      expect(events).toEqual([{
        motorChannel1Active: true,
        motorChannel2Active: false,
      }]);
    } finally {
      await server.stop();
    }
  });
});
