#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
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
  selector: '[data-testid="stApp"]',
  wakeSleepingApps: true,
  wakeButtonText: 'get this app back up',
  headless: true,
  randomizeUrlOrder: false,
  failOnError: true,
  loop: false
};

const VALID_WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);

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
`);
}

function parseArgs(argv) {
  const parsed = {};
  const urls = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;

    const value = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${name}`);
      }
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
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseUrlList(rawValue) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    const values = JSON.parse(trimmed);
    if (!Array.isArray(values)) {
      throw new Error('URL JSON must be an array');
    }
    return values.map(String).map((url) => url.trim()).filter(Boolean);
  }

  return trimmed.split(/[\n,]+/).map((url) => url.trim()).filter(Boolean);
}

function readEnvConfig(env) {
  const config = {};

  if (env.KEEPALIVE_URLS) {
    config.urls = parseUrlList(env.KEEPALIVE_URLS);
  }
  if (env.KEEPALIVE_INTERVAL_MINUTES) {
    config.intervalMinutes = parseNumberOption('KEEPALIVE_INTERVAL_MINUTES', env.KEEPALIVE_INTERVAL_MINUTES);
  }
  if (env.KEEPALIVE_JITTER_MINUTES) {
    config.jitterMinutes = parseNumberOption('KEEPALIVE_JITTER_MINUTES', env.KEEPALIVE_JITTER_MINUTES);
  }
  if (env.KEEPALIVE_HOLD_SECONDS) {
    config.holdSeconds = parseNumberOption('KEEPALIVE_HOLD_SECONDS', env.KEEPALIVE_HOLD_SECONDS);
  }
  if (env.KEEPALIVE_TIMEOUT_SECONDS) {
    config.timeoutSeconds = parseNumberOption('KEEPALIVE_TIMEOUT_SECONDS', env.KEEPALIVE_TIMEOUT_SECONDS);
  }
  if (env.KEEPALIVE_WAKE_TIMEOUT_SECONDS) {
    config.wakeTimeoutSeconds = parseNumberOption('KEEPALIVE_WAKE_TIMEOUT_SECONDS', env.KEEPALIVE_WAKE_TIMEOUT_SECONDS);
  }
  if (env.KEEPALIVE_WAKE_PROBE_SECONDS) {
    config.wakeProbeSeconds = parseNumberOption('KEEPALIVE_WAKE_PROBE_SECONDS', env.KEEPALIVE_WAKE_PROBE_SECONDS);
  }
  if (env.KEEPALIVE_PER_URL_DELAY_SECONDS) {
    config.perUrlDelaySeconds = parseNumberOption('KEEPALIVE_PER_URL_DELAY_SECONDS', env.KEEPALIVE_PER_URL_DELAY_SECONDS);
  }
  if (env.KEEPALIVE_WAIT_UNTIL) {
    config.waitUntil = env.KEEPALIVE_WAIT_UNTIL;
  }
  if (env.KEEPALIVE_SELECTOR !== undefined) {
    config.selector = env.KEEPALIVE_SELECTOR;
  }
  if (env.KEEPALIVE_WAKE_BUTTON_TEXT !== undefined) {
    config.wakeButtonText = env.KEEPALIVE_WAKE_BUTTON_TEXT;
  }
  if (env.KEEPALIVE_WAKE_SLEEPING_APPS !== undefined) {
    config.wakeSleepingApps = parseBooleanOption('KEEPALIVE_WAKE_SLEEPING_APPS', env.KEEPALIVE_WAKE_SLEEPING_APPS);
  }
  if (env.KEEPALIVE_HEADLESS !== undefined) {
    config.headless = parseBooleanOption('KEEPALIVE_HEADLESS', env.KEEPALIVE_HEADLESS);
  }
  if (env.KEEPALIVE_RANDOMIZE_URLS !== undefined) {
    config.randomizeUrlOrder = parseBooleanOption('KEEPALIVE_RANDOMIZE_URLS', env.KEEPALIVE_RANDOMIZE_URLS);
  }
  if (env.KEEPALIVE_FAIL_ON_ERROR !== undefined) {
    config.failOnError = parseBooleanOption('KEEPALIVE_FAIL_ON_ERROR', env.KEEPALIVE_FAIL_ON_ERROR);
  }
  if (env.KEEPALIVE_LOOP !== undefined) {
    config.loop = parseBooleanOption('KEEPALIVE_LOOP', env.KEEPALIVE_LOOP);
  }

  return config;
}

