import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { DEFAULT_FEED_GUIDES, FEED_PLATFORMS, feedGuideSchema, feedPlatformsSchema, guideImages, type FeedGuide, type FeedGuides, type FeedPlatform } from '@/domain/feed-guides';
import { prepareChatImage } from './chat-images';
import type { Service } from './service';

/**
 * The calendar-link guides (src/domain/feed-guides.ts) and the support tools that edit them (/admin → Setup guide,
 * and each school's Setup sheet). Students read them resolved, with their workspace.
 */

const fail = (code: 'NOT_FOUND' | 'BAD_REQUEST', message: string): never => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();
/** An upload no saved guide shows is removed after this long, so an editor left open keeps its new screenshots. */
export const UNUSED_IMAGE_MS = 86_400_000;

export const saveFeedGuideSchema = z.object({ schoolId: z.uuid().nullable(), platform: z.enum(FEED_PLATFORMS), guide: feedGuideSchema.nullable() });
export const feedPlatformsUpdateSchema = z.object({ schoolId: z.uuid(), platforms: feedPlatformsSchema });
export const guideImageUploadSchema = z.object({ data: z.string() });

type GuideRow = { school_id: string; platform: FeedPlatform; guide: string };
/** Support's view of one scope: the guide saved there for each platform, or null where the next level down applies. */
export type GuideOverrides = Record<FeedPlatform, FeedGuide | null>;
export type AdminFeedGuides = { platforms: FeedPlatform[]; global: GuideOverrides; school: GuideOverrides | null };

export function parseFeedPlatforms(stored: string): FeedPlatform[] {
  const list = stored.split(',');
  return FEED_PLATFORMS.filter((platform) => list.includes(platform));
}

export class FeedGuideService {
  constructor(private readonly service: Service) {}
  private get db() { return this.service.db; }

  private overrides(schoolId: string): GuideOverrides {
    const rows = this.db.prepare('SELECT * FROM feed_guides WHERE school_id=?').all(schoolId) as GuideRow[];
    const saved = Object.fromEntries(FEED_PLATFORMS.map((platform) => [platform, null])) as GuideOverrides;
    for (const row of rows) {
      // A row that no longer parses (an older shape) falls back to the next level instead of breaking the page.
      const parsed = feedGuideSchema.safeParse(JSON.parse(row.guide));
      if (parsed.success && row.platform in saved) saved[row.platform] = parsed.data;
    }
    return saved;
  }

  private platforms(schoolId: string): FeedPlatform[] {
    const row = this.db.prepare('SELECT feed_platforms FROM schools WHERE id=?').get(schoolId) as { feed_platforms: string } | undefined;
    if (!row) return fail('NOT_FOUND', 'School not found.');
    return parseFeedPlatforms(row.feed_platforms);
  }

  /** The guides a member of `schoolId` sees: the school's own, else support's platform guide, else the built-in one. */
  resolved(schoolId: string | null): FeedGuides {
    const global = this.overrides('');
    const school = schoolId ? this.overrides(schoolId) : null;
    const guides = Object.fromEntries(FEED_PLATFORMS.map((platform) => [platform, school?.[platform] ?? global[platform] ?? DEFAULT_FEED_GUIDES[platform]])) as Record<FeedPlatform, FeedGuide>;
    return { platforms: schoolId ? this.platforms(schoolId) : [], guides };
  }

  adminView(adminId: string, schoolId: string | null): AdminFeedGuides {
    this.service.admin(adminId);
    return { platforms: schoolId ? this.platforms(schoolId) : [], global: this.overrides(''), school: schoolId ? this.overrides(schoolId) : null };
  }

  /** Saves the guide for every school (`schoolId` null) or one school. A null guide goes back to the next level down. */
  save(adminId: string, raw: z.input<typeof saveFeedGuideSchema>): void {
    this.service.admin(adminId);
    const input = saveFeedGuideSchema.parse(raw);
    const scope = input.schoolId ?? '';
    this.db.transaction(() => {
      if (input.schoolId) this.service.school(input.schoolId);
      if (input.guide) {
        for (const image of guideImages(input.guide)) {
          if (!this.db.prepare('SELECT 1 FROM feed_guide_images WHERE id=?').get(image)) fail('BAD_REQUEST', 'A screenshot in this guide was removed. Add it again.');
        }
        this.db.prepare(`INSERT INTO feed_guides(school_id,platform,guide,updated_at,updated_by) VALUES(?,?,?,?,?)
          ON CONFLICT(school_id,platform) DO UPDATE SET guide=excluded.guide, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
          .run(scope, input.platform, JSON.stringify(input.guide), now(), adminId);
      } else {
        this.db.prepare('DELETE FROM feed_guides WHERE school_id=? AND platform=?').run(scope, input.platform);
      }
      this.service.audit(adminId, input.guide ? 'feedGuide.save' : 'feedGuide.reset', input.schoolId, { platform: input.platform, ...(input.guide ? { steps: input.guide.steps.length } : {}) });
      this.pruneImages();
    }).immediate();
  }

  setPlatforms(adminId: string, raw: z.input<typeof feedPlatformsUpdateSchema>): FeedPlatform[] {
    this.service.admin(adminId);
    const input = feedPlatformsUpdateSchema.parse(raw);
    return this.db.transaction(() => {
      const from = this.platforms(input.schoolId);
      this.db.prepare('UPDATE schools SET feed_platforms=? WHERE id=?').run(input.platforms.join(','), input.schoolId);
      if (from.join(',') !== input.platforms.join(',')) this.service.audit(adminId, 'feedGuide.platforms', input.schoolId, { from, to: input.platforms });
      return input.platforms;
    }).immediate();
  }

  /** Re-encodes a screenshot the way chat images are (metadata stripped, at most 1600 px) and returns its id. */
  async uploadImage(adminId: string, raw: z.input<typeof guideImageUploadSchema>): Promise<{ id: string }> {
    this.service.admin(adminId);
    const data = await prepareChatImage(guideImageUploadSchema.parse(raw).data);
    const id = randomUUID();
    this.db.prepare('INSERT INTO feed_guide_images(id,image,created_at,created_by) VALUES(?,?,?,?)').run(id, Buffer.from(data!, 'base64'), now(), adminId);
    return { id };
  }

  image(id: string): Buffer | null {
    const row = this.db.prepare('SELECT image FROM feed_guide_images WHERE id=?').get(id) as { image: Buffer } | undefined;
    return row?.image ?? null;
  }

  private pruneImages(): void {
    const used = new Set<string>();
    for (const row of this.db.prepare('SELECT guide FROM feed_guides').all() as { guide: string }[]) {
      const parsed = feedGuideSchema.safeParse(JSON.parse(row.guide));
      if (parsed.success) for (const image of guideImages(parsed.data)) used.add(image);
    }
    const cutoff = new Date(Date.now() - UNUSED_IMAGE_MS).toISOString();
    const stale = this.db.prepare('SELECT id FROM feed_guide_images WHERE created_at<?').all(cutoff) as { id: string }[];
    const remove = this.db.prepare('DELETE FROM feed_guide_images WHERE id=?');
    for (const { id } of stale) if (!used.has(id)) remove.run(id);
  }
}
