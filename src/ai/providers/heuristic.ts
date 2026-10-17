/**
 * Deterministic, keyless provider.
 *
 * Purpose (README §23, §32, §33):
 *  - the whole pipeline works before any API key exists, so the architecture can
 *    be validated without spending money;
 *  - it is the cheap first-stage filter for real LLM providers later.
 *
 * Everything here is pure and testable: no network, no clock, no randomness.
 */
import type { LeadAnalysis, LeadPromptInput, OwnerProfileFacts, ScreenResult } from "@/src/ai/schemas";
import { PROMPT_VERSION } from "@/src/ai/prompts";
import type { AIProvider, AnalysisOutcome, ResponseInput, ResponseOutcome, ScreenOutcome } from "@/src/ai/types";
import { LeadCategory, type Urgency } from "@/src/generated/prisma/enums";

export const HEURISTIC_MODEL = "heuristic-rules-v1";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Order matters: the first matching group wins, so name specific platforms first. */
const CATEGORY_RULES: Array<{ category: LeadCategory; patterns: RegExp[] }> = [
  { category: LeadCategory.WOOCOMMERCE, patterns: [/\bwoo\s?commerce\b/, /\bwoocommerce\b/] },
  { category: LeadCategory.SHOPIFY, patterns: [/\bshopify\b/] },
  { category: LeadCategory.WORDPRESS, patterns: [/\bwordpress\b/, /\bwp\s?(site|theme|plugin)\b/] },
  { category: LeadCategory.TELEGRAM_BOT, patterns: [/\btelegram\s*bot\b/, /\bbot for telegram\b/, /\btelegram\b.*\bbot\b/] },
  { category: LeadCategory.DISCORD_BOT, patterns: [/\bdiscord\s*bot\b/, /\bbot for discord\b/] },
  { category: LeadCategory.CRM, patterns: [/\bcrm\b/, /\bhubspot\b/, /\bsalesforce\b/] },
  { category: LeadCategory.MOBILE_APP, patterns: [/\b(mobile|ios|android|iphone|flutter|react native)\b.*\b(app|application)\b/, /\bapp\b.*\b(ios|android|store)\b/] },
  { category: LeadCategory.AI, patterns: [/\b(ai|llm|gpt|chatbot|machine learning|openai|claude)\b/] },
  { category: LeadCategory.API_INTEGRATION, patterns: [/\bapi\b.*\b(integration|integrate|connect)\b/, /\bintegrat(e|ion)\b.*\b(api|system|crm|stripe)\b/, /\bstripe\b/, /\bwebhook\b/] },
  { category: LeadCategory.AUTOMATION, patterns: [/\bautomat(e|ion|ic)\b/, /\bscript\b.*\b(scrape|report|export)\b/, /\bworkflow\b/] },
  { category: LeadCategory.SEO, patterns: [/\bseo\b/, /\bsearch engine\b/] },
  { category: LeadCategory.PERFORMANCE, patterns: [/\b(performance|speed|core web vitals|lighthouse)\b/, /\b(site|page|website)\b.*\b(slow|laggy)\b/] },
  { category: LeadCategory.BUG_FIX, patterns: [/\b(fix|bug|broken|error|not working|crash(es|ing)?)\b/] },
  { category: LeadCategory.REDESIGN, patterns: [/\b(redesign|revamp|refresh)\b/] },
  { category: LeadCategory.LANDING_PAGE, patterns: [/\blanding page\b/, /\bone[- ]pager?\b/] },
  { category: LeadCategory.E_COMMERCE, patterns: [/\b(e[- ]?commerce|online store|webshop|shop)\b/] },
  { category: LeadCategory.WEB_APP, patterns: [/\bweb\s?app\b/, /\b(saas|dashboard|portal|platform|booking system)\b/] },
  { category: LeadCategory.WEBSITE, patterns: [/\bweb\s?site\b/, /\bweb\s?page\b/, /\bsite\b/] },
  { category: LeadCategory.CUSTOM_SOFTWARE, patterns: [/\bsoftware\b/, /\bapplication\b/, /\bsystem\b/] },
];

const ARTIFACT_PATTERNS: RegExp[] = [
  /\b(web\s?site|web\s?page|web\s?app|site|landing page)\b/,
  /\b(app|application|mobile app|ios|android)\b/,
  /\b(store|shop|e[- ]?commerce|webshop)\b/,
  /\b(bot|chatbot|automation|script|integration|api|crm|dashboard|portal|plugin|theme)\b/,
  /\b(migration|migrate|redesign|makeover)\b/,
];

