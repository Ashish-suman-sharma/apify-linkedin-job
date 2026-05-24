import { Actor, log } from 'apify';
import { createPlaywrightRouter } from 'crawlee';

export const DEFAULT_INPUT = {
  searchUrl: '',
  maxResults: 100,
  cookies: [],
  proxyEnabled: true,
  retryCount: 1,
  requestDelayMin: 0.05,
  requestDelayMax: 0.15,
  headless: true,
};

const SELECTORS = {
  jobCards: [
    '[data-job-id]',
    '.jobs-search-results__list-item',
    '.jobs-search-two-pane__job-card-container',
    '.base-card[data-entity-urn*="jobPosting"]',
    'li:has(a[href*="/jobs/view/"])',
  ],
  jobLinks: [
    'a[href*="/jobs/view/"]',
    'a.base-card__full-link',
    '.job-card-list__title--link',
    '.job-card-container__link',
  ],
  title: [
    '.job-details-jobs-unified-top-card__job-title',
    '.top-card-layout__title',
    'h1',
    '.job-details-jobs-unified-top-card__job-title a',
  ],
  company: [
    '.job-details-jobs-unified-top-card__company-name a',
    '.topcard__org-name-link',
    '.job-details-jobs-unified-top-card__company-name',
    'a[href*="/company/"]',
  ],
  location: [
    '.job-details-jobs-unified-top-card__primary-description-container span',
    '.topcard__flavor--bullet',
    '.job-details-jobs-unified-top-card__bullet',
  ],
  description: [
    '.jobs-description__content',
    '.jobs-box__html-content',
    '.show-more-less-html__markup',
    '#job-details',
  ],
  nextButton: [
    'button[aria-label="View next page"]',
    'button[aria-label*="Next"]',
    '.artdeco-pagination__button--next:not([disabled])',
    'a[aria-label*="Next"]',
  ],
  paginationButtons: [
    'button[aria-label^="Page "]',
    '.artdeco-pagination__indicator button',
    'li[data-test-pagination-page-btn] button',
  ],
  easyApply: [
    'button[aria-label*="Easy Apply"]',
    '.jobs-apply-button',
  ],
  companyWebsite: [
    'a[href*="/company/"][href*="/about"]',
    'a[data-control-name="visit_company_website"]',
  ],
  companyLogo: [
    '.jobs-company__box img',
    '.top-card-layout__entity-image',
    'img[alt*="logo" i]',
  ],
  recruiter: [
    '.hirer-card__hirer-information a',
    '.jobs-poster__name',
    'a[href*="/in/"]',
  ],
};

const FIELD_LABELS = {
  workType: ['Workplace type', 'Work type'],
  employmentType: ['Employment type', 'Job type'],
  experienceLevel: ['Experience level', 'Seniority level'],
  salary: ['Salary', 'Base pay range', 'Compensation'],
  industry: ['Industries', 'Industry'],
  companySize: ['Company size'],
  companyFollowers: ['followers'],
  jobFunctions: ['Job function'],
  seniorityLevel: ['Seniority level'],
  jobCategory: ['Job category'],
  benefits: ['Benefits'],
};

export function normalizeInput(rawInput = {}, defaults = DEFAULT_INPUT) {
  const input = { ...defaults, ...(rawInput || {}) };
  input.maxResults = Math.max(1, Number(input.maxResults || defaults.maxResults));
  input.retryCount = Math.max(0, Number(input.retryCount ?? defaults.retryCount));
  input.requestDelayMin = Math.max(0, Number(input.requestDelayMin ?? defaults.requestDelayMin));
  input.requestDelayMax = Math.max(input.requestDelayMin, Number(input.requestDelayMax ?? defaults.requestDelayMax));
  input.cookies = Array.isArray(input.cookies) ? input.cookies : [];
  input.proxyEnabled = Boolean(input.proxyEnabled);
  input.headless = input.headless !== false;
  return input;
}

