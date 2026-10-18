/**
 * English strings. This file is the shape of every dictionary: `ru.ts` is typed
 * as `Dictionary`, so a missing or misspelled key is a compile error.
 *
 * Not translated on purpose:
 *  - text the AI generates (analyses, reasoning, response drafts);
 *  - the activity log messages, which are stored in the database as prose;
 *  - the demo post examples on the intake screen, which are English-language posts.
 */
import type {
  LeadCategory,
  LeadStatus,
  OutreachStatus,
  SourceKind,
  Temperature,
  Urgency,
} from "@/src/generated/prisma/enums";
import type { ScoreComponent } from "@/src/leads/scoring";

const categories: Record<LeadCategory, string> = {
  WEBSITE: "Website",
  WEB_APP: "Web app",
  MOBILE_APP: "Mobile app",
  WORDPRESS: "WordPress",
  WOOCOMMERCE: "WooCommerce",
  SHOPIFY: "Shopify",
  TELEGRAM_BOT: "Telegram bot",
  DISCORD_BOT: "Discord bot",
  CRM: "CRM",
  AUTOMATION: "Automation",
  AI: "AI",
  API_INTEGRATION: "API integration",
  SEO: "SEO",
  PERFORMANCE: "Performance",
  BUG_FIX: "Bug fix",
  REDESIGN: "Redesign",
  E_COMMERCE: "E-commerce",
  LANDING_PAGE: "Landing page",
  CUSTOM_SOFTWARE: "Custom software",
  OTHER: "Other",
};

const statuses: Record<LeadStatus, string> = {
  NEW: "New",
  REVIEWED: "Reviewed",
  CONTACTED: "Contacted",
  REPLIED: "Replied",
  QUALIFIED: "Qualified",
  NEGOTIATION: "Negotiation",
  WON: "Won",
  LOST: "Lost",
  REJECTED: "Rejected",
  ARCHIVED: "Archived",
};

const temperatures: Record<Temperature, string> = {
  HOT: "Hot",
  WARM: "Warm",
  COLD: "Cold",
};

const urgencies: Record<Urgency, string> = {
  UNKNOWN: "Unknown",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
};

const sourceKinds: Record<SourceKind, string> = {
  REDDIT: "Reddit",
  PERPLEXITY: "Perplexity",
  TELEGRAM: "Telegram",
  WEB: "Web",
  X: "X",
  FORUM: "Forum",
  JOB_BOARD: "Job board",
  MANUAL: "Manual",
  OTHER: "Other",
};

const eventTypes: Record<string, string> = {
  DISCOVERED: "Discovered",
  DEDUPLICATED: "Duplicate ignored",
  ANALYZED: "Analyzed",
  SCORED: "Scored",
  REVIEWED: "Reviewed",
  CONTACTED: "Contacted",
  REPLIED: "Replied",
  STATUS_CHANGED: "Status changed",
  FOLLOWUP_SCHEDULED: "Follow-up scheduled",
  NOTE: "Note",
};

const analysisStatuses: Record<string, string> = {
  PENDING: "Pending",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};

const outreachStatuses: Record<OutreachStatus, string> = {
  DRAFT: "Draft",
  APPROVED: "Approved",
  SENT: "Sent",
  DISCARDED: "Discarded",
};

/** The eight scoring factors, keyed by the name the engine emits. */
const scoreFactors: Record<ScoreComponent["factor"], string> = {
  intent: "Intent",
  clarity: "Clarity",
  budget: "Budget",
  urgency: "Urgency",
  legitimacy: "Legitimacy",
  contactability: "Contactability",
  recency: "Recency",
  fit: "Fit",
};

