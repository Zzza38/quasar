import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { GUIDE_KINDS, GUIDES, guideImages, guideKeys, knownPlatforms, setupGuideSchema, type GuideKind, type GuideSet, type SetupGuide } from '@/domain/setup-guides';
import { prepareChatImage } from './chat-images';
import type { Service } from './service';

/**
 * The setup guides (src/domain/setup-guides.ts) and the support tools that edit them (/admin → Setup guides, and each
 * school's Setup sheet). Students read them resolved, with their workspace.
 */

const fail = (code: 'NOT_FOUND' | 'BAD_REQUEST', message: string): never => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();
/** An upload no saved guide shows is removed after this long, so an editor left open keeps its new screenshots. */
export const UNUSED_IMAGE_MS = 86_400_000;
/** Where each kind is stored (migrations 27 and 28). A row with school_id '' is the guide every school shares. */
const STORE: Record<GuideKind, { table: string; column: string }> = {
  calendar: { table: 'feed_guides', column: 'feed_platforms' },
  schedule: { table: 'schedule_guides', column: 'schedule_platforms' },
};

const kindSchema = z.enum(GUIDE_KINDS);
export const saveGuideSchema = z.object({ kind: kindSchema, schoolId: z.uuid().nullable(), platform: z.string().max(40), guide: setupGuideSchema.nullable() })
  .refine((input) => guideKeys(input.kind).includes(input.platform), { message: 'Unknown platform.', path: ['platform'] });
export const guidePlatformsUpdateSchema = z.object({ kind: kindSchema, schoolId: z.uuid(), platforms: z.array(z.string().max(40)).max(12) })
  .refine((input) => input.platforms.every((platform) => GUIDES[input.kind].platforms.includes(platform)), { message: 'Unknown platform.', path: ['platforms'] })
  .transform((input) => ({ ...input, platforms: knownPlatforms(input.kind, input.platforms) }));
export const guideImageUploadSchema = z.object({ data: z.string() });

type GuideRow = { platform: string; guide: string };
/** Support's view of one scope: the guide saved there for each guide key, or null where the next level down applies. */
export type GuideOverrides = Record<string, SetupGuide | null>;
export type AdminGuideKind = { platforms: string[]; global: GuideOverrides; school: GuideOverrides | null };
export type AdminGuides = Record<GuideKind, AdminGuideKind>;

export function parsePlatforms(kind: GuideKind, stored: string): string[] {
  return knownPlatforms(kind, stored.split(','));
}

export class SetupGuideService {
  constructor(private readonly service: Service) {}
  private get db() { return this.service.db; }

  private overrides(kind: GuideKind, schoolId: string): GuideOverrides {
    const keys = guideKeys(kind);
    const rows = this.db.prepare(`SELECT platform, guide FROM ${STORE[kind].table} WHERE school_id=?`).all(schoolId) as GuideRow[];
    const saved: GuideOverrides = Object.fromEntries(keys.map((key) => [key, null]));
    for (const row of rows) {
      // A row that no longer parses (an older shape) falls back to the next level instead of breaking the page.
      const parsed = setupGuideSchema.safeParse(JSON.parse(row.guide));
      if (parsed.success && keys.includes(row.platform)) saved[row.platform] = parsed.data;
    }
    return saved;
  }

  private platforms(kind: GuideKind, schoolId: string): string[] {
    const row = this.db.prepare(`SELECT ${STORE[kind].column} AS platforms FROM schools WHERE id=?`).get(schoolId) as { platforms: string } | undefined;
    if (!row) return fail('NOT_FOUND', 'School not found.');
    return parsePlatforms(kind, row.platforms);
  }

  /** The guides a member of `schoolId` sees: the school's own, else the one every school shares, else the built-in one. */
  resolved(kind: GuideKind, schoolId: string | null): GuideSet {
    const global = this.overrides(kind, '');
    const school = schoolId ? this.overrides(kind, schoolId) : null;
    const guides = Object.fromEntries(guideKeys(kind).map((key) => [key, school?.[key] ?? global[key] ?? GUIDES[kind].defaults[key]]));
    return { platforms: schoolId ? this.platforms(kind, schoolId) : [], guides };
  }

  adminView(adminId: string, schoolId: string | null): AdminGuides {
    this.service.admin(adminId);
    const view = (kind: GuideKind): AdminGuideKind => ({
      platforms: schoolId ? this.platforms(kind, schoolId) : [], global: this.overrides(kind, ''), school: schoolId ? this.overrides(kind, schoolId) : null,
    });
    return { calendar: view('calendar'), schedule: view('schedule') };
  }

  /** Saves a guide for every school (`schoolId` null) or one school. A null guide goes back to the next level down. */
  save(adminId: string, raw: z.input<typeof saveGuideSchema>): void {
    this.service.admin(adminId);
    const input = saveGuideSchema.parse(raw);
    const scope = input.schoolId ?? '';
    const { table } = STORE[input.kind];
    this.db.transaction(() => {
      if (input.schoolId) this.service.school(input.schoolId);
      if (input.guide) {
        for (const image of guideImages(input.guide)) {
          if (!this.db.prepare('SELECT 1 FROM feed_guide_images WHERE id=?').get(image)) fail('BAD_REQUEST', 'A screenshot in this guide was removed. Add it again.');
        }
        this.db.prepare(`INSERT INTO ${table}(school_id,platform,guide,updated_at,updated_by) VALUES(?,?,?,?,?)
          ON CONFLICT(school_id,platform) DO UPDATE SET guide=excluded.guide, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
          .run(scope, input.platform, JSON.stringify(input.guide), now(), adminId);
      } else {
        this.db.prepare(`DELETE FROM ${table} WHERE school_id=? AND platform=?`).run(scope, input.platform);
      }
      this.service.audit(adminId, input.guide ? 'setupGuide.save' : 'setupGuide.reset', input.schoolId, { kind: input.kind, platform: input.platform, ...(input.guide ? { steps: input.guide.steps.length } : {}) });
      this.pruneImages();
    }).immediate();
  }

  setPlatforms(adminId: string, raw: z.input<typeof guidePlatformsUpdateSchema>): string[] {
    this.service.admin(adminId);
    const input = guidePlatformsUpdateSchema.parse(raw);
    return this.db.transaction(() => {
      const from = this.platforms(input.kind, input.schoolId);
      this.db.prepare(`UPDATE schools SET ${STORE[input.kind].column}=? WHERE id=?`).run(input.platforms.join(','), input.schoolId);
      if (from.join(',') !== input.platforms.join(',')) this.service.audit(adminId, 'setupGuide.platforms', input.schoolId, { kind: input.kind, from, to: input.platforms });
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
    for (const kind of GUIDE_KINDS) {
      for (const row of this.db.prepare(`SELECT guide FROM ${STORE[kind].table}`).all() as { guide: string }[]) {
        const parsed = setupGuideSchema.safeParse(JSON.parse(row.guide));
        if (parsed.success) for (const image of guideImages(parsed.data)) used.add(image);
      }
    }
    const cutoff = new Date(Date.now() - UNUSED_IMAGE_MS).toISOString();
    const stale = this.db.prepare('SELECT id FROM feed_guide_images WHERE created_at<?').all(cutoff) as { id: string }[];
    const remove = this.db.prepare('DELETE FROM feed_guide_images WHERE id=?');
    for (const { id } of stale) if (!used.has(id)) remove.run(id);
  }
}
