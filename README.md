# Streamlit Keepalive

Small Playwright-based keepalive runner for Streamlit Community Cloud apps.

## Configure URLs

Edit `keepalive.config.json`:

```json
{
  "urls": [
    "https://app-one.streamlit.app",
    "https://app-two.streamlit.app"
  ],
  "intervalMinutes": 15,
  "jitterMinutes": 3,
  "holdSeconds": 30,
  "timeoutSeconds": 120,
  "perUrlDelaySeconds": 3,
  "waitUntil": "domcontentloaded",
  "selector": "[data-testid=\"stApp\"]"
}
```

The GitHub workflow runs every 15 minutes. The script then waits a random `0-jitterMinutes` delay before opening every configured URL.

## GitHub variables

You can override selected values without editing the file by adding repository variables:

```text
KEEPALIVE_URLS=https://app-one.streamlit.app,https://app-two.streamlit.app
KEEPALIVE_JITTER_MINUTES=3
KEEPALIVE_HOLD_SECONDS=30
KEEPALIVE_TIMEOUT_SECONDS=120
KEEPALIVE_PER_URL_DELAY_SECONDS=3
```

To change the base GitHub interval, edit the cron in `.github/workflows/keepalive.yml`.

Manual `workflow_dispatch` runs can pass a comma/newline separated `urls` input, which overrides the config file for that run.

## Local run

```bash
npm install
npx playwright install chromium
npm run keepalive
```

For a local long-running process:

```bash
npm run keepalive:loop
```