export const en = {
  meta: {
    title: "Lead Hunter",
    description: "Personal AI lead generation console",
  },

  common: {
    any: "Any",
    apply: "Apply",
    reset: "Reset",
    set: "Set",
    add: "Add",
    save: "Save",
    saving: "Saving…",
    working: "Working…",
    disable: "Disable",
    enable: "Enable",
    delete: "Delete",
    notSet: "—",
    saved: "Saved.",
    recording: "Recording…",
    signOut: "Sign out",
    copyResponse: "Copy response",
    copied: "Copied",
    openSource: "Open source",
    language: "Language",
  },

  /**
   * Server actions redirect with an error/warning *code*, never with prose, so
   * the same failure can be shown in any language.
   */
  errors: {
    contentEmpty: "Paste the post text first.",
    contentTooLong: "Content exceeds {limit} characters.",
    analysisFailed:
      "The analysis failed. The lead was saved — the reason is in the activity log.",
    reanalyzeFailed: "Re-analysis failed. Check the activity log.",
    notFound: "That item no longer exists.",
    noAnalysis: "This lead has no stored analysis yet. Run the analysis first.",
    emptyDraft: "The draft cannot be empty.",
    draftMissing: "That draft no longer exists.",
    draftFailed: "The draft could not be generated. Check the activity log.",
    budgetExceeded: "Daily AI call limit reached ({limit}). Raise AI_DAILY_CALL_LIMIT to continue.",
    saveFailed: "Could not save the draft.",
    updateFailed: "Could not update the lead.",
    noteEmpty: "Note cannot be empty.",
    unknownStatus: "Unknown status.",
    unknownQuery: "That item no longer exists.",
    emptyQuery: "Enter a query first.",    keyInvalid:
      "That key cannot be stored in .env: remove $, line breaks and other control characters.",
    keyProbeFailed:
      "The live probe failed — the provider's own answer is in the key health list below.",
    keyProbeNoKey: "No API key is configured, so there is nothing to test. Save a key first.",
    unknown: "Something went wrong. Check the activity log.",
  },

  nav: {
    brand: "Lead Hunter",
    console: "console",
    overview: "Overview",
    leads: "Leads",
    addLead: "Add lead",
    settings: "Settings",
    providerRules: "rules",
  },

  footer: {
    disclaimer:
      "Nothing is ever sent automatically. Review, edit and send every message yourself.",
  },

  login: {
    kicker: "Personal tool · single owner",
    heading: "Lead Hunter",
    subtitle: "Sign in to reach the console.",
    passwordLabel: "Owner password",
    passwordPlaceholder: "••••••••",
    submit: "Sign in",
    errors: {
      invalid: "Wrong password.",
      throttled: "Too many attempts. Wait ten minutes.",
      unconfigured: "No OWNER_PASSWORD(_HASH) is configured in .env yet.",
      generic: "Sign-in failed.",
    },
    setupHintBefore: "Set",
    setupHintPassword: "OWNER_PASSWORD",
    setupHintMiddle: "in",
    setupHintEnv: ".env",
    setupHintAfter: "to enable sign-in, or generate a hash with",
    setupHintThen: "and put it in",
    cookieNote: "Sessions are signed with SESSION_SECRET and kept in an httpOnly cookie.",
  },

  dashboard: {
    kicker: "Today",
    heading: "Who needs your services right now",
    discoveredToday: "discovered today",
    awaitingReview: "awaiting review",
    failedOne: "failed analysis",
    failedMany: "failed analyses",
    tiles: {
      hot: "Hot",
      warm: "Warm",
      cold: "Cold",
      contacted: "Contacted",
      replied: "Replied",
      won: "Won",
      hotHint: "score ≥ 80",
      warmHint: "score 50–79",
      coldHint: "score < 50",
      pipelineValue: "Open pipeline value",
      pipelineHint: "budget ranges of scored, unanswered leads",
      qualified: "Qualified conversations",
      qualifiedHint: "replied and qualified",
      engine: "Last analysis engine",
      engineHintEmpty: "nothing analysed yet",
    },
    newLeads: "New leads",
    allLeads: "All leads →",
    empty: "No new leads yet.",
    emptyCta: "Add one manually",
    emptyAfter: "to exercise the pipeline.",
    followUpsDue: "Follow-ups due",
    nothingToChase: "Nothing to chase today.",
    dueOn: "due",
    rulesTitle: "Pipeline rules",
    rules: [
      "Score ≥ 80 is HOT, 50–79 WARM, below 50 COLD.",
      "Non-leads are archived, never deleted — you can overturn the call.",
      "Duplicates attach to the original lead instead of creating a new row.",
      "Every message is drafted for review; nothing sends itself.",
    ],
  },

  leads: {
    kicker: "Leads",
    countOne: "lead",
    // English has no distinct "few" form; Russian does, so the key must exist here
    // for the two dictionaries to have identical shapes.
    countFew: "leads",
    countMany: "leads",
    filtersActiveOne: "filter active",
    filtersActiveFew: "filters active",
    filtersActiveMany: "filters active",
    addLead: "Add lead",
    search: "Search",
    searchPlaceholder: "woocommerce, telegram bot, author…",
    empty: "No leads match these filters.",
    analysisFailed: "analysis failed",
    page: "page",
    previous: "← Previous",
    next: "Next →",
    filters: {
      status: "Status",
      temperature: "Temperature",
      category: "Category",
      source: "Source",
      urgency: "Urgency",
      minScore: "Min score",
      minBudget: "Min budget",
      location: "Location",
      locationPlaceholder: "Germany",
    },
    columns: {
      score: "Score",
      project: "Project",
      budget: "Budget",
      source: "Source",
      status: "Status",
      age: "Age",
    },
  },

  lead: {
    back: "← All leads",
    leadScore: "Lead score",
    intent: "intent",
    confidence: "confidence",
    openSource: "Open source",
    revisionLabel: "Revision instruction (optional)",
    revisionPlaceholder: "shorter, mention the deadline…",
    generate: "Generate response",
    draftAnother: "Draft another",
    drafting: "Drafting…",
    reanalyze: "Re-analyze",
    reanalyzing: "Re-analyzing…",
    fields: {
      status: "Status",
      category: "Category",
      budget: "Budget",
      urgency: "Urgency",
      source: "Source",
      query: "Found by query",
      author: "Author",
      location: "Location",
      business: "Business",
      discovered: "Discovered",
      posted: "Posted",
      model: "Model",
      analysed: "Analysed",
    },
    sections: {
      original: "Original content",
      analysis: "AI analysis",
      response: "Suggested response",
      status: "Move status",
      followUp: "Follow-up",
      duplicates: "Duplicate sightings",
      note: "Add note",
      activity: "Activity",
      runs: "AI runs",
    },
    noProject: "No project description.",
    recommendedService: "Recommended service",
    intentLabel: "Intent",
    requirements: "Requirements",
    painPoints: "Pain points",
    reasoning: "Reasoning",
    breakdown: "Score breakdown",
    noAnalysis: "No structured analysis stored.",
    noAnalysisFailed: "The last analysis attempt failed — see the activity log.",
    noAnalysisIdle: "Run the analysis to populate this section.",
    draftState: "draft",
    saveEdits: "Save edits",
    draftedBy: "drafted by",
    markContacted: "I sent this — mark contacted",
    sendingManual:
      "Sending is manual. This records it and schedules a follow-up for 3 days out.",
    noDraft: "No draft yet. Use “Generate response” above — the draft is written only from facts in your",
    profile: "profile",
    noDraftTail: ".",
    newStatus: "New status",
    recordOutcome: "Record outcome",
    amount: "amount",
    won: "Won",
    lost: "Lost",
    due: "due",
    markFollowUpDone: "Mark follow-up done",
    duplicateCount: "Duplicate sightings",
    duplicateBanner: "Already tracked",
    duplicateBannerAfter:
      "— the new sighting was logged on this lead instead of creating a duplicate.",
    /**
     * Activity-log line for a deduplicated sighting. The stored `message` column
     * keeps the English original, but the row also carries the reason *code*, so
     * the trail can be re-rendered in the owner's language.
     */
    duplicateEvent: "Duplicate candidate ignored ({reason})",
    duplicateReasons: {
      sameSourceItem: "same source item",
      identicalText: "identical normalized text",
      overlapSameAuthor: "same author, {percent}% text overlap",
      overlapOtherSource: "{percent}% text overlap with another source",
    },
    notePlaceholder: "Called them, they want a call back Friday…",
    addNote: "Add note",
    noActivity: "No activity recorded.",
    noRuns: "No runs yet.",
  },

  newLead: {
    kicker: "Intake",
    heading: "Add a lead",
    intro:
      "Paste a public post or message verbatim. It is normalized, checked for duplicates, analysed by the {provider} provider, scored, and filed with an activity trail. This is also the entry point source adapters will use in Phase 2.",
    providerRules: "rule-based",
    contentLabel: "Post content (required)",
    contentPlaceholder: "Paste the post exactly as it was written…",
    titleLabel: "Title / thread subject",
    authorLabel: "Author handle",
    authorPlaceholder: "u/example",
    urlLabel: "Permalink",
    postedLabel: "Posted at",
    sourceLabel: "Source",
    submit: "Run pipeline",
    analyzing: "Analyzing…",
    savedEvenIfFails: "The lead is saved even if the AI call fails, so nothing is lost.",
    examplesTitle: "Try one of these",
    examplesHint: "Useful for checking how the scoring behaves. Paste into the form to see a HOT, a WARM and a rejected item.",
    exampleStrong: "Strong lead",
    exampleWeak: "Weak lead",
    exampleNotLead: "Not a lead",
  },

  settings: {
    kicker: "Settings",
    heading: "Profile and queries",
    intro:
      "The profile is the only source of facts the AI may use when drafting a reply. If a capability is not listed here, it will not be claimed.",
    saved: "Saved.",
    seedWarning:
      "This profile still holds the seed values. Replace the name, services and portfolio with your real ones — draft quality depends on it.",
    profileSection: "Developer profile",
    name: "Name",
    location: "Location",
    services: "Services (comma separated)",
    languages: "Languages (comma separated)",
    experience: "Experience (short line — quoted only if you write it here)",
    minimumBudget: "Minimum budget",
    tone: "Preferred tone",
    tonePlaceholder: "direct, no fluff",
    portfolio: "Portfolio — one per line: Title | url | description",
    saveProfile: "Save profile",
    seededDefaults: "Seeded defaults:",
    aiProvider: "AI provider",
    active: "Active",
    model: "Model",
    billableCalls: "Model calls today",
    /** Why this provider is active. Codes, so the sentence is translatable. */
    providerReasons: {
      aiApiKey: "AI_API_KEY is set",
      anthropicApiKey: "ANTHROPIC_API_KEY is set",
      openaiForced: "AI_PROVIDER=openai",
      anthropicForced: "AI_PROVIDER=anthropic",
      noKey: "no key is configured, so leads are scored by the rules",
      missingKey: "{key} is missing, so leads are scored by the rules",
    },
    providerActive: "Active because {reason}.",
    providerSetup:
      "Rule-based scoring needs no key. Put a free key in AI_API_KEY to switch to model analysis: Google AI Studio, Groq, OpenRouter or a local Ollama all work, and AI_PROVIDER picks one explicitly.",
    apiKeys: "API keys",
    compatKeyLabel: "Free provider key (Google AI Studio, Groq, OpenRouter…)",
    anthropicKeyLabel: "Anthropic key (optional)",
    keySet: "saved — type a new value to replace it",
    keyNotSet: "not set",
    clearKey: "remove the saved key",
    saveKeys: "Save keys",
    keysHint:
      "Keys are written to .env on the server and only ever travel to the API. This field never shows a stored value; leave it empty to keep what is saved.",
    keyMonitor: "Key health",
    neverChecked:
      "Not checked yet. A check makes one tiny real request to the provider — a few tokens, not the analysis budget.",
    checkNow: "Check the key now",
    checking: "Checking…",
    keyCheckOk: "The key works — the live probe succeeded.",
    savedQueries: "Saved search queries",
    queryPlaceholder: "need a shopify developer",
    adding: "Adding…",
    noQueries: "No queries yet. These drive the Phase 2 source adapters.",
    starterQueries: "Starter queries",
    discovery: "Discovery runs",
    discoveryHint:
      "One row per run. \"Checked, no items\" is a successful check with nothing new; a failed source is listed as an error, not hidden.",
    noRuns: "No scan recorded yet. Run npm run hunt, or install the cron entry described in docs/OPERATIONS.md.",
    runStatuses: {
      RUNNING: "running",
      SUCCEEDED: "succeeded",
      PARTIAL: "partial",
      FAILED: "failed",
    },
    sourceStatuses: {
      OK: "ok",
      EMPTY: "checked, no items",
      ERROR: "error",
      SKIPPED: "skipped",
    },
    runMeta: "{status} · {trigger} · {when}",
    runCounts: "{discovered} found · {created} new · {duplicates} duplicates · {failed} failed",
  },

  enums: {
    categories,
    statuses,
    temperatures,
    urgencies,
    sourceKinds,
    eventTypes,
    analysisStatuses,
    outreachStatuses,
    scoreFactors,
  },
};

export type Dictionary = typeof en;