export function createRouter({ input, stats, state, requestQueue }) {
  const router = createPlaywrightRouter();

  router.addDefaultHandler(async (context) => {
    const { request, page, session } = context;

    if (state.maxResultsReached) return;

    log.info('Opening URL', {
      url: request.url,
      pageNumber: request.userData.pageNumber,
      retryCount: request.retryCount,
      sessionId: session?.id,
    });

    await randomDelay(input.requestDelayMin, input.requestDelayMax);
    await waitForPageReady(page);
    await detectBlocking(page, session);
    await humanLikeScroll(page);

    stats.pagesVisited += 1;
    log.info(`Page ${request.userData.pageNumber || stats.pagesVisited} loaded`, { url: page.url() });

    const listingLinks = await extractListingLinks(page);
    log.info('Jobs found', { count: listingLinks.length, url: page.url() });

    if (!listingLinks.length) {
      log.warning('Empty page or missing selectors', { url: page.url() });
    }

    for (const listing of listingLinks) {
      if (state.maxResultsReached) break;

      const jobId = listing.jobId || getJobIdFromUrl(listing.url);
      if (!jobId) continue;

      if (state.seenJobIds.has(jobId)) {
        stats.duplicatesRemoved += 1;
        log.debug('Duplicate removed', { jobId, url: listing.url });
        continue;
      }

      state.seenJobIds.add(jobId);

      const details = await scrapeJobDetailsFromCurrentPageOrPopup(page, listing);
      const item = normalizeJobItem({
        ...listing,
        ...details,
        jobId,
        jobUrl: listing.url,
        scrapedAt: new Date().toISOString(),
      });

      await Actor.pushData(item);
      stats.totalJobsScraped += 1;

      if (stats.totalJobsScraped >= input.maxResults) {
        state.maxResultsReached = true;
        log.info('Maximum results reached', { maxResults: input.maxResults });
        break;
      }

      await randomDelay(0.05, 0.15);
    }

    if (!state.maxResultsReached) {
      await enqueueNextPages({
        page,
        requestQueue,
        state,
        currentPageNumber: request.userData.pageNumber || stats.pagesVisited,
        hadJobs: listingLinks.length > 0,
      });
    }
  });

  return router;
}

async function waitForPageReady(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await Promise.race([
    waitForAnySelector(page, SELECTORS.jobCards, 8000),
    page.waitForTimeout(2000),
  ]);
}

async function detectBlocking(page, session) {
  const url = page.url().toLowerCase();
  const title = (await page.title().catch(() => '')).toLowerCase();
  const bodyText = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).toLowerCase();

  const loginDetected = url.includes('/login') || url.includes('/uas/login') || bodyText.includes('sign in to linkedin');
  const captchaDetected = bodyText.includes('captcha') || bodyText.includes('security verification') || title.includes('captcha');
  const blockedDetected = bodyText.includes('unusual activity') || bodyText.includes('temporarily restricted');

  if (captchaDetected) {
    session?.markBad();
    log.warning('CAPTCHA detected. Retrying with a new session.', { url: page.url(), sessionId: session?.id });
    throw new Error('CAPTCHA detected');
  }

  if (loginDetected) {
    session?.markBad();
    log.error('Login redirect detected. Retrying with a new session or authenticated cookies.', { url: page.url(), sessionId: session?.id });
    throw new Error('Login redirect detected');
  }

  if (blockedDetected) {
    session?.markBad();
    log.warning('Blocked request detected. Retrying with a new session.', { url: page.url(), sessionId: session?.id });
    throw new Error('Blocked request detected');
  }
}

async function humanLikeScroll(page) {
  const viewportHeight = page.viewportSize()?.height || 900;
  const scrolls = randomInt(1, 2);

  for (let index = 0; index < scrolls; index += 1) {
    const distance = randomInt(Math.floor(viewportHeight * 0.35), Math.floor(viewportHeight * 0.85));
    await page.mouse.wheel(0, distance);
    await page.waitForTimeout(randomInt(50, 150));
  }
}

