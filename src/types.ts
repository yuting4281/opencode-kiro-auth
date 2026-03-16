export interface OidcClient {
  clientId: string
  clientSecret: string
}

export interface DeviceAuthResult {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  interval: number
  expiresIn: number
}

export interface TokenResult {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

export interface CompositeRefresh {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export interface AmazonQUserMessage {
  content: string
  userInputMessageContext: {
    envState?: { operatingSystem: string; currentWorkingDirectory: string }
    tools?: AmazonQTool[]
    toolResults?: AmazonQToolResult[]
  }
  origin: string
  modelId?: string
  images?: Array<{ format: string; source: { bytes: string } }>
}

export interface AmazonQTool {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: unknown }
  }
}

export interface AmazonQToolResult {
  toolUseId: string
  content: Array<{ text: string }>
  status: "success" | "error"
}

export interface AmazonQToolUse {
  toolUseId: string
  name: string
  input: unknown
}

export interface AmazonQHistoryMessage {
  userInputMessage?: AmazonQUserMessage
  assistantResponseMessage?: {
    content: string
    messageMetadata?: { conversationId?: string }
    toolUses?: AmazonQToolUse[]
  }
}

export interface AmazonQRequest {
  conversationState: {
    conversationId: string
    history: AmazonQHistoryMessage[]
    currentMessage: {
      userInputMessage: AmazonQUserMessage
    }
    chatTriggerType: "MANUAL"
  }
}

export interface EventStreamMessage {
  headers: Record<string, unknown>
  payload: Uint8Array
}
