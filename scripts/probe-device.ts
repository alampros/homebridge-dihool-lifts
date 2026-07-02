/**
 * Probes a DIHOOL IPS-S2 eWeLink device over LAN.
 *
 * 1. Decrypts mDNS TXT record data
 * 2. Sends encrypted zeroconf/info request
 * 3. Sends encrypted zeroconf/switches query
 *
 * Usage:
 *   npx tsx scripts/probe-device.ts <deviceIp> <deviceId> <lanKey>
 */

import axios from "axios";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { execSync } from "node:child_process";

const [, , deviceIp, deviceId, lanKey] = process.argv;

if (!deviceIp || !deviceId || !lanKey) {
  console.error(
    "Usage: npx tsx scripts/probe-device.ts <deviceIp> <deviceId> <lanKey>",
  );
  process.exit(1);
}

// Derive AES key from lanKey
const aesKey = createHash("md5")
  .update(Buffer.from(lanKey, "utf8"))
  .digest();

function encrypt(plaintext: string): { data: string; iv: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", aesKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    data: encrypted.toString("base64"),
    iv: iv.toString("base64"),
  };
}

function decrypt(ciphertext: string, ivBase64: string): string {
  const iv = Buffer.from(ivBase64, "base64");
  const decipher = createDecipheriv("aes-128-cbc", aesKey, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8").replace(/[\x00-\x1F]+$/g, "");
}

async function sendZeroconf(
  suffix: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const plaintext = JSON.stringify(params);
  const { data, iv } = encrypt(plaintext);

  const payload = {
    deviceid: deviceId,
    data,
    encrypt: true,
    iv,
    selfApikey: "123",
    sequence: Date.now().toString(),
  };

  console.log(`\n── POST /zeroconf/${suffix} ──`);
  console.log(`   Plaintext params: ${plaintext}`);

  try {
    const res = await axios.post(
      `http://${deviceIp}:8081/zeroconf/${suffix}`,
      payload,
      {
        headers: { "Content-Type": "application/json" },
        timeout: 9000,
      },
    );
    console.log(`   Response: ${JSON.stringify(res.data)}`);
    return res.data;
  } catch (err: unknown) {
    const axErr = err as { response?: { status: number; data: unknown }; message: string };
    if (axErr.response) {
      console.log(
        `   HTTP ${axErr.response.status}: ${JSON.stringify(axErr.response.data)}`,
      );
    } else {
      console.log(`   Error: ${axErr.message}`);
    }
    return null;
  }
}

async function decryptMdns(): Promise<void> {
  console.log("══ Decrypting mDNS TXT Record ══\n");

  // Grab mDNS TXT record
  try {
    const raw = execSync(
      `dns-sd -L "eWeLink_${deviceId}" _ewelink._tcp local 2>&1 & sleep 3; kill $! 2>/dev/null; wait 2>/dev/null`,
      { encoding: "utf8", shell: "/bin/bash" },
    );

    // Extract fields
    const ivMatch = raw.match(/iv=(\S+)/);
    const dataFields: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const m = raw.match(new RegExp(`data${i}=(\\S+)`));
      if (m) dataFields.push(m[1]);
    }

    if (!ivMatch || dataFields.length === 0) {
      console.log("  Could not extract mDNS data fields.");
      console.log("  Raw output:", raw);
      return;
    }

    const iv = ivMatch[1];
    const concatenatedData = dataFields.join("");

    console.log(`  IV: ${iv}`);
    console.log(
      `  Encrypted data (${dataFields.length} fields, ${concatenatedData.length} chars)`,
    );

    try {
      const plaintext = decrypt(concatenatedData, iv);
      const parsed = JSON.parse(plaintext);
      console.log(`\n  Decrypted mDNS state:`);
      console.log(JSON.stringify(parsed, null, 4));
    } catch (e: unknown) {
      const err = e as Error;
      console.log(`  Decryption failed: ${err.message}`);
    }
  } catch {
    console.log("  dns-sd command failed. Skipping mDNS decryption.");
  }
}

async function main(): Promise<void> {
  console.log(`Device: ${deviceId} @ ${deviceIp}`);
  console.log(`LAN Key: ${lanKey}`);
  console.log(`AES Key (MD5): ${aesKey.toString("hex")}`);

  // 1. Decrypt mDNS broadcast
  await decryptMdns();

  // 2. Query device info
  await sendZeroconf("info", {});

  // 3. Query current switch state
  await sendZeroconf("switch", {});

  // 4. Query multi-switch state
  await sendZeroconf("switches", {});

  // 5. Try signal strength
  await sendZeroconf("signal_strength", {});
}

main().catch((err) => {
  console.error("\nFatal:", err.message);
  process.exit(1);
});