async function extractListingLinks(page) {
  return page.evaluate((selectors) => {
    const pickText = (root, selectorList) => {
      for (const selector of selectorList) {
        const element = root.querySelector(selector);
        const text = element?.textContent?.replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      return '';
    };

    const absolutize = (href) => {
      try {
        const url = new URL(href, window.location.origin);
        url.hash = '';
        return url.toString();
      } catch {
        return '';
      }
    };

    const getId = (root, url) => {
      const candidates = [
        root.getAttribute('data-job-id'),
        root.getAttribute('data-occludable-job-id'),
        root.getAttribute('data-entity-urn'),
        url,
      ].filter(Boolean);

      for (const value of candidates) {
        const match = String(value).match(/(?:jobs\/view\/|jobPosting:|currentJobId=|\/)(\d{6,})/);
        if (match) return match[1];
      }
      return '';
    };

    const cards = selectors.jobCards.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const uniqueCards = [...new Set(cards)];

    return uniqueCards
      .map((card) => {
        const link = selectors.jobLinks.map((selector) => card.querySelector(selector)).find(Boolean);
        const url = absolutize(link?.getAttribute('href') || '');
        if (!url) return null;

        return {
          jobId: getId(card, url),
          jobTitle: pickText(card, ['.job-card-list__title', '.base-search-card__title', 'h3', 'a[href*="/jobs/view/"]']),
          companyName: pickText(card, ['.job-card-container__primary-description', '.base-search-card__subtitle', 'h4', 'a[href*="/company/"]']),
          location: pickText(card, ['.job-card-container__metadata-item', '.job-search-card__location']),
          postedDate: pickText(card, ['time', '.job-search-card__listdate', '.job-card-container__listed-time']),
          jobUrl: url,
          url,
          easyApply: Boolean(card.textContent?.toLowerCase().includes('easy apply')),
          remote: Boolean(card.textContent?.toLowerCase().match(/\bremote\b|\bhybrid\b/)),
        };
      })
      .filter(Boolean);
  }, SELECTORS);
}

async function scrapeJobDetailsFromCurrentPageOrPopup(page, listing) {
  let detailPage;
  try {
    detailPage = await page.context().newPage();
    await detailPage.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      DNT: '1',
    });
    await detailPage.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await detectBlocking(detailPage);
    await Promise.race([
      waitForAnySelector(detailPage, SELECTORS.description, 6000),
      detailPage.waitForTimeout(2000),
    ]);
    await humanLikeScroll(detailPage);
    await detailPage.waitForTimeout(randomInt(100, 300));
    return await extractVisibleJobDetails(detailPage);
  } catch (error) {
    log.warning('Failed to extract full job details from listing panel', {
      jobId: listing.jobId,
      url: listing.url,
      error: error.message,
    });
    return {};
  } finally {
    await detailPage?.close().catch(() => {});
  }
}

