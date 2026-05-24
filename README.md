# LinkedIn Jobs Full Scraper

Production-ready Apify Actor using Crawlee, Playwright, and JavaScript to scrape LinkedIn Jobs search result pages.

## Features

- Accepts a user-filtered LinkedIn Jobs search URL
- Scrapes across paginated result pages until `maxResults` is reached
- Uses Apify Dataset for JSON output
- Saves run statistics to the key-value store as `STATISTICS`
- Supports Apify Proxy rotation
- Uses Crawlee session pool with persisted cookies
- Supports optional LinkedIn authentication cookies
- Retries failed requests
- Rotates sessions on blocking, CAPTCHA, login redirects, and failures
- Uses random waits and human-like scrolling
- Removes duplicate jobs by job ID
- Uses selector fallback strategies for resilient extraction

## Input

```json
{
  "searchUrl": "https://www.linkedin.com/jobs/search/?keywords=frontend&location=London",
  "maxResults": 100,
  "cookies": [
    {
      "name": "li_at",
      "value": "xxx"
    }
  ],
  "proxyEnabled": true,
  "retryCount": 3,
  "requestDelayMin": 2,
  "requestDelayMax": 5,
  "headless": true
}
```

## Output

Each scraped job is saved to the default Apify Dataset.

```json
[
  {
    "jobId": "1234567890",
    "jobTitle": "Frontend Engineer",
    "companyName": "Example Company",
    "companyLinkedinUrl": "https://www.linkedin.com/company/example/",
    "companyWebsite": "",
    "jobUrl": "https://www.linkedin.com/jobs/view/1234567890/",
    "location": "London, England, United Kingdom",
    "workType": "Hybrid",
    "employmentType": "Full-time",
    "experienceLevel": "Mid-Senior level",
    "salary": "",
    "jobDescription": "Full job description text...",
    "skills": ["JavaScript", "React"],
    "postedDate": "1 week ago",
    "applicantCount": "25 applicants",
    "industry": "Software Development",
    "companySize": "51-200 employees",
    "companyFollowers": "10,000 followers",
    "companyLogo": "https://media.licdn.com/...",
    "companyDescription": "",
    "recruiterName": "",
    "recruiterProfile": "",
    "jobFunctions": ["Engineering"],
    "seniorityLevel": "Mid-Senior level",
    "jobCategory": "",
    "benefits": [],
    "easyApply": true,
    "remote": true,
    "scrapedAt": "2026-05-24T10:00:00.000Z"
  }
]
```

## Statistics

Statistics are saved to the default key-value store under `STATISTICS`.

```json
{
  "totalJobsScraped": 0,
  "duplicatesRemoved": 0,
  "failedRequests": 0,
  "retryAttempts": 0,
  "executionTime": "0h 0m 0s",
  "pagesVisited": 0
}
```

## Installation

```bash
npm install
```

## Local Testing

Create `storage/key_value_stores/default/INPUT.json`:

```json
{
  "searchUrl": "https://www.linkedin.com/jobs/search/?keywords=frontend&location=London",
  "maxResults": 10,
  "proxyEnabled": false,
  "retryCount": 3,
  "requestDelayMin": 2,
  "requestDelayMax": 5,
  "headless": true
}
```

Run:

```bash
npm start
```

Validate JavaScript syntax:

```bash
npm run lint
```

## Apify Deployment

1. Create a new Actor on Apify.
2. Upload this project or connect the repository.
3. Ensure the Actor uses Node.js 18 or newer.
4. Use the input schema from `input_schema.json`.
5. Run with Apify Proxy enabled for better reliability.

## Authenticated Scraping

Some LinkedIn pages require authentication. Add cookies in the `cookies` input:

```json
[
  {
    "name": "li_at",
    "value": "YOUR_LINKEDIN_LI_AT_COOKIE"
  }
]
```

Cookies are injected into the Playwright browser context for `.linkedin.com`.

## Troubleshooting

### Login Redirect

If logs show `Login redirect detected`, provide valid LinkedIn cookies or reduce scraping speed.

### CAPTCHA

If logs show `CAPTCHA detected`, the Actor marks the current session as bad, retries, and rotates the session. Use Apify Proxy and authenticated cookies.

### Empty Results

LinkedIn changes selectors frequently. The Actor uses multiple fallback selectors, but some heavily personalized pages may still require valid cookies.

### Blocked Requests

Use `proxyEnabled: true`, keep request delays at realistic values, and lower concurrency if needed.

### Missing Fields

LinkedIn does not display all fields on every job. Missing fields are returned as empty strings, empty arrays, or booleans.
