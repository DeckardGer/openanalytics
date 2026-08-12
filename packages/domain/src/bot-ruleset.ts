/**
 * Bot filter, ruleset v1 (docs snapshot 05, G-005).
 *
 * G-005 fixes the rule and leaves the signatures to engineering: known
 * bot/crawler/headless user-agent signatures, plus an empty or absent user
 * agent, are bots. Bot traffic is not billed and does not enter analytics; it is
 * visible only as an aggregate security counter. JS challenges and IP reputation
 * are explicitly out of v1.
 *
 * The ruleset is versioned. `BOT_RULESET_VERSION` travels with every verdict and
 * with the counters, so a change in what counts as a bot reads as a version
 * change rather than as an unexplained shift in a customer's traffic. Changing
 * the list is an ordinary PR that bumps the version — G-005 says so, and
 * `policy.ts` refuses to start if a deployment claims a version this build does
 * not actually ship.
 *
 * Two properties this module exists to keep:
 *
 * - **A false positive is invisible.** A misclassified visitor does not appear
 *   in the customer's dashboard and nobody reports the pageview that never
 *   arrived. So the generic `…bot` token carries an explicit exception list, and
 *   signatures are anchored tokens rather than loose substrings.
 * - **The verdict carries no visitor data.** It names the signature that
 *   matched, never the user agent that matched it, because the counter it feeds
 *   is aggregate and lives outside the event pipeline's redaction.
 */

/** Bumped by PR whenever `BOT_SIGNATURES` changes (G-005). */
export const BOT_RULESET_VERSION = 1

export type BotReason = 'missing_user_agent' | 'known_bot' | 'headless_browser'

export interface BotSignature {
  /** Stable counter label. Never the matched text. */
  readonly name: string
  readonly pattern: RegExp
  readonly reason: Exclude<BotReason, 'missing_user_agent'>
}

/**
 * User agents that contain a bot-shaped token but belong to real visitors.
 *
 * `CUBOT` is an Android handset brand and appears in ordinary mobile user
 * agents. Without this exception the generic `…bot` rule below would delete
 * those visitors from every customer's analytics.
 */
const NOT_A_BOT = /\bcubot\b|\babbott\b/i

const signature = (
  name: string,
  pattern: RegExp,
  reason: BotSignature['reason'] = 'known_bot',
): BotSignature => ({ name, pattern, reason })

/**
 * Ruleset v1.
 *
 * Ordered: a named crawler is reported under its own name rather than under the
 * generic token, so the security counter says which crawler.
 */