async function extractVisibleJobDetails(page) {
  return page.evaluate(({ selectors, labels }) => {
    const text = (selectorList) => {
      for (const selector of selectorList) {
        const element = document.querySelector(selector);
        const value = element?.textContent?.replace(/\s+/g, ' ').trim();
        if (value) return value;
      }
      return '';
    };

    const href = (selectorList) => {
      for (const selector of selectorList) {
        const element = document.querySelector(selector);
        const value = element?.getAttribute('href');
        if (value) return new URL(value, window.location.origin).toString();
      }
      return '';
    };

    const image = (selectorList) => {
      for (const selector of selectorList) {
        const element = document.querySelector(selector);
        const value = element?.getAttribute('src');
        if (value) return new URL(value, window.location.origin).toString();
      }
      return '';
    };

    const pageText = document.body.textContent?.replace(/\s+/g, ' ').trim() || '';
    const pageUrl = window.location.href;
    const knownLabels = [
      'Seniority level',
      'Employment type',
      'Job function',
      'Industries',
      'Industry',
      'Experience level',
      'Workplace type',
      'Work type',
      'Job type',
      'Salary',
      'Base pay range',
      'Compensation',
      'Company size',
      'Benefits',
    ];
    
    const getByLabel = (labelCandidates) => {
      for (const label of labelCandidates) {
        const domValue = getDefinitionValue(label);
        if (domValue) return domValue;

        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nextLabels = knownLabels
          .filter((knownLabel) => knownLabel.toLowerCase() !== label.toLowerCase())
          .map((knownLabel) => knownLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        const regex = new RegExp(`${escaped}\\s*[:\\n]?\\s*([\\s\\S]{1,220}?)(?=\\s+(?:${nextLabels})\\b|\\s+Referrals\\b|\\s+Get notified\\b|$)`, 'i');
        const match = pageText.match(regex);
        if (match?.[1]) return cleanField(match[1]);
      }
      return '';
    };

    const description = text(selectors.description);
    const descriptionHtml = document.querySelector(selectors.description[0])?.innerHTML || '';
    const skills = Array.from(document.querySelectorAll('[data-test-skill-pill], .job-details-skill-match-status-list__unmatched-skill, .job-details-skill-match-status-list__matched-skill'))
      .map((element) => element.textContent?.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const companyLinkedinUrl = href(selectors.company);
    const recruiterProfile = href(selectors.recruiter);

    // Extract tracking parameters from URL
    const urlParams = new URL(pageUrl);
    const trackingId = urlParams.searchParams.get('trackingId') || '';
    const refId = urlParams.searchParams.get('refId') || '';

    // Extract workplace types
    const workplaceText = getByLabel(['Workplace type', 'Work type']);
    const workplaceTypes = workplaceText ? [workplaceText] : [];
    
    // Determine if remote allowed
    const isRemote = Boolean(pageText.toLowerCase().match(/\bremote\b/));
    const isHybrid = Boolean(pageText.toLowerCase().match(/\bhybrid\b/));
    const workRemoteAllowed = isRemote || isHybrid;

    // Extract apply method
    const hasEasyApply = Boolean(document.body.textContent?.toLowerCase().includes('easy apply'));
    const applyMethod = hasEasyApply ? 'EasyApply' : 'ComplexOnsiteApply';

    return {
      id: extractJobId(pageUrl),
      jobId: extractJobId(pageUrl),
      trackingId,
      refId,
      link: pageUrl,
      jobUrl: pageUrl,
      jobTitle: text(selectors.title),
      title: text(selectors.title),
      companyName: text(selectors.company),
      companyLinkedinUrl,
      companyWebsite: href(selectors.companyWebsite),
      companyLogo: image(selectors.companyLogo),
      companyDescription: extractSection(pageText, ['About the company', 'About us']),
      companySize: getByLabel(labels.companySize),
      companyFollowers: extractFirstMatch(pageText, /([\d,]+\+?\s+followers?)/i),
      location: text(selectors.location),
      country: extractCountry(text(selectors.location)),
      postedDate: text(selectors.location),
      workType: getByLabel(labels.workType),
      workplaceTypes,
      workRemoteAllowed,
      employmentType: getByLabel(labels.employmentType),
      experienceLevel: getByLabel(labels.experienceLevel),
      seniorityLevel: getByLabel(labels.seniorityLevel),
      jobFunction: getByLabel(labels.jobFunctions),
      jobFunctions: splitList(getByLabel(labels.jobFunctions)),
      jobCategory: getByLabel(labels.jobCategory),
      industry: getByLabel(labels.industry),
      applicantCount: extractFirstMatch(pageText, /(\d+\+?\s+applicants?)/i),
      applicantsCount: extractFirstMatch(pageText, /(\d+)/i),
      salary: getByLabel(labels.salary),
      salaryInsights: {},
      benefits: splitList(getByLabel(labels.benefits)),
      easyApply: hasEasyApply,
      applyMethod,
      jobDescription: description,
      descriptionText: description,
      descriptionHtml,
      skills,
      remote: isRemote || isHybrid,
      jobPosterName: text(selectors.recruiter),
      recruiterName: text(selectors.recruiter),
      jobPosterProfileUrl: recruiterProfile,
      recruiterProfile,
      standardizedTitle: text(selectors.title),
      inputUrl: pageUrl,
    };

    function extractJobId(url) {
      const match = url.match(/(?:jobs\/view\/|currentJobId=|\/)(\d{6,})/);
      return match?.[1] || '';
    }

    function extractCountry(location) {
      const countries = {
        'United States': 'US',
        'India': 'IN',
        'United Kingdom': 'GB',
        'Canada': 'CA',
        'Australia': 'AU',
        'Germany': 'DE',
        'France': 'FR',
        'Singapore': 'SG',
        'UAE': 'AE',
      };
      
      for (const [country, code] of Object.entries(countries)) {
        if (location.toLowerCase().includes(country.toLowerCase())) {
          return code;
        }
      }
      return '';
    }

    function extractFirstMatch(value, regex) {
      const match = value.match(regex);
      return match?.[1]?.trim() || '';
    }

    function splitList(value) {
      return value ? value.split(/,|•|\|/).map((item) => item.trim()).filter(Boolean) : [];
    }

    function cleanField(value) {
      return value.replace(/\s+/g, ' ').replace(/^[:\-]\s*/, '').trim();
    }

    function getDefinitionValue(label) {
      const labelLower = label.toLowerCase();
      const elements = Array.from(document.querySelectorAll('li, div, span, dt, h3'));

      for (const element of elements) {
        const elementText = element.textContent?.replace(/\s+/g, ' ').trim() || '';
        if (!elementText || elementText.toLowerCase() !== labelLower) continue;

        const containers = [
          element.parentElement,
          element.closest('li'),
          element.closest('div'),
        ].filter(Boolean);

        for (const container of containers) {
          const candidate = container.textContent?.replace(/\s+/g, ' ').trim() || '';
          const value = cleanField(candidate.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), ''));
          if (value && value.length <= 180) return value;
        }
      }

      return '';
    }

    function extractSection(value, headings) {
      for (const heading of headings) {
        const index = value.toLowerCase().indexOf(heading.toLowerCase());
        if (index >= 0) return value.slice(index + heading.length, index + heading.length + 1200).trim();
      }
      return '';
    }
  }, { selectors: SELECTORS, labels: FIELD_LABELS });
}

