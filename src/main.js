import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { chromium } from 'playwright';
import { createRouter, DEFAULT_INPUT, normalizeInput } from './routes.js';

const startedAt = Date.now();

await Actor.init();

const input = normalizeInput(await Actor.getInput(), DEFAULT_INPUT);

const stats = {
  totalJobsScraped: 0,
  duplicatesRemoved: 0,
  failedRequests: 0,
  retryAttempts: 0,
  executionTime: '',
  pagesVisited: 0,
};

const state = {
  seenJobIds: new Set(),
  enqueuedPageUrls: new Set(),
  maxResultsReached: false,
};

log.info('Actor started', {
  searchUrl: input.searchUrl,
  maxResults: input.maxResults,
  proxyEnabled: input.proxyEnabled,
  retryCount: input.retryCount,
  headless: input.headless,
});

if (!input.searchUrl) {
  throw new Error('Input field "searchUrl" is required.');
}

const proxyConfiguration = input.proxyEnabled
  ? await Actor.createProxyConfiguration({ useApifyProxy: true })
  : undefined;

const requestQueue = await Actor.openRequestQueue();

const queueRequest = {
  url: input.searchUrl,
  uniqueKey: `page:${canonicalizeUrl(input.searchUrl)}`,
  userData: { label: 'LIST', pageNumber: 1 },
};

log.info('Adding initial request to queue', { url: input.searchUrl });
await requestQueue.addRequest(queueRequest);
log.info('Request added to queue successfully');
state.enqueuedPageUrls.add(canonicalizeUrl(input.searchUrl));

const router = createRouter({ input, stats, state, requestQueue });

const crawler = new PlaywrightCrawler({
  requestQueue,
  proxyConfiguration,
  maxRequestRetries: input.retryCount,
  maxConcurrency: 6,
  minConcurrency: 3,
  useSessionPool: true,
  persistCookiesPerSession: true,
  sessionPoolOptions: {
    maxPoolSize: 50,
    sessionOptions: {
      maxUsageCount: 10,
      maxErrorScore: 3,
    },
  },
  launchContext: {
    launcher: chromium,
    launchOptions: {
      headless: input.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    },
  },
  preNavigationHooks: [
    async ({ page, session }, gotoOptions) => {
      gotoOptions.waitUntil = 'domcontentloaded';
      gotoOptions.timeout = 60000;

      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        DNT: '1',
      });

      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      });

      if (input.cookies.length) {
        await injectCookies(page.context(), input.cookies);
        log.debug('Injected LinkedIn cookies into browser context', {
          sessionId: session?.id,
          cookieCount: input.cookies.length,
        });
      }
    },
  ],
  requestHandler: router,
  failedRequestHandler: async ({ request, error }) => {
    stats.failedRequests += 1;
    log.error('Request failed permanently', {
      url: request.url,
      retries: request.retryCount,
      error: error?.message,
    });
  },
  errorHandler: async ({ request, session, error }) => {
    stats.retryAttempts += 1;
    session?.markBad();
    log.warning('Retrying request', {
      url: request.url,
      retry: request.retryCount + 1,
      error: error?.message,
      sessionId: session?.id,
    });
  },
});

try {
  log.info('Crawler about to run...');
  const crawlerStats = await crawler.run();
  log.info('Crawler finished running', crawlerStats);
} catch (crawlerError) {
  log.error('Crawler error', { error: crawlerError.message, stack: crawlerError.stack });
  throw crawlerError;
} finally {
  stats.executionTime = formatDuration(Date.now() - startedAt);
  await Actor.setValue('STATISTICS', stats);
  log.info('Scraping completed', stats);
  await Actor.exit();
}

async function injectCookies(context, cookies) {
  const normalizedCookies = cookies
    .filter((cookie) => cookie?.name && typeof cookie.value === 'string')
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '.linkedin.com',
      path: cookie.path || '/',
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? true,
      sameSite: cookie.sameSite || 'Lax',
      expires: cookie.expires || Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    }));

  if (normalizedCookies.length) {
    await context.addCookies(normalizedCookies);
  }
}

function canonicalizeUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.searchParams.sort();
  return parsed.toString();
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remainingSeconds}s`;
}
