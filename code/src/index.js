require('dotenv').config();
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { processPhoto } = require('./pipeline');
const logger = require('./logger');

// ── Validate required env vars ────────────────────────────────────────────────
const REQUIRED = [
  'OPENAI_API_KEY',
  'WOO_URL',
  'WOO_CONSUMER_KEY',
  'WOO_CONSUMER_SECRET',
  'SMTP_USER',
  'SMTP_PASS',
  'NOTIFY_EMAILS',
  'WP_USERNAME',
  'WP_APP_PASSWORD',
];

const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('\n✗  Missing required environment variables:\n');
  missing.forEach(k => console.error(`   ${k}`));
  console.error('\nCopy .env.example to .env and fill in the values.\n');
  process.exit(1);
}

// ── Setup folders ─────────────────────────────────────────────────────────────
const BASE_INPUT   = path.resolve(process.env.INPUT_FOLDER  || './input');
const OUTPUT_FOLDER = path.resolve(process.env.OUTPUT_FOLDER || './output');
const FILE_SETTLE_MS = parseInt(process.env.FILE_SETTLE_MS || '2000');

const INPUT_FOLDERS = {
  light: path.join(BASE_INPUT, 'regular'),
  heavy: path.join(BASE_INPUT, 'heavy'),
  apron: path.join(BASE_INPUT, 'aprons'),
  mobile: path.join(BASE_INPUT, 'mobile'),
};

const PRICES = {
  light: parseFloat(process.env.PRICE_LIGHT  || 20),
  heavy: parseFloat(process.env.PRICE_HEAVY  || 25),
  apron: parseFloat(process.env.PRICE_APRON  || 20),
  mobile: parseFloat(process.env.PRICE_MOBILE || 15),
};

[...Object.values(INPUT_FOLDERS), OUTPUT_FOLDER, path.join(__dirname, '../logs')].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// ── Queue: process one photo at a time ───────────────────────────────────────
let queue = [];
let processing = false;
const settleTimers = new Map();

async function drainQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const next = queue.shift();
  try {
    await processPhoto(next.filePath, next.forcedType);
  } catch (err) {
    logger.error(`Unexpected error processing ${path.basename(next.filePath)}: ${err.message}`);
  }
  processing = false;
  drainQueue();
}

function enqueue(filePath, forcedType) {
  if (settleTimers.has(filePath)) {
    clearTimeout(settleTimers.get(filePath));
  }
  const timer = setTimeout(() => {
    settleTimers.delete(filePath);
    if (!queue.find(q => q.filePath === filePath)) {
      logger.info(`Queued: ${path.basename(filePath)} (${forcedType} — $${PRICES[forcedType]})`);
      queue.push({ filePath, forcedType });
      drainQueue();
    }
  }, FILE_SETTLE_MS);
  settleTimers.set(filePath, timer);
}

// ── Determine type from folder path ──────────────────────────────────────────
function getForcedType(filePath) {
  if (filePath.includes(`${path.sep}heavy${path.sep}`))   return 'heavy';
  if (filePath.includes(`${path.sep}aprons${path.sep}`))  return 'apron';
  if (filePath.includes(`${path.sep}mobile${path.sep}`))  return 'mobile';
  return 'light';
}

// ── Start watcher ─────────────────────────────────────────────────────────────
const SUPPORTED = /\.(jpg|jpeg|png)$/i;

const watcher = chokidar.watch(Object.values(INPUT_FOLDERS), {
  ignored: [
    /(^|[\/\\])\../,
    /processed/,
    /(^|[\/\\])_/,
  ],
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: FILE_SETTLE_MS,
    pollInterval: 500,
  },
});

watcher
  .on('add', filePath => {
    if (SUPPORTED.test(filePath)) {
      const forcedType = getForcedType(filePath);
      logger.info(`New photo detected: ${path.basename(filePath)} (${forcedType} — $${PRICES[forcedType]})`);
      enqueue(filePath, forcedType);
    }
  })
  .on('error', err => logger.error(`Watcher error: ${err.message}`))
  .on('ready', () => {
    logger.info('═'.repeat(60));
    logger.info('  ArtsyPhartsy Bag Uploader — RUNNING');
    logger.info('═'.repeat(60));
    logger.info(`  input/regular/ → light fabric bags  $${PRICES.light}`);
    logger.info(`  input/heavy/   → heavy fabric bags  $${PRICES.heavy}`);
    logger.info(`  input/aprons/  → aprons             $${PRICES.apron}`);
	logger.info(`  input/mobile/  → mobile             $${PRICES.mobile}`);
    logger.info(`  Output:   ${OUTPUT_FOLDER}`);
    logger.info(`  Notify:   ${process.env.NOTIFY_EMAILS}`);
    logger.info('─'.repeat(60));
    logger.info('  Press Ctrl+C to stop gracefully.');
    logger.info('═'.repeat(60));
  });

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`\nReceived ${signal} — shutting down gracefully...`);
  await watcher.close();
  if (processing) {
    logger.info('Waiting for current photo to finish processing...');
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!processing) { clearInterval(check); resolve(); }
      }, 500);
    });
  }
  if (queue.length > 0) {
    logger.info(`${queue.length} photo(s) still in queue — they will be processed on next start.`);
  }
  logger.info('Shutdown complete. Goodbye!');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('SIGUSR1', () => {
  logger.info(`Status: processing=${processing}, queue=${queue.length} item(s)`);
  if (queue.length > 0) {
    queue.forEach((q, i) => logger.info(`  [${i + 1}] ${path.basename(q.filePath)} (${q.forcedType})`));
  }
});