async function enqueueNextPages({ page, requestQueue, state, currentPageNumber, hadJobs }) {
  const nextUrls = await discoverNextPageUrls(page);

  for (const nextUrl of nextUrls) {
    const canonicalUrl = canonicalizeUrl(nextUrl);
    if (state.enqueuedPageUrls.has(canonicalUrl)) continue;

    state.enqueuedPageUrls.add(canonicalUrl);
    await requestQueue.addRequest({
      url: nextUrl,
      uniqueKey: `page:${canonicalUrl}`,
      userData: { label: 'LIST', pageNumber: currentPageNumber + 1 },
    });
    log.info(`Moving to page ${currentPageNumber + 1}`, { url: nextUrl });
    return;
  }

  const infiniteScrollUrl = hadJobs ? await discoverInfiniteScrollUrl(page, state) : '';
  if (infiniteScrollUrl) {
    const canonicalUrl = canonicalizeUrl(infiniteScrollUrl);
    state.enqueuedPageUrls.add(canonicalUrl);
    await requestQueue.addRequest({
      url: infiniteScrollUrl,
      uniqueKey: `page:${canonicalUrl}`,
      userData: { label: 'LIST', pageNumber: currentPageNumber + 1 },
    });
    log.info(`Moving to page ${currentPageNumber + 1}`, { url: infiniteScrollUrl });
  }
}

