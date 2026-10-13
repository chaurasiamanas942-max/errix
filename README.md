# CodePilot
   

AI coding assistant for VS Code. Streaming chat in a side panel, plus right-click actions: Explain, Refactor, Generate Tests, Fix.

## Setup

1. Press `Ctrl+Shift+P` and run **CodePilot: Set API Key**.
2. Paste your OpenAI (or compatible) API key.
3. Open the CodePilot panel from the activity bar.

## Settings

| Setting | Default | Description |
|---|---|---|
| `codepilot.model` | `gpt-4o-mini` | Model ID to use |
| `codepilot.temperature` | `0.2` | Sampling temperature |
| `codepilot.baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `codepilot.maxContextChars` | `12000` | Max chars of file context |
| `codepilot.systemPrompt` | (empty) | Override default system prompt |

## Commands

- **CodePilot: Focus Chat** — open the panel
- **CodePilot: New Chat** — clear the conversation
- **CodePilot: Explain / Refactor / Generate Tests / Fix** — run an action on the selection
- **CodePilot: Set API Key** / **Clear API Key** — manage credentials

## Keyboard

- `Ctrl+Shift+I` (Windows/Linux) / `Cmd+Shift+I` (Mac) — focus the chat panel
