import { randomBytes } from 'node:crypto';

export function generateRandomString(length: number): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}

export const hasProperty = (obj: Record<string, unknown>, prop: string): boolean =>
  Object.hasOwn(obj, prop);

export function parseError(err: unknown, hideStack: string[] = []): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  let toReturn = err.message;
  if (err.stack && err.stack.length > 0 && !hideStack.includes(err.message)) {
    const stack = err.stack.split('\n');
    if (stack[1]) {
      toReturn += stack[1].replace('   ', '');
    }
  }
  return toReturn;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
