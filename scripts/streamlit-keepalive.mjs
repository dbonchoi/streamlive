#!/usr/bin/env node

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_CONFIG = {
  urls: [],
  intervalMinutes: 5,
  jitterMinutes: 3,
  holdSeconds: 30,
  timeoutSeconds: 120,
  wakeTimeoutSeconds: 300,
  wakeProbeSeconds: 8,
  perUrlDelaySeconds: 0,
  waitUntil: 'domcontentloaded',
  selector: '[data-testid="stApp"], [data-testid="stAppViewContainer"], .stApp',
  wakeSleepingApps: true,
  wakeButtonText: 'get this app back up',
  headless: true,
  randomizeUrlOrder: false,
  failOnError: true,
  loop: false,
  // daemon options
  pidFile: '',
  logFile: '',
  // liveness check options
  httpPrecheck: true,
  appReadyTimeoutSeconds: 30,
};

const VALID_WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);

// ── logging ──────────────────────────────────────────────────────────────────

let logStream = null;

function timestamp() {
  return new Date().toISOString();
}

function log(...args) {
  const line = `[${timestamp()}] ${args.join(' ')}`;
  console.log(line);
  logStream?.write(line + '\n');
}

function logError(...args) {
  const line = `[${timestamp()}] ${args.join(' ')}`;
  console.error(line);
  logStream?.write(line + '\n');
}

async function openLogFile(logFile) {
  if (!logFile) return;
  const { createWriteStream } = await import('node:fs');
  logStream = createWriteStream(logFile, { flags: 'a' });
}

// ── help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`Usage: npm run keepalive -- [options]

Options:
  --config <file>                  JSON config path (default: keepalive.config.json)
  --url <url>                      Add one URL, can be used more than once
  --urls <url1,url2>               Override URL list with comma/newline separated values
  --loop                           Run continuously with interval + jitter between rounds
  --interval-minutes <number>      Loop interval in minutes (default: 5)
  --jitter-minutes <number>        Random delay in minutes, 0 disables it (default: 3)
  --hold-seconds <number>          Time to keep each page open after load (default: 30)
  --timeout-seconds <number>       Per navigation/selector timeout (default: 120)
  --wake-timeout-seconds <number>  Timeout after clicking Streamlit wake button (default: 300)
  --wake-probe-seconds <number>    Time to look for the Streamlit wake button (default: 8)
  --per-url-delay-seconds <number> Delay between URLs in one round
  --selector <css>                 Selector to wait for; use empty string to disable
  --wake-button-text <text>        Streamlit sleep-page wake button text
  --no-wake-sleeping-apps          Do not click the Streamlit sleep-page wake button
  --wait-until <state>             load, domcontentloaded, networkidle, or commit
  --headful                        Launch Chromium with UI
  --randomize-url-order            Shuffle URL order each round
  --no-fail-on-error               Log failed URLs but exit 0
  --no-http-precheck               Skip HTTP HEAD precheck before browser visit
  --app-ready-timeout-seconds <n>  Seconds to wait for app to finish loading (default: 30)
  --pid-file <path>                Write PID to file (daemon mode)
  --log-file <path>                Append logs to file