export const BOT_SIGNATURES: readonly BotSignature[] = [
  // Search engine and SEO crawlers.
  signature('googlebot', /googlebot|google-inspectiontool|storebot-google/i),
  signature('google-extended', /google-extended|googleother/i),
  signature('bingbot', /bingbot|adidxbot|msnbot/i),
  signature('applebot', /applebot/i),
  signature('duckduckbot', /duckduckbot|duckduckgo-favicons-bot/i),
  signature('yandexbot', /yandex(bot|images|video|mobilebot)/i),
  signature('baiduspider', /baiduspider/i),
  signature('sogou', /sogou (web|inst) spider/i),
  signature('seznambot', /seznambot/i),
  signature('petalbot', /petalbot|aspiegelbot/i),
  signature('yahoo-slurp', /\bslurp\b/i),
  signature('ahrefsbot', /ahrefsbot|ahrefssiteaudit/i),
  signature('semrushbot', /semrushbot|siteauditbot/i),
  signature('mj12bot', /mj12bot|majestic/i),
  signature('dotbot', /\bdotbot\b/i),
  signature('bytespider', /bytespider|bytedance/i),
  signature('amazonbot', /amazonbot/i),
  signature('archive-org', /ia_archiver|archive\.org_bot/i),

  // AI crawlers and assistants.
  signature('gptbot', /gptbot|oai-searchbot|chatgpt-user/i),
  signature('claudebot', /claudebot|claude-web|anthropic-ai/i),
  signature('perplexitybot', /perplexitybot|perplexity-user/i),
  signature('ccbot', /\bccbot\b/i),
  signature('meta-ai', /meta-externalagent|facebookbot/i),
  signature('applebot-extended', /applebot-extended/i),

  // Link unfurlers and social previews. Not malicious, but not a visitor either
  // — every share of a page would otherwise register as a pageview.
  signature('facebookexternalhit', /facebookexternalhit|facebookcatalog/i),
  signature('twitterbot', /twitterbot/i),
  signature('slackbot', /slackbot|slack-imgproxy/i),
  signature('discordbot', /discordbot/i),
  signature('telegrambot', /telegrambot/i),
  signature('whatsapp', /\bwhatsapp\b/i),
  signature('linkedinbot', /linkedinbot/i),
  signature('pinterest', /pinterest(bot|\/)/i),
  signature('redditbot', /redditbot/i),
  signature('embedly', /embedly|quora link preview|skypeuripreview|vkshare/i),

  // Uptime and performance monitors.
  signature('uptime-monitor', /pingdom|uptimerobot|statuscake|site24x7|newrelicpinger|datadog/i),
  signature('pagespeed', /gtmetrix|pagespeed|webpagetest|pingdompagespeed/i),

  // Headless browsers and automation drivers.
  signature('headless-chrome', /headlesschrome|headless_chrome/i, 'headless_browser'),
  signature('phantomjs', /phantomjs|slimerjs|htmlunit/i, 'headless_browser'),
  signature('puppeteer', /puppeteer/i, 'headless_browser'),
  signature('playwright', /playwright/i, 'headless_browser'),
  signature('selenium', /selenium|webdriver|chromedriver/i, 'headless_browser'),
  signature('cypress', /cypress|nightmare(js)?|testcafe/i, 'headless_browser'),
  signature('lighthouse', /chrome-lighthouse|\blighthouse\b/i, 'headless_browser'),

  // Scripted HTTP clients. A browser never identifies itself this way.
  signature('curl', /^curl\/|\bcurl\/\d/i),
  signature('wget', /^wget[/ ]|\bwget\/\d/i),
  signature('python-http', /python-requests|python-urllib|aiohttp|httpx\//i),
  signature('go-http', /go-http-client/i),
  signature('java-http', /^java\/|okhttp|apache-httpclient|jakarta/i),
  signature('node-http', /node-fetch|axios\/|got \(|undici/i),
  signature('perl-php-http', /libwww-perl|php-curl|guzzlehttp|symfony httpclient/i),
  signature('api-client', /postmanruntime|insomnia|restsharp|httpie/i),

  // Generic tokens, last so a named crawler reports under its own name. `bot`
  // is matched only where a word boundary follows, and the NOT_A_BOT exception
  // above protects the handset brands that end in those letters.
  signature('generic-bot', /\bbot\b|bot\/|[a-z]bot\b/i),
  signature('generic-crawler', /crawler|crawling|\bcrawl\b|spider|scraper|\bfetcher\b/i),
  signature('generic-monitor', /monitoring\/|healthcheck|uptime|\bprobe\b/i),
  signature('generic-feed', /feedfetcher|feedparser|rss(reader|bot)/i),
]

export interface BotVerdict {
  readonly bot: boolean
  readonly reason: BotReason | null
  /** Stable name of the matching rule, for the aggregate security counter. */
  readonly signature: string | null
  readonly rulesetVersion: number
}

const HUMAN: BotVerdict = {
  bot: false,
  reason: null,
  signature: null,
  rulesetVersion: BOT_RULESET_VERSION,
}

/**
 * Classify a request's user agent.
 *
 * Pure and deterministic: the collector, the security counter and the tests all
 * have to reach the same verdict for the same string, and a verdict that varied
 * would make the counter unreadable.
 *
 * Only the first 512 characters are examined. A user agent longer than that is
 * not a browser's, and scanning an unbounded attacker-supplied string with this
 * many regular expressions is work a request should not be able to demand.
 */
export function classifyUserAgent(userAgent: string | null | undefined): BotVerdict {
  if (userAgent === null || userAgent === undefined || userAgent.trim() === '') {
    return {
      bot: true,
      reason: 'missing_user_agent',
      signature: 'missing_user_agent',
      rulesetVersion: BOT_RULESET_VERSION,
    }
  }

  const value = userAgent.slice(0, 512)
  if (NOT_A_BOT.test(value)) return HUMAN

  for (const candidate of BOT_SIGNATURES) {
    if (candidate.pattern.test(value)) {
      return {
        bot: true,
        reason: candidate.reason,
        signature: candidate.name,
        rulesetVersion: BOT_RULESET_VERSION,
      }
    }
  }

  return HUMAN
}