async function discoverNextPageUrls(page) {
  const urls = await page.evaluate((selectors) => {
    const results = [];
    const absolutize = (href) => {
      try {
        const url = new URL(href, window.location.href);
        url.hash = '';
        return url.toString();
      } catch {
        return '';
      }
    };

    for (const selector of selectors.nextButton) {
      const element = document.querySelector(selector);
      const disabled = element?.disabled || element?.getAttribute('aria-disabled') === 'true';
      if (!element || disabled) continue;

      const href = element.getAttribute('href') || element.closest('a')?.getAttribute('href');
      if (href) results.push(absolutize(href));
    }

    for (const selector of selectors.paginationButtons) {
      for (const button of document.querySelectorAll(selector)) {
        const label = button.getAttribute('aria-label') || button.textContent || '';
        const href = button.getAttribute('href') || button.closest('a')?.getAttribute('href');
        if (href && /page|next|\d+/i.test(label)) results.push(absolutize(href));
      }
    }

    return [...new Set(results.filter(Boolean))];
  }, SELECTORS);

  if (urls.length) return urls;

  const clickedUrl = await clickNextAndGetUrl(page);
  return clickedUrl ? [clickedUrl] : [];
}

async function clickNextAndGetUrl(page) {
  const before = page.url();

  for (const selector of SELECTORS.nextButton) {
    const locator = page.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) continue;

    const disabled = await locator.evaluate((element) => element.disabled || element.getAttribute('aria-disabled') === 'true').catch(() => true);
    if (disabled) continue;

    await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await locator.click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(randomInt(1000, 2500));

    if (page.url() !== before) return page.url();
  }

  return '';
}

async function discoverInfiniteScrollUrl(page, state) {
  const url = new URL(page.url());
  const currentStart = Number(url.searchParams.get('start') || 0);
  const nextStart = currentStart + 25;
  url.searchParams.set('start', String(nextStart));
  url.hash = '';
  const candidate = url.toString();
  return state.enqueuedPageUrls.has(canonicalizeUrl(candidate)) ? '' : candidate;
}

function normalizeJobItem(item) {
  const normalized = {
    id: '',
    jobId: '',
    trackingId: '',
    refId: '',
    link: '',
    jobUrl: '',
    jobTitle: '',
    title: '',
    companyName: '',
    companyLinkedinUrl: '',
    companyWebsite: '',
    companyLogo: '',
    companyDescription: '',
    companySlogan: '',
    companySize: '',
    companyEmployeesCount: '',
    companyFollowers: '',
    location: '',
    country: '',
    companyAddress: {},
    postedDate: '',
    postedAt: '',
    postedAtTimestamp: '',
    expireAt: '',
    workType: '',
    workplaceTypes: [],
    workRemoteAllowed: false,
    employmentType: '',
    seniorityLevel: '',
    experienceLevel: '',
    jobFunction: '',
    jobFunctions: [],
    jobCategory: '',
    industry: '',
    industries: '',
    applicantCount: '',
    applicantsCount: '',
    salary: '',
    salaryInsights: {},
    benefits: [],
    easyApply: false,
    applyMethod: 'OnlineApply',
    jobDescription: '',
    descriptionText: '',
    descriptionHtml: '',
    skills: [],
    remote: false,
    jobPosterName: '',
    recruiterName: '',
    jobPosterTitle: '',
    recruiterProfile: '',
    jobPosterProfileUrl: '',
    jobPosterPhoto: '',
    inputUrl: '',
    standardizedTitle: '',
    scrapedAt: '',
    trackingId: '',
  };

  return { ...normalized, ...removeUndefined(item) };
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

async function waitForAnySelector(page, selectors, timeout) {
  return Promise.any(
    selectors.map((selector) => page.waitForSelector(selector, { timeout, state: 'attached' })),
  ).catch(() => null);
}

function getJobIdFromUrl(url) {
  const match = String(url).match(/(?:jobs\/view\/|currentJobId=)(\d{6,})/);
  return match?.[1] || '';
}

function canonicalizeUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.searchParams.sort();
  return parsed.toString();
}

async function randomDelay(minSeconds, maxSeconds) {
  const min = Number(minSeconds) * 1000;
  const max = Number(maxSeconds) * 1000;
  if (max <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, randomInt(min, max)));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
