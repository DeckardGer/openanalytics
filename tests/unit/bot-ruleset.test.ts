import {
  BOT_RULESET_VERSION,
  BOT_SIGNATURES,
  classifyUserAgent,
  loadPolicy,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Bot filter ruleset v1 (docs snapshot 05, G-005).
 *
 * G-005 fixes the rule — known bot/crawler/headless signatures, plus an empty or
 * absent user agent — and makes the ruleset itself versioned, changeable by an
 * ordinary PR that bumps `BOT_RULESET_VERSION`. What the signatures are is
 * engineering; that bot traffic is neither billed nor stored is not.
 */

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'

describe('bot ruleset v1', () => {
  it('treats a missing or empty user agent as a bot', () => {
    // G-005 states this outright: "empty or absent UA → bot". A real browser always
    // sends one; an omitted header is a script that did not bother.
    for (const value of [undefined, null, '', '   ']) {
      const verdict = classifyUserAgent(value)
      expect(verdict.bot, `expected ${JSON.stringify(value)} to be a bot`).toBe(true)
      expect(verdict.reason).toBe('missing_user_agent')
    }
  })

  it('recognises search and AI crawlers', () => {
    const crawlers = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
      'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'CCBot/2.0 (https://commoncrawl.org/faq/)',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    ]

    for (const userAgent of crawlers) {
      const verdict = classifyUserAgent(userAgent)
      expect(verdict.bot, `expected a bot verdict for ${userAgent}`).toBe(true)
      expect(verdict.reason).toBe('known_bot')
    }
  })

  it('recognises headless browsers and automation drivers', () => {
    const automated = [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Puppeteer',
      'Mozilla/5.0 (X11; Linux x86_64) PlaywrightChromium/1.0',
      'Mozilla/5.0 (compatible; PhantomJS/2.1.1; Safari)',
      'Mozilla/5.0 (Windows NT 10.0) selenium/4.0 webdriver',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome-Lighthouse',
    ]

    for (const userAgent of automated) {
      const verdict = classifyUserAgent(userAgent)
      expect(verdict.bot, `expected a bot verdict for ${userAgent}`).toBe(true)
      expect(verdict.reason).toBe('headless_browser')
    }
  })

  it('recognises HTTP clients and link unfurlers', () => {
    const tools = [
      'curl/8.7.1',
      'Wget/1.21.4',
      'python-requests/2.32.3',
      'Go-http-client/2.0',
      'okhttp/4.12.0',
      'PostmanRuntime/7.43.0',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (compatible; Slackbot-LinkExpanding 1.0; +https://api.slack.com/robots)',
      'Mozilla/5.0 (compatible; TelegramBot (like TwitterBot))',
    ]

    for (const userAgent of tools) {
      expect(classifyUserAgent(userAgent).bot, `expected a bot verdict for ${userAgent}`).toBe(true)
    }
  })

  it('leaves ordinary browsers alone', () => {
    const humans = [
      CHROME,
      IPHONE_SAFARI,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
      'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    ]

    for (const userAgent of humans) {
      const verdict = classifyUserAgent(userAgent)
      expect(verdict.bot, `expected a human verdict for ${userAgent}`).toBe(false)
      expect(verdict.reason).toBeNull()
    }
  })

  it('does not mistake a phone brand ending in "bot" for a crawler', () => {
    // Cubot is an Android handset maker, so the generic `…bot` token would
    // classify a real visitor's phone as a crawler and silently delete their
    // traffic from the customer's analytics. A false positive here is invisible:
    // nobody reports the pageview that never appeared.
    const cubot =
      'Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 40) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
    expect(classifyUserAgent(cubot).bot).toBe(false)
  })

  it('names the signature that matched, and never the user agent itself', () => {
    // The verdict feeds an aggregate security counter (G-005). A counter keyed
    // by the raw user agent would be visitor data in a place nothing redacts.
    const verdict = classifyUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')
    expect(verdict.signature).toBe('googlebot')
    expect(JSON.stringify(verdict)).not.toContain('Mozilla')
  })

  it('stamps every verdict with the ruleset version', () => {
    expect(classifyUserAgent(CHROME).rulesetVersion).toBe(BOT_RULESET_VERSION)
    expect(classifyUserAgent('curl/8.7.1').rulesetVersion).toBe(BOT_RULESET_VERSION)
  })

  it('is deterministic and case-insensitive', () => {
    expect(classifyUserAgent('GOOGLEBOT/2.1')).toEqual(classifyUserAgent('googlebot/2.1'))
    expect(classifyUserAgent(CHROME)).toEqual(classifyUserAgent(CHROME))
  })

  it('keeps every signature name unique, so a counter cannot merge two rules', () => {
    const names = BOT_SIGNATURES.map((signature) => signature.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('refuses a configured ruleset version this build does not ship', () => {
    // The version travels with the security counters. A deployment that could
    // claim v2 while running v1's signatures would make that record a lie, and
    // G-005 puts ruleset changes behind a PR rather than an environment
    // variable for exactly that reason.
    expect(loadPolicy({}).BOT_RULESET_VERSION).toBe(BOT_RULESET_VERSION)
    expect(() => loadPolicy({ BOT_RULESET_VERSION: String(BOT_RULESET_VERSION + 1) })).toThrow()
  })
})