const EXPLICIT_ASK_PATTERNS: RegExp[] = [
  /\b(looking|searching|hunt(ing)?)\s+(for|to hire)\b[^.!?]{0,40}\b(developer|dev|programmer|freelancer|agency|designer|engineer|someone|somebody|expert)\b/,
  // "Need someone to fix it" — a hire request without naming a role.
  /\b(need|needs|want|wants|looking for)\s+(someone|somebody)\s+to\s+\w+/,
  /\b(need|needs|want|wants|looking for|hiring|hire)\s+(to hire\s+)?(a|an|some|someone|somebody|any)\b[^.!?]{0,30}\b(developer|dev|programmer|freelancer|agency|designer|engineer|help)\b/,
  /\b(i|we)\s+(need|want)\s+(someone|somebody|a developer|a freelancer|help with)\b/,
  /\bcan (anyone|someone|somebody)\b[^.!?]{0,30}\b(build|make|recommend|help)\b/,
  /\b(recommend|suggest)\b[^.!?]{0,20}\b(developer|freelancer|agency)\b/,
  /\b(hiring|hiring a|looking to hire|want to hire)\b/,
  /\bwho can\b[^.!?]{0,30}\b(build|make|fix|design)\b/,
];

const STATED_NEED_PATTERNS: RegExp[] = [
  /\b(i|we)\s+(need|want|require|am planning|are planning|am looking|are looking|am thinking|are thinking)\b/,
  // Posts often open without a pronoun: "Need a WooCommerce store …".
  /\b(need|needs|want|wants|require|requires|looking for)\s+(a|an|some|my|our|new)\b/,
  /\b(need|want|would like)\s+(a|an|my|our)\b[^.!?]{0,40}\b(web\s?site|site|app|store|shop|bot|system|platform|page|redesign)\b/,
  /\b(planning|thinking about|considering|looking into)\b[^.!?]{0,30}\b(build|create|launch|get|new)\b/,
  /\b(get(ting)?|build|building|create|creating|make|making|launch(ing)?)\s+(a|an|my|our|new)\b[^.!?]{0,30}\b(web\s?site|site|app|store|shop|bot|system|platform|page)\b/,
];

const COMMERCIAL_PATTERNS: RegExp[] = [
  // Allow one qualifier: "our construction company", "my new shop".
  /\b(my|our)\s+(?:\w+\s+)?(business|company|shop|store|clinic|restaurant|studio|agency|firm|practice|startup|brand|bakery|salon|gym)\b/,
  /\b(clients?|customers?|sales|orders|revenue|leads)\b/,
  /\b(we sell|i sell|we offer|i run|we run|i own|we own)\b/,
  /\b(b2b|b2c|for my company|for our company)\b/,
];

