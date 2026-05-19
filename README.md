# Streamlit Keepalive

Playwright-based keepalive daemon for Streamlit Community Cloud apps. Runs on any VM with Node.js, self-manages its schedule via `keepalive.config.json`.

## Environment setup

### Install Node.js

**Ubuntu / Debian**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**CentOS / RHEL / Fedora**
```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
```

**macOS**
```bash
brew install node@20
```

**Windows** — download the LTS installer from https://nodejs.org

Verify: `node --version` should print `v20.x.x` or higher.

### Install Playwright's Chromium

```bash
npm install
npx playwright install chromium --with-deps
```

`--with-deps` installs the OS-level libraries Chromium needs (Linux only; safe to omit on macOS/Windows).

## Configure

Edit `keepalive.config.json`:

```json
{
  "urls": [
    "https://your-app.streamlit.app"
  ],
  "intervalMinutes": 15,
  "jitterMinutes": 3,
  "holdSeconds": 60,
  "timeoutSeconds": 120,
  "wakeTimeoutSeconds": 300,
  "wakeProbeSeconds": 8,
  "perUrlDelaySeconds": 5,
  "waitUntil": "domcontentloaded",
  "selector": "[data-testid=\"stApp\"], [data-testid=\"stAppViewContainer\"], .stApp",
  "wakeSleepingApps": true,
  "wakeButtonText": "get this app back up",
  "headless": true,
  "randomizeUrlOrder": false,
  "failOnError": true,
  "httpPrecheck": true,
  "appReadyTimeoutSeconds": 30,
  "pidFile": "keepalive.pid",
  "logFile": "keepalive.log"
}
```

| Field | Default | Description |
|---|---|---|
| `urls` | `[]` | Streamlit app URLs to keep alive |
| `intervalMinutes` | `5` | Wait between rounds |
| `jitterMinutes` | `3` | Random extra delay added to interval (0 to disable) |
| `holdSeconds` | `30` | How long to keep each page open after it loads |
| `timeoutSeconds` | `120` | Per-page navigation/selector timeout |
| `wakeTimeoutSeconds` | `300` | Timeout after clicking the Streamlit wake button |
| `wakeProbeSeconds` | `8` | How long to look for the wake button |
| `perUrlDelaySeconds` | `0` | Delay between URLs in one round |
| `httpPrecheck` | `true` | HEAD request before browser visit; skips unreachable hosts |
| `appReadyTimeoutSeconds` | `30` | Extra wait for spinners to clear after app container appears |
| `pidFile` | `""` | Write PID here (empty = disabled) |
| `logFile` | `""` | Append timestamped logs here (empty = stdout only) |

Config is reloaded from disk at the start of every round — no restart needed after edits.

## Run

**One-shot** (single round, then exit):
```bash
npm run keepalive
```

**Loop** (self-scheduled, foreground):
```bash
npm run keepalive:loop
```

**Daemon** (background, PID + log file from config):
```bash
nohup npm run keepalive:daemon &
```

Stop the daemon:
```bash
kill $(cat keepalive.pid)
```

Tail logs:
```bash
tail -f keepalive.log
```

## Liveness check

Each URL goes through two phases before being counted as alive:

1. **HTTP precheck** — HEAD request to confirm the host is reachable. Skips the browser entirely on network failure or 5xx.
2. **App container** — waits for the Streamlit root element to appear in the DOM. If the sleep page is shown, clicks the wake button and waits up to `wakeTimeoutSeconds`.
3. **Spinner clear** — waits up to `appReadyTimeoutSeconds` for any active `stSpinner` to disappear, confirming the app finished its initial run. Timeout here is non-fatal (logs a warning and continues).

## GitHub Actions

The workflow in `.github/workflows/keepalive.yml` still works for scheduled cloud runs. For VM-based deployments, the workflow is optional — the daemon handles scheduling itself.
