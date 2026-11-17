import { z } from 'zod';

/**
 * AI task helpers (README "AI task helpers"), shared by the server and the Account sheet. A member brings their own
 * key from one of these providers, or connects OpenRouter, and their requests run on it; otherwise they run on the
 * server's own model with a daily quota. Only these base URLs are ever called with a member's key: a member can't
 * point the server at an address of their choosing.
 */
export const AI_BETA = 'ai-tools';

export const AI_PROVIDERS = {
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-6-luna', keysPage: 'https://platform.openai.com/api-keys', json: true },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: '~openai/gpt-luna-latest', keysPage: 'https://openrouter.ai/settings/keys', json: true },
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keysPage: 'https://platform.deepseek.com/api_keys', json: true },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', keysPage: 'https://console.anthropic.com/settings/keys', json: false },
  google: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', keysPage: 'https://aistudio.google.com/apikey', json: false },
} as const;
export type AiProvider = keyof typeof AI_PROVIDERS;
export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as [AiProvider, ...AiProvider[]];
export const aiProviderSchema = z.enum(AI_PROVIDER_IDS);

/** Tasks one "Sort with AI" request may carry; the client sends the soonest-due ones first. */
export const AI_SORT_MAX = 40;
/** Daily requests on the server's model, per account. A member's own key has only the hourly limit. */
export const AI_SORT_DAILY_LIMIT = 20;
export const AI_BREAKDOWN_DAILY_LIMIT = 30;
/** Daily requests on the server's model for Quasar AI Plus subscribers (src/server/billing.ts). */
export const AI_PLUS_SORT_DAILY_LIMIT = 200;
export const AI_PLUS_BREAKDOWN_DAILY_LIMIT = 300;
/** Test-and-quiz checks per day on the server's model (each sends only tasks not checked before), free and Plus. */
export const AI_CLASSIFY_DAILY_LIMIT = 40;
export const AI_PLUS_CLASSIFY_DAILY_LIMIT = 400;
/** How far ahead Upcoming tests and quizzes looks, and how many tasks one check sends. */
export const ASSESSMENT_DAYS = 21;
export const AI_CLASSIFY_MAX = 40;
/**
 * Duplicate checks per day on the server's model, free and Plus. One check reads up to AI_DEDUP_MAX tasks: open ones
 * and those completed in the last AI_DEDUP_RECENT_DAYS, so a copy already checked off still finds its twin.
 */
export const AI_DEDUP_DAILY_LIMIT = 20;
export const AI_PLUS_DEDUP_DAILY_LIMIT = 200;
export const AI_DEDUP_MAX = 80;
export const AI_DEDUP_RECENT_DAYS = 14;
/**
 * Plus features (README "Quasar AI Plus"). Free accounts get a small taste of each AI one every day, and Plus a
 * daily allowance like the others. While billing isn't set up on the server everyone in the beta has them unlocked.
 * - plan: Plan my week, study blocks for upcoming tests and big work placed in the student's free periods;
 * - photo: Photo to tasks, a photo of a whiteboard, syllabus or handout turned into tasks;
 * - study: flashcards and a practice quiz for a test, from the student's notes or a photo of the study guide;
 * - estimate: minutes per task, for the crunch-day warnings.
 * The parent summary link has no AI and no quota: it is simply Plus only.
 */
export const AI_PLAN_DAILY_LIMIT = 2;
export const AI_PLUS_PLAN_DAILY_LIMIT = 30;
export const AI_PHOTO_DAILY_LIMIT = 3;
export const AI_PLUS_PHOTO_DAILY_LIMIT = 60;
export const AI_STUDY_DAILY_LIMIT = 2;
export const AI_PLUS_STUDY_DAILY_LIMIT = 60;
export const AI_ESTIMATE_DAILY_LIMIT = 10;
export const AI_PLUS_ESTIMATE_DAILY_LIMIT = 200;
/** Requests of any kind per account per hour, own key included, so a loop in a client can't hammer a provider. */
export const AI_HOURLY_LIMIT = 30;
/** Checklist steps one "Break it down" adds at most. */
export const AI_MAX_STEPS = 10;