const COST_QUESTION_PATTERNS: RegExp[] = [
  /\bhow much\b[^.!?]{0,40}\b(cost|charge|price)\b/,
  /\b(what|whats|what's)\b[^.!?]{0,20}\b(budget|price|cost)\b/,
  /\b(quote|quotation|estimate|ballpark)\b/,
  /\bwhat would\b[^.!?]{0,40}\bcost\b/,
];

const HEDGING_PATTERNS: RegExp[] = [
  /\b(maybe|perhaps|someday|some day|one day|eventually|at some point|thinking about|not sure|just curious|out of curiosity)\b/,
  /\bif i (ever|decide|had)\b/,
];

const URGENCY_HIGH_PATTERNS: RegExp[] = [
  /\b(asap|as soon as possible|urgent(ly)?|immediately|right away)\b/,
  /\b(this week|next week|this month|before (the )?(launch|season|holidays|christmas|black friday))\b/,
  /\b(deadline|due (by|on)|go[- ]live)\b/,
  /\b(losing (sales|money|customers|orders)|losing money)\b/,
];

const URGENCY_MEDIUM_PATTERNS: RegExp[] = [
  /\b(soon|shortly|in a few weeks|in a couple of weeks|next month|over the next)\b/,
  /\b(in (one|two|three|1|2|3) months?)\b/,
];

const URGENCY_LOW_PATTERNS: RegExp[] = [
  /\b(some ?day|next year|no rush|whenever|not urgent|eventually)\b/,
];

type NegativeKind =
  | "vendor"
  | "learning"
  | "opinion"
  | "ownCode"
  | "retrospective"
  | "employment"
  | "recruiting"
  | "spam";

type NegativeRule = {
  kind: NegativeKind;
  weight: number;
  patterns: RegExp[];
  /** A categorical "this person is not a buyer" signal. */
  hard: boolean;
  /** Optional extra condition required for the rule to apply. */
  guard?: (text: string) => boolean;
};

const FREELANCE_HINTS = /\b(freelance|freelancer|contract|contractor|short[- ]term|project[- ]based|gig|part[- ]time)\b/;

const NEGATIVE_RULES: NegativeRule[] = [
  {
    kind: "vendor",
    weight: 60,
    hard: true,
    patterns: [
      /\b(i am|i'm|we are|we're)\s+(a|an)\s+(developer|web developer|designer|agency|freelancer|engineer|programmer)\b/,
      /\b(we|i)\s+(build|develop|design|create)\s+(web\s?sites?|apps?|stores?|software|bots?)\s+for\b/,
      /\b(hire me|dm me if you (need|want)|shoot me a dm|available for (hire|work|projects)|my services)\b/,
      /\b(our agency|my agency|our studio|our team offers|we specialize in)\b/,
      /\b(years? of experience)\b[^.!?]{0,40}\b(dm|message|contact|hire)\b/,
    ],
  },
  {
    kind: "learning",
    weight: 45,
    hard: true,
    patterns: [
      /\b(how (do|can) i (learn|start|begin)|learn(ing)? (to|how)|which (course|bootcamp)|tutorial|roadmap|beginner|no experience)\b/,
      /\b(should i learn|worth learning|getting into (coding|programming|web dev))\b/,
    ],
  },
  {
    kind: "opinion",
    weight: 40,
    hard: true,
    patterns: [
      /\b(overrated|underrated|waste of (money|time)|scam|rip[- ]?off)\b/,
      /\b(developers are|agencies are|freelancers are)\b/,
      /\b(i (hate|can't stand|dislike) (coding|developers|agencies))\b/,
      /\b(ai will (replace|take))\b/,
    ],
  },
  {
    kind: "ownCode",
    weight: 30,
    hard: true,
    patterns: [
      /\b(why (does|is|do) my|my code|my function|my component|stack trace|segmentation fault)\b/,
      /\b(typescript error|compilation error|error ts\d+|module not found|cannot find module|npm err)\b/,
      /\b(debug(ging)? my|help me fix my code)\b/,
    ],
    // "our checkout is broken, we need someone to fix it" must survive.
    guard: (text) => !EXPLICIT_ASK_PATTERNS.some((p) => p.test(text)),
  },
  {
    kind: "retrospective",
    weight: 25,
    hard: false,
    patterns: [
      /\b(i|we)\s+(just\s+)?(built|made|launched|shipped|finished|released)\b/,
      /\b(just launched my|recently launched our)\b/,
    ],
  },
  {
    kind: "employment",
    weight: 25,
    hard: true,
    patterns: [
      /\b(full[- ]?time|permanent|salaried|salary|benefits|equity|stock options|401k)\b/,
      /\b(years? of (professional )?experience (required|needed))\b/,
    ],
    guard: (text) => !FREELANCE_HINTS.test(text),
  },
  {
    kind: "recruiting",
    weight: 25,
    hard: true,
    patterns: [
      /\b(we are looking for a (senior|lead|staff|principal) (engineer|developer))\b/,
      /\b(join our team|apply (now|at|via)|job (posting|description)|cv|resume)\b/,
    ],
    guard: (text) => !FREELANCE_HINTS.test(text),
  },
  {
    kind: "spam",
    weight: 50,
    hard: true,
    patterns: [
      /\b(seo services|crypto|forex|casino|betting|escort|loan offer)\b/,
      /\b(click here|buy now|limited offer|guaranteed (traffic|rankings))\b/,
    ],
  },
];

const BUSINESS_TYPE_MAP: Array<{ type: string; pattern: RegExp }> = [
  { type: "Restaurant", pattern: /\brestaurant|bistro|cafe|café|coffee shop|pizzeria\b/ },
  { type: "Bakery", pattern: /\bbakery|patisserie\b/ },
  { type: "Construction", pattern: /\bconstruction|building company|renovation|roofing|contractor\b/ },
  { type: "Clinic", pattern: /\bclinic|dental|dentist|medical practice|physio|doctor\b/ },
  { type: "Salon / beauty", pattern: /\bsalon|barbershop|barber|beauty|spa|nails\b/ },
  { type: "Gym / fitness", pattern: /\bgym|fitness|personal train|crossfit|yoga\b/ },
  { type: "Law firm", pattern: /\blaw (firm|office)|attorney|lawyer|legal practice|notary\b/ },
  { type: "Real estate", pattern: /\breal estate|realtor|property (agency|management)|rentals\b/ },
  { type: "E-commerce brand", pattern: /\b(online|ecommerce|e-commerce) (store|shop|brand)|we sell\b/ },
  { type: "Retail shop", pattern: /\bshop|store|boutique|retail\b/ },
  { type: "Hotel / travel", pattern: /\bhotel|guesthouse|hostel|travel agency|tours?\b/ },
  { type: "Logistics", pattern: /\b(logistics|delivery|freight|transport|trucking)\b/ },
  { type: "Education", pattern: /\b(school|academy|courses|tutor|kindergarten|university)\b/ },
  { type: "Agency / studio", pattern: /\b(marketing agency|design studio|creative studio|consultancy)\b/ },
  { type: "Manufacturing", pattern: /\b(manufactur|factory|industrial|workshop)\b/ },
  { type: "Non-profit", pattern: /\b(ngo|non[- ]profit|charity|foundation)\b/ },
];

const LOCATION_PATTERNS: RegExp[] = [
  /\b(?:based|located|live|living|from|in)\s+(?:in\s+)?([A-Z][a-zA-Z\u00C0-\u024F]+(?:[ -][A-Z][a-zA-Z\u00C0-\u024F]+)?)/,
];

/** Country and region names worth detecting without an LLM. */
const KNOWN_LOCATIONS = [
  "Germany", "France", "Spain", "Italy", "Portugal", "Netherlands", "Belgium", "Austria",
  "Switzerland", "Poland", "Romania", "Moldova", "Ukraine", "Bulgaria", "Hungary", "Czechia",
  "Greece", "Sweden", "Norway", "Denmark", "Finland", "Ireland", "United Kingdom", "UK",
  "England", "Scotland", "Wales", "United States", "USA", "Canada", "Australia", "New Zealand",
  "India", "Pakistan", "Brazil", "Mexico", "Argentina", "Turkey", "UAE", "Dubai", "Qatar",
  "Saudi Arabia", "Israel", "Egypt", "South Africa", "Nigeria", "Kenya", "Singapore",
  "Malaysia", "Indonesia", "Philippines", "Vietnam", "Thailand", "Japan", "South Korea", "China",
];

const REQUIREMENT_VERBS = /\b(need|needs|want|wants|must|should|require|requires|include|includes|with|plus|looking for)\b/i;

const STOP_CLAUSES = /\b(i|we)\b/i;

// ---------------------------------------------------------------------------
// Extraction helpers (pure — unit tested)
// ---------------------------------------------------------------------------

/** Parses "1.5k", "2,000", "2.000", "1500" into an integer. */
export function parseAmount(raw: string): number | null {
  let value = raw.trim().toLowerCase().replace(/[$€£\s]/g, "");
  let multiplier = 1;

  if (value.endsWith("k")) {
    multiplier = 1000;
    value = value.slice(0, -1);
  }

  if (value.length === 0) return null;

  const thousands = /^\d{1,3}([.,]\d{3})+$/.test(value);
  const decimal = /^\d+[.,]\d{1,2}$/.test(value);

  let normalized: string;
  if (thousands) {
    normalized = value.replace(/[.,]/g, "");
  } else if (decimal) {
    normalized = String(Math.round(Number(value.replace(",", ".")) * 100) / 100);
  } else {
    normalized = value.replace(/[.,]/g, "");
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * multiplier);
}

function detectCurrency(fragment: string): string {
  const text = fragment.toLowerCase();
  if (/€|\beur\b|\beuro/.test(text)) return "EUR";
  if (/£|\bgbp\b|\bpound/.test(text)) return "GBP";
  if (/\$|\busd\b|\bdollar/.test(text) || /\b(us )?\$/.test(text)) return "USD";
  if (/\bmdl\b|\blei\b/.test(text)) return "MDL";
  if (/\bron\b|\blei\b/.test(text)) return "RON";
  if (/\baud\b/.test(text)) return "AUD";
  if (/\bcad\b/.test(text)) return "CAD";
  if (/\bchf\b/.test(text)) return "CHF";
  if (/\bzar\b/.test(text)) return "ZAR";
  if (/\binr\b|₹/.test(text)) return "INR";
  if (/\baed\b|\bdirham/.test(text)) return "AED";
  return "";
}

const BUDGET_CONTEXT = /\b(budget|cost|costs|price|pricing|pay|paying|paid|quote|quotation|estimate|afford|charge|spend|invest)\b/i;
const CURRENCY_CONTEXT = /[$€£¥₹]|\b(eur|usd|gbp|mdl|ron|aud|cad|chf|zar|inr|aed|euros?|dollars?|pounds?|lei|dirhams?)\b/i;
/**
 * A number immediately followed by a count noun is a quantity, not a price
 * ("40 products"). Anchored, so "3,000, starting next week" is not discarded
 * just because the sentence mentions a week further along.
 */
const COUNT_CONTEXT = /^\s*(products?|items?|artists?|pages?|employees?|people|users?|orders?|clients?|years?|months?|days?|weeks?|hours?|posts?|staff|projects?)\b/i;

/**
 * Sentence boundary: a period only ends a sentence when whitespace or the end
 * of the text follows it, so decimals ("1.5k") survive splitting.
 */
const SENTENCE_BOUNDARY = /[!?\n;]+|\.(?=\s|$)/;

/**
 * Extracts a budget only when a number appears next to a money symbol/word or
 * inside a sentence that talks about budget/cost. Deliberately conservative:
 * a wrong budget is worse than a missing one.
 */
export function extractBudget(text: string): { min: number; max: number; currency: string } {
  const sentences = text.split(SENTENCE_BOUNDARY);
  const found: number[] = [];
  let currency = "";

  for (const sentence of sentences) {
    const hasMoneyContext = CURRENCY_CONTEXT.test(sentence);
    const hasBudgetContext = BUDGET_CONTEXT.test(sentence);
    if (!hasMoneyContext && !hasBudgetContext) continue;

    const matches = sentence.match(/\d[\d.,]*\s*k?/gi) ?? [];
    for (const match of matches) {
      const index = sentence.indexOf(match);
      const after = sentence.slice(index + match.length, index + match.length + 22);
      if (COUNT_CONTEXT.test(after)) continue;

      const amount = parseAmount(match);
      if (amount === null || amount < 20 || amount > 10_000_000) continue;

      found.push(amount);
      if (!currency) currency = detectCurrency(sentence);
    }
  }

  if (found.length === 0) return { min: 0, max: 0, currency: "" };

  return {
    min: Math.min(...found),
    max: Math.max(...found),
    currency,
  };
}

export function detectCategory(text: string): LeadCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) return rule.category;
  }
  return LeadCategory.OTHER;
}