`);
}

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = {};
  const urls = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;

    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${name}`);
      return argv[index];
    };

    switch (name) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '--config':
        parsed.configPath = value();
        break;
      case '--url':
        urls.push(value());
        break;
      case '--urls':
        parsed.urls = parseUrlList(value());
        break;
      case '--loop':
        parsed.loop = true;
        break;
      case '--once':
        parsed.loop = false;
        break;
      case '--interval-minutes':
        parsed.intervalMinutes = parseNumberOption(name, value());
        break;
      case '--jitter-minutes':
        parsed.jitterMinutes = parseNumberOption(name, value());
        break;
      case '--hold-seconds':
        parsed.holdSeconds = parseNumberOption(name, value());
        break;
      case '--timeout-seconds':
        parsed.timeoutSeconds = parseNumberOption(name, value());
        break;
      case '--wake-timeout-seconds':
        parsed.wakeTimeoutSeconds = parseNumberOption(name, value());
        break;
      case '--wake-probe-seconds':
        parsed.wakeProbeSeconds = parseNumberOption(name, value());
        break;
      case '--per-url-delay-seconds':
        parsed.perUrlDelaySeconds = parseNumberOption(name, value());
        break;
      case '--app-ready-timeout-seconds':
        parsed.appReadyTimeoutSeconds = parseNumberOption(name, value());
        break;
      case '--selector':
        parsed.selector = value();
        break;
      case '--wake-button-text':
        parsed.wakeButtonText = value();
        break;
      case '--wake-sleeping-apps':
        parsed.wakeSleepingApps = true;
        break;
      case '--no-wake-sleeping-apps':
        parsed.wakeSleepingApps = false;
        break;
      case '--wait-until':
        parsed.waitUntil = value();
        break;
      case '--headful':
        parsed.headless = false;
        break;
      case '--headless':
        parsed.headless = parseBooleanOption(name, value());
        break;
      case '--randomize-url-order':
        parsed.randomizeUrlOrder = true;
        break;
      case '--fail-on-error':
        parsed.failOnError = true;
        break;
      case '--no-fail-on-error':
        parsed.failOnError = false;
        break;
      case '--http-precheck':
        parsed.httpPrecheck = true;
        break;
      case '--no-http-precheck':
        parsed.httpPrecheck = false;
        break;
      case '--pid-file':
        parsed.pidFile = value();
        break;
      case '--log-file':
        parsed.logFile = value();
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  if (urls.length > 0) {
    parsed.urls = [...(parsed.urls ?? []), ...urls];
  }

  return parsed;
}

function parseNumberOption(name, rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function parseBooleanOption(name, rawValue) {
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function parseUrlList(rawValue) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const values = JSON.parse(trimmed);
    if (!Array.isArray(values)) throw new Error('URL JSON must be an array');
    return values.map(String).map((url) => url.trim()).filter(Boolean);
  }
  return trimmed.split(/[\n,]+/).map((url) => url.trim()).filter(Boolean);
}

// ── env config ────────────────────────────────────────────────────────────────

