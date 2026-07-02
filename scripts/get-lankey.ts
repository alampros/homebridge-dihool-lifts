/**
 * Fetches the lanKey for all eWeLink devices on your account.
 *
 * Usage:
 *   npx tsx scripts/get-lankey.ts <email> [countryCode] [region]
 *
 * Examples:
 *   npx tsx scripts/get-lankey.ts user@example.com
 *   npx tsx scripts/get-lankey.ts user@example.com +1 us
 *
 * Password is prompted interactively (hidden input).
 * countryCode defaults to +1 (US). region defaults to "us".
 * Valid regions: us, eu, as, cn
 */

import axios from "axios";
import { createHmac, randomBytes } from "node:crypto";
import * as readline from "node:readline";

const APP_ID = "Uw83EKZFxdif7XFXEsrpduz5YyjP7nTl";
const APP_SECRET = "mXLOjea0woSMvK9gw7Fjsy7YlFO4iSu6";

interface LoginResponse {
  error: number;
  msg?: string;
  data: {
    at?: string;
    user?: { apikey: string };
    region?: string;
  };
}

interface DeviceResponse {
  error: number;
  data: {
    thingList: Array<{
      itemType: number;
      itemData: {
        deviceid: string;
        name: string;
        devicekey: string;
        extra?: { uiid: number; model?: string };
        params?: Record<string, unknown>;
      };
    }>;
  };
}

interface FamilyResponse {
  error: number;
  data: {
    familyList: Array<{ id: string; name: string }>;
  };
}

async function login(
  email: string,
  password: string,
  countryCode: string,
  httpHost: string,
): Promise<{ aToken: string; apiKey: string; httpHost: string }> {
  const data: Record<string, string> = { countryCode, password };
  if (email.includes("@")) {
    data.email = email;
  } else {
    data.phoneNumber = email;
  }

  const signature = createHmac("sha256", APP_SECRET)
    .update(JSON.stringify(data))
    .digest("base64");

  const res = await axios.post<LoginResponse>(
    `https://${httpHost}/v2/user/login`,
    data,
    {
      headers: {
        Authorization: `Sign ${signature}`,
        "Content-Type": "application/json",
        "X-CK-Appid": APP_ID,
        "X-CK-Nonce": randomBytes(4).toString("hex"),
      },
    },
  );

  const body = res.data;

  // Region redirect
  if (body.error === 10004 && body.data?.region) {
    const region = body.data.region;
    const newHost =
      region === "cn" ? "cn-apia.coolkit.cn" : `${region}-apia.coolkit.cc`;
    console.log(`  Redirected to region: ${region} (${newHost})`);
    return login(email, password, countryCode, newHost);
  }

  if (body.error !== 0 || !body.data?.at) {
    throw new Error(
      `Login failed: ${body.msg || JSON.stringify(body)} (error ${body.error})`,
    );
  }

  return {
    aToken: body.data.at!,
    apiKey: body.data.user!.apikey,
    httpHost,
  };
}

async function getHomes(
  httpHost: string,
  aToken: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await axios.get<FamilyResponse>(
    `https://${httpHost}/v2/family`,
    {
      headers: {
        Authorization: `Bearer ${aToken}`,
        "Content-Type": "application/json",
        "X-CK-Appid": APP_ID,
        "X-CK-Nonce": randomBytes(4).toString("hex"),
      },
    },
  );

  if (res.data.error !== 0 || !res.data.data?.familyList) {
    throw new Error(`Failed to get homes: ${JSON.stringify(res.data)}`);
  }

  return res.data.data.familyList;
}

async function getDevices(
  httpHost: string,
  aToken: string,
  familyId: string,
): Promise<DeviceResponse["data"]["thingList"]> {
  const res = await axios.get<DeviceResponse>(
    `https://${httpHost}/v2/device/thing`,
    {
      headers: {
        Authorization: `Bearer ${aToken}`,
        "Content-Type": "application/json",
        "X-CK-Appid": APP_ID,
        "X-CK-Nonce": Math.random().toString(36).substring(2, 10),
      },
      params: { num: 0, familyid: familyId },
    },
  );

  if (res.data.error !== 0 || !res.data.data) {
    throw new Error(`Failed to get devices: ${JSON.stringify(res.data)}`);
  }

  return res.data.data.thingList;
}

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Mute output to hide password typing
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean => {
      // Suppress the echoed characters after the prompt has been written
      if (typeof chunk === "string" && chunk === prompt) {
        return origWrite(chunk, ...args as [BufferEncoding?, ((err?: Error) => void)?]);
      }
      // After prompt is shown, suppress echoed input
      return true;
    }) as typeof process.stdout.write;

    rl.question(prompt, (answer) => {
      process.stdout.write = origWrite;
      console.log(); // newline after hidden input
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const [, , email, countryCode = "+1", region = "us"] = process.argv;

  if (!email) {
    console.error(
      "Usage: npx tsx scripts/get-lankey.ts <email> [countryCode] [region]",
    );
    console.error(
      '  Example: npx tsx scripts/get-lankey.ts user@email.com "+1" us',
    );
    process.exit(1);
  }

  const password = await promptPassword("eWeLink password: ");
  if (!password) {
    console.error("Password is required.");
    process.exit(1);
  }

  const httpHost =
    region === "cn" ? "cn-apia.coolkit.cn" : `${region}-apia.coolkit.cc`;

  console.log(`\nLogging in as ${email} (region: ${region})...`);
  const auth = await login(email, password, countryCode, httpHost);
  console.log(`  Logged in. API key: ${auth.apiKey}`);

  console.log(`\nFetching homes...`);
  const homes = await getHomes(auth.httpHost, auth.aToken);

  for (const home of homes) {
    console.log(`\nHome: "${home.name}" (${home.id})`);
    const things = await getDevices(auth.httpHost, auth.aToken, home.id);

    const devices = things.filter(
      (t) => t.itemType === 1 || t.itemType === 2,
    );
    if (devices.length === 0) {
      console.log("  No devices found.");
      continue;
    }

    console.log(`  Found ${devices.length} device(s):\n`);
    for (const thing of devices) {
      const d = thing.itemData;
      const uiid = d.extra?.uiid ?? "?";
      const model = d.extra?.model ?? "unknown";
      console.log(`  ── ${d.name} ──`);
      console.log(`     Device ID:  ${d.deviceid}`);
      console.log(`     UIID:       ${uiid}`);
      console.log(`     Model:      ${model}`);
      console.log(`     lanKey:     ${d.devicekey}`);
      if (d.params) {
        const switchState = (d.params as Record<string, unknown>).switches;
        if (switchState) {
          console.log(`     Switches:   ${JSON.stringify(switchState)}`);
        }
      }
      console.log();
    }
  }
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
