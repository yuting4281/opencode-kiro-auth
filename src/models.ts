export const MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-opus-4-5-20251101": "claude-opus-4.5",
  "claude-opus-4-6-20260610": "claude-opus-4.5",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4.5",
  "claude-3-5-sonnet-20240620": "claude-sonnet-4.5",
  "claude-sonnet-4": "claude-sonnet-4",
  "claude-sonnet-4.5": "claude-sonnet-4.5",
  "claude-haiku-4.5": "claude-haiku-4.5",
  "claude-opus-4.5": "claude-opus-4.5",
  "claude-sonnet-4.6": "claude-sonnet-4.6",
  "claude-opus-4.6": "claude-opus-4.6",
}

export const DEFAULT_MODEL = "claude-sonnet-4.5"

export function mapModelName(model: string): string {
  return MODEL_MAP[model] ?? DEFAULT_MODEL
}

export const AMAZON_Q_URL = "https://q.us-east-1.amazonaws.com/"

export const AMAZON_Q_HEADERS = {
  "content-type": "application/x-amz-json-1.0",
  "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
  "user-agent": "aws-sdk-rust/1.3.9 ua/2.1 api/codewhispererstreaming/0.1.11582 os/windows lang/rust/1.87.0 md/appVersion-1.19.4 app/AmazonQ-For-CLI",
  "x-amz-user-agent": "aws-sdk-rust/1.3.9 ua/2.1 api/codewhispererstreaming/0.1.11582 os/windows lang/rust/1.87.0 m/F app/AmazonQ-For-CLI",
  "x-amzn-codewhisperer-optout": "false",
  "amz-sdk-request": "attempt=1; max=3",
}