export function detectBusinessType(text: string): string {
  for (const entry of BUSINESS_TYPE_MAP) {
    if (entry.pattern.test(text)) return entry.type;
  }
  return "";
}

export function detectLocation(text: string): string {
  for (const location of KNOWN_LOCATIONS) {
    const pattern = new RegExp(`\\b${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(text)) return location;
  }
  for (const pattern of LOCATION_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

export function detectUrgency(text: string): Urgency {
  if (URGENCY_HIGH_PATTERNS.some((pattern) => pattern.test(text))) return "HIGH";
  if (URGENCY_MEDIUM_PATTERNS.some((pattern) => pattern.test(text))) return "MEDIUM";
  if (URGENCY_LOW_PATTERNS.some((pattern) => pattern.test(text))) return "LOW";
  return "UNKNOWN";
}

function splitClauses(text: string): string[] {
  return text
    // Commas split clauses too, but not inside "1,000".
    .split(new RegExp(`${SENTENCE_BOUNDARY.source}|,(?!\\s*\\d{3}\\b)`, "g"))
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter((clause) => clause.length > 3);
}

export function extractRequirements(text: string): string[] {
  const out: string[] = [];
  for (const clause of splitClauses(text)) {
    if (!REQUIREMENT_VERBS.test(clause)) continue;
    if (!ARTIFACT_PATTERNS.some((pattern) => pattern.test(clause)) && out.length > 0) {
      // Keep only requirement clauses that name something concrete.
      if (!/\b(form|payment|checkout|booking|cart|catalog|login|search|integration|email|report|dashboard|notification|multi[- ]language)\b/i.test(clause)) {
        continue;
      }
    }
    const cleaned = clause.replace(STOP_CLAUSES, (match) => match.toLowerCase()).trim();
    if (cleaned.length < 6 || cleaned.length > 160) continue;
    if (out.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) continue;
    out.push(cleaned);
    if (out.length >= 6) break;
  }
  return out;
}

export function extractPainPoints(text: string): string[] {
  const keywords = /\b(problem|issue|broken|broken|outdated|old site|slow|frustrat|losing|fails?|failing|no (orders|sales|leads)|can't|cannot|doesn't work|hate)\b/i;
  const out: string[] = [];
  for (const clause of splitClauses(text)) {
    if (!keywords.test(clause)) continue;
    if (clause.length < 8 || clause.length > 160) continue;
    if (out.some((existing) => existing.toLowerCase() === clause.toLowerCase())) continue;
    out.push(clause);
    if (out.length >= 5) break;
  }
  return out;
}

export type Evidence = {
  explicitAsk: boolean;
  statedNeed: boolean;
  artifact: boolean;
  commercial: boolean;
  budget: { min: number; max: number; currency: string };
  costQuestion: boolean;
  urgency: Urgency;
  hedging: boolean;
  negatives: Array<{ kind: NegativeKind; weight: number; hard: boolean }>;
};

export function collectEvidence(text: string): Evidence {
  const lower = text.toLowerCase();
  const budget = extractBudget(text);

  const negatives: Evidence["negatives"] = [];
  for (const rule of NEGATIVE_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(lower))) continue;
    if (rule.guard && !rule.guard(lower)) continue;
    negatives.push({ kind: rule.kind, weight: rule.weight, hard: rule.hard });
  }

  return {
    explicitAsk: EXPLICIT_ASK_PATTERNS.some((pattern) => pattern.test(lower)),
    statedNeed: STATED_NEED_PATTERNS.some((pattern) => pattern.test(lower)),
    artifact: ARTIFACT_PATTERNS.some((pattern) => pattern.test(lower)),
    commercial: COMMERCIAL_PATTERNS.some((pattern) => pattern.test(lower)),
    budget,
    costQuestion: COST_QUESTION_PATTERNS.some((pattern) => pattern.test(lower)),
    urgency: detectUrgency(lower),
    hedging: HEDGING_PATTERNS.some((pattern) => pattern.test(lower)),
    negatives,
  };
}

export type EvidenceScore = {
  score: number;
  isLead: boolean;
  breakdown: Array<{ label: string; points: number }>;
  blocked: boolean;
};

/**
 * Converts evidence into a 0-100 intent score.
 * Weights are chosen so the README's canonical examples land in the right band
 * (see tests/heuristic.test.ts).
 */
export function scoreEvidence(evidence: Evidence): EvidenceScore {
  const breakdown: Array<{ label: string; points: number }> = [];

  const add = (label: string, points: number) => {
    if (points !== 0) breakdown.push({ label, points });
  };

  if (evidence.explicitAsk) add("explicit request for a developer", 35);
  if (evidence.statedNeed) add("states a need", 22);
  if (evidence.artifact) add("names a concrete deliverable", 22);
  if (evidence.commercial) add("commercial context", 12);
  if (evidence.budget.max > 0) add("stated budget", 18);
  if (evidence.costQuestion) add("asks about cost", 14);

  if (evidence.urgency === "HIGH") add("urgent timing", 13);
  else if (evidence.urgency === "MEDIUM") add("near-term timing", 8);
  else if (evidence.urgency === "LOW") add("low urgency", 3);

  if (evidence.hedging) add("hedging language", -20);

  for (const negative of evidence.negatives) {
    add(`disqualifier: ${negative.kind}`, -negative.weight);
  }

  let score = breakdown.reduce((total, item) => total + item.points, 0);

  // Nothing concrete to buy and no ask → cannot be a strong lead.
  if (!evidence.artifact && !evidence.explicitAsk && !evidence.statedNeed) {
    score = Math.min(score, 40);
  }

  score = Math.max(0, Math.min(100, score));

  const blocked = evidence.negatives.some((negative) => negative.hard);
  const isLead = !blocked && score >= 35;

  return { score, isLead, breakdown, blocked };
}

function describeEvidence(score: EvidenceScore, evidence: Evidence, blocked: boolean): string {
  const positives = score.breakdown.filter((item) => item.points > 0).map((item) => item.label);
  const negatives = score.breakdown.filter((item) => item.points < 0).map((item) => item.label);

  const parts: string[] = [];
  parts.push(
    positives.length > 0
      ? `Rule-based signals matched: ${positives.join(", ")}.`
      : "No positive buying signals matched.",
  );

  if (negatives.length > 0) {
    parts.push(`Disqualifying signals: ${negatives.join(", ")}.`);
  } else if (blocked) {
    parts.push("A disqualifying signal was matched.");
  } else {
    parts.push("No disqualifying signals (vendor, learner, opinion, own-code debugging) were found.");
  }

  parts.push(
    evidence.budget.max > 0
      ? `A budget of ${evidence.budget.min}-${evidence.budget.max} ${evidence.budget.currency || ""} was read from the text.`
      : "No budget was stated, so none was assumed.",
  );

  parts.push(
    "This score comes from the deterministic rule-based provider (no LLM call). Set AI_API_KEY to a free provider (Google AI Studio, Groq, OpenRouter, Ollama) for model-based analysis.",
  );

  return parts.join(" ");
}

function buildProjectDescription(input: LeadPromptInput, analysis: {
  category: LeadCategory;
  businessType: string;
  requirements: string[];
}): string {
  const label = analysis.category.replace(/_/g, " ").toLowerCase();
  const business = analysis.businessType ? ` for a ${analysis.businessType.toLowerCase()} business` : "";
  const requirements = analysis.requirements.length > 0
    ? ` Mentioned: ${analysis.requirements.slice(0, 3).join("; ")}.`
    : "";
  const source = input.title ? ` Title: ${input.title}.` : "";
  return `Rule-based classification: ${label}${business}.${requirements}${source}`.trim();
}

const SERVICE_BY_CATEGORY: Partial<Record<LeadCategory, string>> = {
  [LeadCategory.WEBSITE]: "Website build",
  [LeadCategory.WEB_APP]: "Web application development",
  [LeadCategory.MOBILE_APP]: "Mobile app development",
  [LeadCategory.WORDPRESS]: "WordPress development",
  [LeadCategory.WOOCOMMERCE]: "WooCommerce store build",
  [LeadCategory.SHOPIFY]: "Shopify development",
  [LeadCategory.TELEGRAM_BOT]: "Telegram bot development",
  [LeadCategory.DISCORD_BOT]: "Discord bot development",
  [LeadCategory.CRM]: "CRM setup",
  [LeadCategory.AUTOMATION]: "Automation / scripting",
  [LeadCategory.AI]: "AI integration",
  [LeadCategory.API_INTEGRATION]: "API integration",
  [LeadCategory.SEO]: "SEO work",
  [LeadCategory.PERFORMANCE]: "Performance optimisation",
  [LeadCategory.BUG_FIX]: "Bug fixing",
  [LeadCategory.REDESIGN]: "Website redesign",
  [LeadCategory.E_COMMERCE]: "E-commerce development",
  [LeadCategory.LANDING_PAGE]: "Landing page build",
  [LeadCategory.CUSTOM_SOFTWARE]: "Custom software development",
};

/** Runs the full rule-based analysis. Pure function. */
export function heuristicAnalyze(lead: LeadPromptInput): LeadAnalysis {
  const text = `${lead.title ?? ""}\n${lead.content}`.trim();
  const evidence = collectEvidence(text);
  const scored = scoreEvidence(evidence);

  const category = detectCategory(text.toLowerCase());
  const businessType = detectBusinessType(text.toLowerCase());
  const location = detectLocation(text);
  const requirements = extractRequirements(text);
  const painPoints = extractPainPoints(text);

  const evidenceCount =
    Number(evidence.explicitAsk) +
    Number(evidence.statedNeed) +
    Number(evidence.artifact) +
    Number(evidence.commercial) +
    Number(evidence.budget.max > 0) +
    Number(evidence.costQuestion);

  const confidence = Math.min(0.9, 0.35 + evidenceCount * 0.09);

  return {
    isLead: scored.isLead,
    confidence: Number(confidence.toFixed(2)),
    category,
    projectDescription: buildProjectDescription(lead, { category, businessType, requirements }),
    intentScore: scored.score,
    budget: evidence.budget,
    urgency: evidence.urgency,
    location,
    businessType,
    requirements,
    painPoints,
    recommendedService: SERVICE_BY_CATEGORY[category] ?? "Software development",
    reasoning: describeEvidence(scored, evidence, scored.blocked),
  };
}

function heuristicScreen(lead: LeadPromptInput): ScreenResult {
  const text = `${lead.title ?? ""}\n${lead.content}`.trim();
  const evidence = collectEvidence(text);
  const scored = scoreEvidence(evidence);
  return {
    isCandidate: scored.isLead || scored.score >= 22,
    confidence: Number(Math.min(0.9, 0.4 + scored.score / 200).toFixed(2)),
    reason: scored.isLead
      ? `Rule signals indicate a buyer (score ${scored.score}).`
      : scored.blocked
        ? "Matched a disqualifying pattern (vendor, learner, opinion or own-code debugging)."
        : `Weak signals only (score ${scored.score}).`,
  };
}

/**
 * Drafts a reply from template fragments, so it can never invent facts:
 * every capability claim is copied from the owner profile.
 */
/** "Construction" → "your construction business"; "Retail shop" → "your retail shop". */
export function describeBusiness(businessType: string): string {
  if (!businessType.trim()) return "your project";
  const lower = businessType.trim().toLowerCase();
  const alreadyANoun = /\b(brand|shop|store|agency|studio|firm|clinic|practice|company|salon|gym|restaurant|bakery)\b/.test(lower);
  return alreadyANoun ? `your ${lower}` : `your ${lower} business`;
}

/** "Need a WooCommerce store" → "need a WooCommerce store" when embedded mid-sentence. */
function asClause(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export function heuristicResponse(input: ResponseInput): string {
  const { analysis, profile } = input;
  const who = profile.name;
  const services = profile.services.slice(0, 4);
  const serviceLine = services.length > 0 ? services.join(", ") : "";

  const opening = (() => {
    const subject = describeBusiness(analysis.businessType);
    switch (analysis.category) {
      case LeadCategory.WOOCOMMERCE:
        return `You mentioned you're looking for a WooCommerce store for ${subject}.`;
      case LeadCategory.WORDPRESS:
        return `You mentioned needing WordPress work on ${subject}.`;
      case LeadCategory.SHOPIFY:
        return `You mentioned needing Shopify help with ${subject}.`;
      case LeadCategory.MOBILE_APP:
        return `You mentioned looking for someone to build a mobile app for ${subject}.`;
      case LeadCategory.TELEGRAM_BOT:
        return `You mentioned wanting a Telegram bot for ${subject}.`;
      case LeadCategory.BUG_FIX:
        return `You mentioned ${subject} has something broken that needs fixing.`;
      case LeadCategory.REDESIGN:
        return `You mentioned ${subject} needs a redesign.`;
      case LeadCategory.WEBSITE:
      case LeadCategory.LANDING_PAGE:
        return `You mentioned you need a ${analysis.category === LeadCategory.LANDING_PAGE ? "landing page" : "website"} for ${subject}.`;
      default:
        return `You mentioned you're looking for help with ${subject}.`;
    }
  })();

  const detail =
    analysis.requirements.length > 0
      ? ` The details you gave — ${analysis.requirements.slice(0, 3).map(asClause).join(", ")} — line up with what I normally work on.`
      : "";

  const capability = serviceLine
    ? ` I work with ${serviceLine}${profile.experience ? `, and ${profile.experience}` : ""}.`
    : "";

  const question = analysis.budget.max > 0
    ? "Would it help if I put together a short scope and a fixed estimate for you?"
    : "What would you want to be able to do on day one, and is there a date you're working towards?";

  const signature = who && who !== "Developer" ? `\n\n${who}` : "";

  return `${opening}${detail}${capability} ${question}${signature}`;
}

export class HeuristicProvider implements AIProvider {
  readonly name = "heuristic";

  async screen(lead: LeadPromptInput): Promise<ScreenOutcome> {
    return {
      screen: heuristicScreen(lead),
      provider: this.name,
      model: HEURISTIC_MODEL,
      promptVersion: PROMPT_VERSION,
      usage: null,
      raw: null,
      notes: ["deterministic rules, no model call"],
    };
  }

  async analyzeLead(lead: LeadPromptInput): Promise<AnalysisOutcome> {
    return {
      analysis: heuristicAnalyze(lead),
      provider: this.name,
      model: HEURISTIC_MODEL,
      promptVersion: PROMPT_VERSION,
      usage: null,
      raw: null,
      notes: ["deterministic rules, no model call"],
    };
  }

  async generateResponse(input: ResponseInput): Promise<ResponseOutcome> {
    return {
      body: heuristicResponse(input),
      provider: this.name,
      model: HEURISTIC_MODEL,
      promptVersion: PROMPT_VERSION,
      usage: null,
      raw: null,
      notes: ["template draft built only from profile facts"],
    };
  }
}

export type { OwnerProfileFacts };