async function readFileConfig(configPath, isExplicit) {
  try {
    const content = await readFile(configPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT' && !isExplicit) {
      return {};
    }
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

  for (const url of normalized.urls) {
    validateHttpUrl(url);
  }

  if (!VALID_WAIT_UNTIL.has(normalized.waitUntil)) {
    throw new Error(`waitUntil must be one of: ${[...VALID_WAIT_UNTIL].join(', ')}`);
  }

  for (const key of ['intervalMinutes', 'jitterMinutes', 'holdSeconds', 'timeoutSeconds', 'wakeTimeoutSeconds', 'wakeProbeSeconds', 'perUrlDelaySeconds']) {
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  if (maxMinutes <= 0) {
    return 0;
  }
  return Math.floor(Math.random() * maxMinutes * 60 * 1000);
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

async function sleepWithLog(label, ms) {
  if (ms <= 0) {
    return;
  }
  console.log(`${label}: waiting ${formatSeconds(ms)}s`);
  await sleep(ms);
}

async function clickWakeButtonIfPresent(page, rawUrl, config, index, total) {
  if (!config.wakeSleepingApps || !config.wakeButtonText || config.wakeProbeSeconds <= 0) {
    return false;
  }

  const wakeButton = page.getByRole('button', {
    name: new RegExp(escapeRegExp(config.wakeButtonText), 'i')
  }).first();

  try {
    await wakeButton.waitFor({
      state: 'visible',
      timeout: config.wakeProbeSeconds * 1000
    });
  } catch {
    return false;
  }

  console.log(`[${index}/${total}] wake sleeping app ${rawUrl}`);
  await wakeButton.click({
    timeout: Math.min(config.timeoutSeconds, config.wakeTimeoutSeconds) * 1000
  });
  return true;
}

async function visitUrl(browser, rawUrl, config, index, total) {
  const timeoutMs = config.timeoutSeconds * 1000;
  const wakeTimeoutMs = config.wakeTimeoutSeconds * 1000;
  const page = await browser.newPage();
  const startedAt = Date.now();

  try {
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    console.log(`[${index}/${total}] open ${rawUrl}`);
    await page.goto(rawUrl, {
      waitUntil: config.waitUntil,
      timeout: timeoutMs
    });

    const wokeSleepingApp = await clickWakeButtonIfPresent(page, rawUrl, config, index, total);

    if (config.selector) {
      await page.waitForSelector(config.selector, {
        state: 'attached',
        timeout: wokeSleepingApp ? wakeTimeoutMs : timeoutMs
      });
    }

    await sleepWithLog(`[${index}/${total}] hold ${rawUrl}`, config.holdSeconds * 1000);

    console.log(`[${index}/${total}] ok ${rawUrl} (${formatSeconds(Date.now() - startedAt)}s)`);
    return { url: rawUrl, ok: true };
  } catch (error) {
    console.error(`[${index}/${total}] failed ${rawUrl}: ${error.message}`);
    return { url: rawUrl, ok: false, error };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runRound(config) {
  const { chromium } = await import('playwright');
  const urls = config.randomizeUrlOrder ? shuffle(config.urls) : config.urls;
  const browser = await chromium.launch({ headless: config.headless });
  const results = [];

  try {
    for (let index = 0; index < urls.length; index += 1) {
      if (index > 0) {
        await sleepWithLog('between URLs', config.perUrlDelaySeconds * 1000);
      }
      results.push(await visitUrl(browser, urls[index], config, index + 1, urls.length));
    }
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`round done: ${results.length - failures.length}/${results.length} succeeded`);
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const envConfig = readEnvConfig(process.env);
  const configPath = args.configPath ?? process.env.KEEPALIVE_CONFIG ?? 'keepalive.config.json';
  const fileConfig = await readFileConfig(configPath, Boolean(args.configPath ?? process.env.KEEPALIVE_CONFIG));
  const config = normalizeConfig({
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
    ...args
  });

  console.log(`configured URLs: ${config.urls.length}`);
  console.log(`timing: interval=${config.intervalMinutes}m jitter=0-${config.jitterMinutes}m hold=${config.holdSeconds}s timeout=${config.timeoutSeconds}s wakeTimeout=${config.wakeTimeoutSeconds}s`);

  if (!config.loop) {
    await sleepWithLog('startup jitter', randomDelayMs(config.jitterMinutes));
    const failures = await runRound(config);
    if (failures.length > 0 && config.failOnError) {
      process.exitCode = 1;
    }
    return;
  }

  while (true) {
    const failures = await runRound(config);
    if (failures.length > 0 && config.failOnError) {
      console.error(`round had ${failures.length} failed URL(s); continuing because --loop is enabled`);
    }
    const intervalMs = config.intervalMinutes * 60 * 1000;
    await sleepWithLog('next round', intervalMs + randomDelayMs(config.jitterMinutes));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
