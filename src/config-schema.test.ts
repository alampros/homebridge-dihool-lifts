import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface SchemaProperty {
  minLength?: number;
  pattern?: string;
}

interface ConfigSchema {
  strictValidation?: boolean;
  schema: {
    properties: {
      devices: {
        items: {
          required?: string[];
          properties: {
            deviceId: SchemaProperty;
          };
        };
      };
    };
  };
}

const schemaPath = fileURLToPath(new URL('../config.schema.json', import.meta.url));
const configSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as ConfigSchema;
const deviceItemSchema = configSchema.schema.properties.devices.items;

describe('Homebridge config schema', () => {
  it('blocks saving invalid plugin configuration', () => {
    expect(configSchema.strictValidation).toBe(true);
  });

  it('requires every lift entry to have a non-blank device ID', () => {
    expect(deviceItemSchema.required).toContain('deviceId');
    expect(deviceItemSchema.properties.deviceId.minLength).toBe(1);

    const pattern = new RegExp(deviceItemSchema.properties.deviceId.pattern ?? '');
    expect(pattern.test('')).toBe(false);
    expect(pattern.test('   ')).toBe(false);
    expect(pattern.test('100293a98d')).toBe(true);
  });
});
