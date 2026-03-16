# opencode-kiro-auth

OpenCode plugin that lets you use Amazon Q / Kiro as a free Claude provider.

Intercepts Anthropic API calls and transparently routes them through Amazon Q, giving you access to Claude models at no cost.

## Install

1. Add the plugin to `~/.config/opencode/package.json`:

```bash
cd ~/.config/opencode && npm install opencode-kiro-auth
```

2. Edit `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kiro-auth"],
  "provider": {
    "kiro": {
      "api": "https://q.us-east-1.amazonaws.com",
      "npm": "@ai-sdk/anthropic",
      "models": {
        "kiro-claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Kiro)",
          "attachment": true,
          "limit": {
            "context": 200000,
            "output": 16384
          }
        },
        "kiro-claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5 (Kiro)",
          "attachment": true,
          "limit": {
            "context": 200000,
            "output": 16384
          }
        }
      }
    }
  }
}
```

## Login

### Personal Account

In OpenCode TUI, use `/connect` and select **Kiro Login**. A browser window will open for you to authorize.

Or via CLI:

```bash
opencode auth login kiro
```

### Enterprise Account (AWS SSO)

Set the `KIRO_START_URL` environment variable before launching OpenCode:

```bash
export KIRO_START_URL="https://your-org.awsapps.com/start"
opencode
```

Then use `/connect` or `opencode auth login kiro` as usual.

> **Tip:** Add the `export` line to your `~/.zshrc` or `~/.bashrc` to persist it.

## How it works

1. The plugin registers a `kiro` auth provider with an OAuth device flow
2. On login, it registers an OIDC client with AWS, starts device authorization, and polls for tokens
3. Access and refresh tokens are stored by OpenCode's credential management
4. A custom `fetch` handler intercepts Anthropic `/v1/messages` API calls and:
   - Converts the request to Amazon Q format
   - Sends it to `https://q.us-east-1.amazonaws.com/`
   - Parses the AWS Event Stream response back into Anthropic SSE format
5. Token refresh is handled automatically when credentials expire

## License

MIT