function readEnvConfig(env) {
  const config = {};
  if (env.KEEPALIVE_URLS) config.urls = parseUrlList(env.KEEPALIVE_URLS);
  if (env.KEEPALIVE_INTERVAL_MINUTES) config.intervalMinutes = parseNumberOption('KEEPALIVE_INTERVAL_MINUTES', env.KEEPALIVE_INTERVAL_MINUTES);
  if (env.KEEPALIVE_JITTER_MINUTES) config.jitterMinutes = parseNumberOption('KEEPALIVE_JITTER_MINUTES', env.KEEPALIVE_JITTER_MINUTES);
  if (env.KEEPALIVE_HOLD_SECONDS) config.holdSeconds = parseNumberOption('KEEPALIVE_HOLD_SECONDS', env.KEEPALIVE_HOLD_SECONDS);
  if (env.KEEPALIVE_TIMEOUT_SECONDS) config.timeoutSeconds = parseNumberOption('KEEPALIVE_TIMEOUT_SECONDS', env.KEEPALIVE_TIMEOUT_SECONDS);
  if (env.KEEPALIVE_WAKE_TIMEOUT_SECONDS) config.wakeTimeoutSeconds = parseNumberOption('KEEPALIVE_WAKE_TIMEOUT_SECONDS', env.KEEPALIVE_WAKE_TIMEOUT_SECONDS);
  if (env.KEEPALIVE_WAKE_PROBE_SECONDS) config.wakeProbeSeconds = parseNumberOption('KEEPALIVE_WAKE_PROBE_SECONDS', env.KEEPALIVE_WAKE_PROBE_SECONDS);
  if (env.KEEPALIVE_PER_URL_DELAY_SECONDS) config.perUrlDelaySeconds = parseNumberOption('KEEPALIVE_PER_URL_DELAY_SECONDS', env.KEEPALIVE_PER_URL_DELAY_SECONDS);
  if (env.KEEPALIVE_APP_READY_TIMEOUT_SECONDS) config.appReadyTimeoutSeconds = parseNumberOption('KEEPALIVE_APP_READY_TIMEOUT_SECONDS', env.KEEPALIVE_APP_READY_TIMEOUT_SECONDS);
  if (env.KEEPALIVE_WAIT_UNTIL) config.waitUntil = env.KEEPALIVE_WAIT_UNTIL;
  if (env.KEEPALIVE_SELECTOR !== undefined) config.selector = env.KEEPALIVE_SELECTOR;
  if (env.KEEPALIVE_WAKE_BUTTON_TEXT !== undefined) config.wakeButtonText = env.KEEPALIVE_WAKE_BUTTON_TEXT;
  if (env.KEEPALIVE_WAKE_SLEEPING_APPS !== undefined) config.wakeSleepingApps = parseBooleanOption('KEEPALIVE_WAKE_SLEEPING_APPS', env.KEEPALIVE_WAKE_SLEEPING_APPS);
  if (env.KEEPALIVE_HEADLESS !== undefined) config.headless = parseBooleanOption('KEEPALIVE_HEADLESS', env.KEEPALIVE_HEADLESS);
  if (env.KEEPALIVE_RANDOMIZE_URLS !== undefined) config.randomizeUrlOrder = parseBooleanOption('KEEPALIVE_RANDOMIZE_URLS', env.KEEPALIVE_RANDOMIZE_URLS);
  if (env.KEEPALIVE_FAIL_ON_ERROR !== undefined) config.failOnError = parseBooleanOption('KEEPALIVE_FAIL_ON_ERROR', env.KEEPALIVE_FAIL_ON_ERROR);
  if (env.KEEPALIVE_LOOP !== undefined) config.loop = parseBooleanOption('KEEPALIVE_LOOP', env.KEEPALIVE_LOOP);
  if (env.KEEPALIVE_HTTP_PRECHECK !== undefined) config.httpPrecheck = parseBooleanOption('KEEPALIVE_HTTP_PRECHECK', env.KEEPALIVE_HTTP_PRECHECK);
  if (env.KEEPALIVE_PID_FILE) config.pidFile = env.KEEPALIVE_PID_FILE;
  if (env.KEEPALIVE_LOG_FILE) config.logFile = env.KEEPALIVE_LOG_FILE;
  return config;
}

// ── file config ───────────────────────────────────────────────────────────────

async function readFileConfig(configPath, isExplicit) {
  try {
    const content = await readFile(configPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT' && !isExplicit) return {};
    throw new Error(`Failed to read config ${configPath}: ${error.message}`);
  }
}

function normalizeConfig(config) {
  const normalized = {
    ...config,
    urls: [...new Set((config.urls ?? []).map((url) => String(url).trim()).filter(Boolean))]
  };

  if (normalized.urls.length === 0) {
    throw new Error('No URLs configured. Set urls in keepalive.config.json or KEEPALIVE_URLS.');
  }

  for (const url of normalized.urls) validateHttpUrl(url);

  if (!VALID_WAIT_UNTIL.has(normalized.waitUntil)) {
    throw new Error(`waitUntil must be one of: ${[...VALID_WAIT_UNTIL].join(', ')}`);
  }

  for (const key of ['intervalMinutes', 'jitterMinutes', 'holdSeconds', 'timeoutSeconds', 'wakeTimeoutSeconds', 'wakeProbeSeconds', 'perUrlDelaySeconds', 'appReadyTimeoutSeconds']) {
    if (!Number.isFinite(Number(normalized[key])) || Number(normalized[key]) < 0) {
      throw new Error(`${key} must be a non-negative number`);
    }
    normalized[key] = Number(normalized[key]);
  }

  normalized.selector = normalized.selector === undefined ? DEFAULT_CONFIG.selector : String(normalized.selector);
  normalized.wakeButtonText = normalized.wakeButtonText === undefined ? DEFAULT_CONFIG.wakeButtonText : String(normalized.wakeButtonText);
  normalized.wakeSleepingApps = Boolean(normalized.wakeSleepingApps);
  normalized.headless = Boolean(normalized.headless);
  normalized.randomizeUrlOrder = Boolean(normalized.randomizeUrlOrder);
  normalized.failOnError = Boolean(normalized.failOnError);
  normalized.loop = Boolean(normalized.loop);
  normalized.httpPrecheck = Boolean(normalized.httpPrecheck);
  normalized.pidFile = normalized.pidFile ? String(normalized.pidFile) : '';
  normalized.logFile = normalized.logFile ? String(normalized.logFile) : '';

  return normalized;
}

function validateHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`URL must use http or https: ${rawUrl}`);
  }
}

