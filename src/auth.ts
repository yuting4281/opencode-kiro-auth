import type { OidcClient, DeviceAuthResult, TokenResult } from "./types.js"

const OIDC_BASE = "https://oidc.us-east-1.amazonaws.com"
const REGISTER_URL = `${OIDC_BASE}/client/register`
const DEVICE_AUTH_URL = `${OIDC_BASE}/device_authorization`
const TOKEN_URL = `${OIDC_BASE}/token`
const DEFAULT_START_URL = "https://view.awsapps.com/start"

const USER_AGENT = "aws-sdk-rust/1.3.9 os/windows lang/rust/1.87.0"
const X_AMZ_USER_AGENT = "aws-sdk-rust/1.3.9 ua/2.1 api/ssooidc/1.88.0 os/windows lang/rust/1.87.0 m/E app/AmazonQ-For-CLI"

function makeHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-amz-user-agent": X_AMZ_USER_AGENT,
    "amz-sdk-request": "attempt=1; max=3",
    "amz-sdk-invocation-id": crypto.randomUUID(),
  }
}

async function postJson(url: string, payload: unknown): Promise<unknown> {
  const resp = await fetch(url, {
    method: "POST",
    headers: makeHeaders(),
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`OIDC error ${resp.status}: ${text}`)
  }
  return resp.json()
}

export async function registerClient(): Promise<OidcClient> {
  const data = (await postJson(REGISTER_URL, {
    clientName: "Amazon Q Developer for command line",
    clientType: "public",
    scopes: [
      "codewhisperer:completions",
      "codewhisperer:analysis",
      "codewhisperer:conversations",
    ],
  })) as { clientId: string; clientSecret: string }
  return { clientId: data.clientId, clientSecret: data.clientSecret }
}

export async function deviceAuthorize(
  clientId: string,
  clientSecret: string,
  startUrl?: string,
): Promise<DeviceAuthResult> {
  const data = (await postJson(DEVICE_AUTH_URL, {
    clientId,
    clientSecret,
    startUrl: startUrl || DEFAULT_START_URL,
  })) as DeviceAuthResult
  return data
}

export async function pollToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  maxTimeoutSec = 300,
): Promise<TokenResult> {
  let pollInterval = Math.max(1, interval) * 1000
  const deadline = Date.now() + Math.min(expiresIn, maxTimeoutSec) * 1000

  while (Date.now() < deadline) {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: makeHeaders(),
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (resp.status === 200) {
      return (await resp.json()) as TokenResult
    }

    if (resp.status === 400) {
      const err = (await resp.json()) as { error?: string }
      if (err.error === "authorization_pending") {
        await new Promise((r) => setTimeout(r, pollInterval))
        continue
      }
      if (err.error === "slow_down") {
        pollInterval += 5000
        await new Promise((r) => setTimeout(r, pollInterval))
        continue
      }
      throw new Error(`OIDC token error: ${JSON.stringify(err)}`)
    }

    const text = await resp.text()
    throw new Error(`OIDC token error ${resp.status}: ${text}`)
  }

  throw new Error("Device authorization timed out")
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResult> {
  const data = (await postJson(TOKEN_URL, {
    grantType: "refresh_token",
    clientId,
    clientSecret,
    refreshToken,
  })) as TokenResult
  return data
}
