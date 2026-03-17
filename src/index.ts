import type { Plugin, AuthHook, AuthOuathResult, PluginInput } from "@opencode-ai/plugin"
import type { CompositeRefresh } from "./types.js"
import { registerClient, deviceAuthorize, pollToken, refreshAccessToken } from "./auth.js"
import { createCustomFetch } from "./fetch.js"

function encodeComposite(clientId: string, clientSecret: string, refreshToken: string): string {
  const data: CompositeRefresh = { clientId, clientSecret, refreshToken }
  return btoa(JSON.stringify(data))
}

function decodeComposite(encoded: string): CompositeRefresh {
  return JSON.parse(atob(encoded))
}

const plugin: Plugin = async (input: PluginInput) => {
  const sdk = input.client

  const authHook: AuthHook = {
    provider: "kiro",
    loader: async (getAuth) => {
      const auth = await getAuth()

      if (auth.type !== "oauth") {
        throw new Error("Kiro auth requires OAuth. Please re-authenticate.")
      }

      let accessToken = auth.access

      if (auth.expires < Date.now() && auth.refresh) {
        try {
          const composite = decodeComposite(auth.refresh)
          const result = await refreshAccessToken(composite.clientId, composite.clientSecret, composite.refreshToken)
          accessToken = result.accessToken

          const newRefresh = result.refreshToken
            ? encodeComposite(composite.clientId, composite.clientSecret, result.refreshToken)
            : auth.refresh
          const newExpires = result.expiresIn ? Date.now() + result.expiresIn * 1000 : Date.now() + 3600000

          await (sdk.auth as any).set({
            providerID: "kiro",
            auth: {
              type: "oauth",
              access: accessToken,
              refresh: newRefresh,
              expires: newExpires,
            },
          })
        } catch {
          throw new Error("Failed to refresh Kiro token. Please re-authenticate.")
        }
      }

      if (!accessToken) {
        throw new Error("No Kiro access token available. Please authenticate first.")
      }

      return {
        apiKey: "kiro",
        fetch: createCustomFetch(accessToken),
      }
    },
    methods: [
      {
        type: "oauth" as const,
        label: "Kiro Login",
        prompts: [
          {
            type: "text" as const,
            key: "startUrl",
            message: "AWS SSO Start URL (leave empty for default)",
            placeholder: "https://your-org.awsapps.com/start",
          },
        ],
        async authorize(inputs): Promise<AuthOuathResult> {
          const startUrl = inputs?.startUrl || process.env.KIRO_START_URL || undefined

          const client = await registerClient()
          const device = await deviceAuthorize(client.clientId, client.clientSecret, startUrl)

          return {
            url: device.verificationUri,
            instructions: `Code: ${device.userCode}`,
            method: "auto" as const,
            async callback() {
              const result = await pollToken(
                client.clientId,
                client.clientSecret,
                device.deviceCode,
                device.interval,
                device.expiresIn,
              )

              return {
                type: "success" as const,
                access: result.accessToken,
                refresh: result.refreshToken
                  ? encodeComposite(client.clientId, client.clientSecret, result.refreshToken)
                  : "",
                expires: result.expiresIn ? Date.now() + result.expiresIn * 1000 : Date.now() + 3600000,
              }
            },
          }
        },
      },
    ],
  }

  return {
    auth: authHook,
  }
}

export default plugin