// ── utilities ─────────────────────────────────────────────────────────────────

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || String(error?.message ?? '').includes('Timeout');
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function randomDelayMs(maxMinutes) {
  if (maxMinutes <= 0) return 0;
  return Math.floor(Math.random() * maxMinutes * 60 * 1000);
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

async function sleepWithLog(label, ms) {
  if (ms <= 0) return;
  log(`${label}: waiting ${formatSeconds(ms)}s`);
  await sleep(ms);
}

// ── HTTP precheck ─────────────────────────────────────────────────────────────

async function httpPrecheck(rawUrl, timeoutSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(rawUrl, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    return { reachable: true, status: res.status };
  } catch (error) {
    return { reachable: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── liveness detection ────────────────────────────────────────────────────────

function getWakeButtonLocator(page, config) {
  const wakeButtonPattern = new RegExp(escapeRegExp(config.wakeButtonText), 'i');
  const roleButton = page.getByRole('button', { name: wakeButtonPattern });
  const textButton = page.locator('button').filter({ hasText: wakeButtonPattern });
  const roleTextButton = page.locator('[role="button"]').filter({ hasText: wakeButtonPattern });
  return roleButton.or(textButton).or(roleTextButton).first();
}

async function clickWakeButtonIfPresent(page, rawUrl, config, index, total, probeTimeoutMs = config.wakeProbeSeconds * 1000) {
  if (!config.wakeSleepingApps || !config.wakeButtonText || config.wakeProbeSeconds <= 0) return false;

  const wakeButton = getWakeButtonLocator(page, config);
  try {
    await wakeButton.waitFor({ state: 'visible', timeout: probeTimeoutMs });
  } catch {
    return false;
  }

  log(`[${index}/${total}] wake sleeping app ${rawUrl}`);
  await wakeButton.click({ timeout: Math.min(config.timeoutSeconds, config.wakeTimeoutSeconds) * 1000 });
  return true;
}

// Streamlit Community Cloud wraps apps in an <iframe name="streamlitApp">,
// so the app container lives in a child frame, not the main document.
async function findFrameWithSelector(page, selector) {
  for (const frame of page.frames()) {
    try {
      const handle = await frame.$(selector);
      if (handle) return frame;
    } catch {
      // Frame may have detached during navigation; ignore and continue.
    }
  }
  return null;
}

// Wait for the Streamlit app to be truly ready:
// 1. The app container selector must appear (in the main page or any iframe)
// 2. Any active stSpinner / stStatusWidget "running" state must clear
async function waitForAppReady(page, rawUrl, config, index, total) {
  const timeoutMs = config.timeoutSeconds * 1000;
  const wakeTimeoutMs = config.wakeTimeoutSeconds * 1000;
  const appReadyMs = config.appReadyTimeoutSeconds * 1000;

  let wokeSleepingApp = await clickWakeButtonIfPresent(page, rawUrl, config, index, total);
  let deadline = Date.now() + (wokeSleepingApp ? wakeTimeoutMs : timeoutMs);

  // Phase 1: wait for app container to appear in any frame
  let appFrame = null;
  while (Date.now() < deadline) {
    appFrame = await findFrameWithSelector(page, config.selector);
    if (appFrame) break;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const clicked = await clickWakeButtonIfPresent(
      page, rawUrl, config, index, total,
      Math.min(remainingMs, config.wakeProbeSeconds * 1000)
    );
    if (clicked) {
      wokeSleepingApp = true;
      deadline = Date.now() + wakeTimeoutMs;
      continue;
    }

    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }

  if (!appFrame) {
    const title = await page.title().catch(() => '');
    throw new Error(`Timed out waiting for app container at ${page.url()}${title ? ` (title: ${title})` : ''}`);
  }

  // Phase 2: wait for spinners to clear in the same frame as the app container
  if (appReadyMs > 0) {
    const spinnerSelector = '[data-testid="stSpinner"], [data-testid="stStatusWidget"] [aria-label="Running"]';
    const appReadyDeadline = Date.now() + appReadyMs;

    try {
      const spinnerHandle = await appFrame.$(spinnerSelector);
      if (spinnerHandle) {
        log(`[${index}/${total}] app loading, waiting for spinner to clear`);
        await appFrame.waitForSelector(spinnerSelector, {
          state: 'detached',
          timeout: Math.max(0, appReadyDeadline - Date.now()),
        });
      }
    } catch (error) {
      // Spinner timeout is non-fatal: app container is present, just log it
      if (isTimeoutError(error)) {
        log(`[${index}/${total}] warning: spinner still visible after ${config.appReadyTimeoutSeconds}s, proceeding anyway`);
      } else {
        throw error;
      }
    }
  }

  return wokeSleepingApp;
}

// ── visit ─────────────────────────────────────────────────────────────────────

async function visitUrl(browser, rawUrl, config, index, total) {
  const timeoutMs = config.timeoutSeconds * 1000;
  const startedAt = Date.now();

  // HTTP precheck: warn on unreachable hosts but still let the browser try.
  // Some networks block or mangle HEAD requests even when the browser can
  // load the page fine, so a precheck failure is advisory, not fatal.
  if (config.httpPrecheck) {
    const check = await httpPrecheck(rawUrl, Math.min(config.timeoutSeconds, 15));
    if (!check.reachable) {
      log(`[${index}/${total}] precheck warning ${rawUrl}: ${check.error} (continuing with browser)`);
    } else if (check.status >= 500) {
      log(`[${index}/${total}] precheck warning ${rawUrl}: HTTP ${check.status} (continuing with browser)`);
    }
    // 4xx on HEAD is normal for Streamlit (it may redirect or require JS), continue
  }

  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    log(`[${index}/${total}] open ${rawUrl}`);
    await page.goto(rawUrl, { waitUntil: config.waitUntil, timeout: timeoutMs });

    if (config.selector) {
      await waitForAppReady(page, rawUrl, config, index, total);
    }

    await sleepWithLog(`[${index}/${total}] hold ${rawUrl}`, config.holdSeconds * 1000);

    log(`[${index}/${total}] ok ${rawUrl} (${formatSeconds(Date.now() - startedAt)}s)`);
    return { url: rawUrl, ok: true };
  } catch (error) {
    logError(`[${index}/${total}] failed ${rawUrl}: ${error.message}`);
    return { url: rawUrl, ok: false, error };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── round ─────────────────────────────────────────────────────────────────────

async function runRound(config) {
  const { chromium } = await import('playwright');
  const urls = config.randomizeUrlOrder ? shuffle(config.urls) : config.urls;
  const browser = await chromium.launch({ headless: config.headless });
  const results = [];

  try {
    for (let index = 0; index < urls.length; index += 1) {
      if (index > 0) await sleepWithLog('between URLs', config.perUrlDelaySeconds * 1000);
      results.push(await visitUrl(browser, urls[index], config, index + 1, urls.length));
    }
  } finally {
    await browser.close();
  }

  const failures = results.filter((r) => !r.ok);
  log(`round done: ${results.length - failures.length}/${results.length} succeeded`);
  return failures;
}

// ── daemon / PID ──────────────────────────────────────────────────────────────

async function writePidFile(pidFile) {
  if (!pidFile) return;
  await writeFile(pidFile, String(process.pid), 'utf8');
  log(`PID ${process.pid} written to ${pidFile}`);
}

async function removePidFile(pidFile) {
  if (!pidFile || !existsSync(pidFile)) return;
  await unlink(pidFile).catch(() => {});
}

// ── signal handling ───────────────────────────────────────────────────────────

let shuttingDown = false;
let currentSleepAbort = null;

function setupSignals(pidFile) {
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    currentSleepAbort?.abort();
    await removePidFile(pidFile);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // SIGHUP: reload config on next round (Unix only)
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      log('received SIGHUP, config will reload on next round');
    });
  }
}

// Interruptible sleep that respects shutdown signal
async function interruptibleSleep(ms) {
  const controller = new AbortController();
  currentSleepAbort = controller;
  try {
    await sleep(ms, undefined, { signal: controller.signal });
  } catch {
    // aborted by shutdown
  } finally {
    currentSleepAbort = null;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const envConfig = readEnvConfig(process.env);
  const configPath = args.configPath ?? process.env.KEEPALIVE_CONFIG ?? 'keepalive.config.json';
  const fileConfig = await readFileConfig(configPath, Boolean(args.configPath ?? process.env.KEEPALIVE_CONFIG));
  const config = normalizeConfig({ ...DEFAULT_CONFIG, ...fileConfig, ...envConfig, ...args });

  await openLogFile(config.logFile);
  await writePidFile(config.pidFile);
  setupSignals(config.pidFile);

  log(`configured URLs: ${config.urls.length}`);
  log(`timing: interval=${config.intervalMinutes}m jitter=0-${config.jitterMinutes}m hold=${config.holdSeconds}s timeout=${config.timeoutSeconds}s wakeTimeout=${config.wakeTimeoutSeconds}s`);
  log(`liveness: httpPrecheck=${config.httpPrecheck} appReadyTimeout=${config.appReadyTimeoutSeconds}s`);

  if (!config.loop) {
    await sleepWithLog('startup jitter', randomDelayMs(config.jitterMinutes));
    const failures = await runRound(config);
    if (failures.length > 0 && config.failOnError) process.exitCode = 1;
    await removePidFile(config.pidFile);
    return;
  }

  // Loop mode: reload config from file each round so changes take effect without restart
  let roundNumber = 0;
  while (!shuttingDown) {
    roundNumber += 1;
    log(`--- round ${roundNumber} ---`);

    // Reload file config each round (hot reload)
    const freshFileConfig = await readFileConfig(configPath, Boolean(args.configPath ?? process.env.KEEPALIVE_CONFIG));
    const roundConfig = normalizeConfig({ ...DEFAULT_CONFIG, ...freshFileConfig, ...envConfig, ...args });

    const failures = await runRound(roundConfig);
    if (failures.length > 0 && roundConfig.failOnError) {
      logError(`round had ${failures.length} failed URL(s); continuing`);
    }

    if (shuttingDown) break;

    const intervalMs = roundConfig.intervalMinutes * 60 * 1000;
    const jitterMs = randomDelayMs(roundConfig.jitterMinutes);
    await sleepWithLog('next round', intervalMs + jitterMs);
  }

  await removePidFile(config.pidFile);
}

main().catch((error) => {
  logError(error.message);
  process.exitCode = 1;
});
