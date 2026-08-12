/**
 * Referrer domain → presentable source. Pure display-layer normalization
 * (Plausible-style): the wire keeps raw domains, this maps the known ones to
 * their household names and folds host variants (`www.`, `m.`, country TLDs,
 * link shorteners like `t.co`) onto one canonical identity. Unknown domains
 * pass through untouched, so nothing here ever hides data — and when ingest
 * later normalizes at the source, this keeps working with no change.
 */

export type ReferrerInfo = {
  /** Display name — "Google", or the bare host when unrecognized. */
  name: string;
  /** Canonical domain to fetch a favicon for. */
  domain: string;
};

/** Full-host matches, after `www.` stripping — checked before suffixes so
 *  `mail.google.com` can be Gmail while `google.com` stays Google. */
const EXACT: Record<string, ReferrerInfo> = {
  "t.co": { name: "X", domain: "x.com" },
  "x.com": { name: "X", domain: "x.com" },
  "twitter.com": { name: "X", domain: "x.com" },
  "youtu.be": { name: "YouTube", domain: "youtube.com" },
  "news.ycombinator.com": {
    name: "Hacker News",
    domain: "news.ycombinator.com",
  },
  "hn.algolia.com": { name: "Hacker News", domain: "news.ycombinator.com" },
  "mail.google.com": { name: "Gmail", domain: "mail.google.com" },
  "news.google.com": { name: "Google News", domain: "news.google.com" },
  "gemini.google.com": { name: "Gemini", domain: "gemini.google.com" },
  "t.me": { name: "Telegram", domain: "telegram.org" },
  "telegram.me": { name: "Telegram", domain: "telegram.org" },
  "lnkd.in": { name: "LinkedIn", domain: "linkedin.com" },
  "fb.com": { name: "Facebook", domain: "facebook.com" },
  "bsky.app": { name: "Bluesky", domain: "bsky.app" },
  "dev.to": { name: "DEV", domain: "dev.to" },
  "search.brave.com": { name: "Brave Search", domain: "search.brave.com" },
  "chat.openai.com": { name: "ChatGPT", domain: "chatgpt.com" },
  "chatgpt.com": { name: "ChatGPT", domain: "chatgpt.com" },
  "claude.ai": { name: "Claude", domain: "claude.ai" },
  "perplexity.ai": { name: "Perplexity", domain: "perplexity.ai" },
  "discord.gg": { name: "Discord", domain: "discord.com" },
};

/** Registrable-domain matches: the host itself or any subdomain of it
 *  (`l.facebook.com`, `old.reddit.com`). */
const SUFFIX: Array<[string, ReferrerInfo]> = [
  ["google.com", { name: "Google", domain: "google.com" }],
  ["bing.com", { name: "Bing", domain: "bing.com" }],
  ["duckduckgo.com", { name: "DuckDuckGo", domain: "duckduckgo.com" }],
  ["yahoo.com", { name: "Yahoo", domain: "yahoo.com" }],
  ["yandex.ru", { name: "Yandex", domain: "yandex.com" }],
  ["yandex.com", { name: "Yandex", domain: "yandex.com" }],
  ["baidu.com", { name: "Baidu", domain: "baidu.com" }],
  ["ecosia.org", { name: "Ecosia", domain: "ecosia.org" }],
  ["facebook.com", { name: "Facebook", domain: "facebook.com" }],
  ["instagram.com", { name: "Instagram", domain: "instagram.com" }],
  ["linkedin.com", { name: "LinkedIn", domain: "linkedin.com" }],
  ["reddit.com", { name: "Reddit", domain: "reddit.com" }],
  ["youtube.com", { name: "YouTube", domain: "youtube.com" }],
  ["tiktok.com", { name: "TikTok", domain: "tiktok.com" }],
  ["pinterest.com", { name: "Pinterest", domain: "pinterest.com" }],
  ["whatsapp.com", { name: "WhatsApp", domain: "whatsapp.com" }],
  ["threads.net", { name: "Threads", domain: "threads.net" }],
  ["twitch.tv", { name: "Twitch", domain: "twitch.tv" }],
  ["github.com", { name: "GitHub", domain: "github.com" }],
  ["gitlab.com", { name: "GitLab", domain: "gitlab.com" }],
  ["stackoverflow.com", { name: "Stack Overflow", domain: "stackoverflow.com" }],
  ["producthunt.com", { name: "Product Hunt", domain: "producthunt.com" }],
  ["medium.com", { name: "Medium", domain: "medium.com" }],
  ["substack.com", { name: "Substack", domain: "substack.com" }],
  ["discord.com", { name: "Discord", domain: "discord.com" }],
  ["slack.com", { name: "Slack", domain: "slack.com" }],
  ["notion.so", { name: "Notion", domain: "notion.so" }],
  ["figma.com", { name: "Figma", domain: "figma.com" }],
  ["dribbble.com", { name: "Dribbble", domain: "dribbble.com" }],
  ["behance.net", { name: "Behance", domain: "behance.net" }],
  ["wikipedia.org", { name: "Wikipedia", domain: "wikipedia.org" }],
  ["npmjs.com", { name: "npm", domain: "npmjs.com" }],
];

/** All Google country properties (`google.de`, `google.com.tr`, …). */
const GOOGLE_TLD = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/;

export function resolveReferrer(raw: string): ReferrerInfo {
  // The wire carries bare domains, but be lenient about a stray URL.
  let host = raw.trim().toLowerCase();
  host = host.replace(/^[a-z+]+:\/\//, "").replace(/[/:?#].*$/, "");
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (host === "") return { name: raw, domain: raw };

  const exact = EXACT[host];
  if (exact !== undefined) return exact;
  for (const [base, info] of SUFFIX) {
    if (host === base || host.endsWith(`.${base}`)) return info;
  }
  if (GOOGLE_TLD.test(host)) return { name: "Google", domain: "google.com" };
  return { name: host, domain: host };
}
