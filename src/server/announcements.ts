import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { currentBetaRegistry } from './beta-registry';
import type { Service } from './service';

const pageSize = 30;
const plainText = (max: number) => z.string().trim().min(1).max(max).refine(
  value => !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value), 'Use plain text in announcements.',
);
export const announcementPageSchema = z.object({ before: z.number().int().positive().optional() });
export const publishAnnouncementSchema = z.object({
  requestId: z.uuid(), schoolId: z.uuid().nullable(), title: plainText(120), body: plainText(4000),
  publishAt: z.iso.datetime().transform(value => new Date(value).toISOString()).optional(),
});

type Row = {
  id: number; schoolId: string | null; schoolName: string | null;
  authorName: string; title: string; body: string; createdAt: string; publishAt: string; dismissed: number;
};

const publication = 'coalesce(a.publish_at, a.created_at)';
const audience = '(a.school_id IS NULL OR a.school_id=@schoolId)';
const published = `${audience} AND a.cancelled_at IS NULL AND ${publication}<=@now`;
const announcementRows = `SELECT a.id, a.school_id AS schoolId, s.name AS schoolName, coalesce(nullif(u.display_name, ''), 'Quasar staff') AS authorName, a.title, a.body, a.created_at AS createdAt, ${publication} AS publishAt,
    d.announcement_id IS NOT NULL AS dismissed
  FROM announcements a JOIN users u ON u.id=a.author_id LEFT JOIN schools s ON s.id=a.school_id
  LEFT JOIN announcement_dismissals d ON d.announcement_id=a.id AND d.user_id=@userId`;

function item(row: Row) { return { ...row, dismissed: !!row.dismissed }; }

export class AnnouncementService {
  constructor(private readonly service: Service) {}
  private get db() { return this.service.db; }

  private requireEnrollment(userId: string) {
    const joined = this.db.prepare(`SELECT u.school_id AS schoolId FROM users u JOIN beta_members b ON b.user_id=u.id
      WHERE u.id=? AND u.suspended_at IS NULL AND b.beta_key='announcements'`).get(userId) as { schoolId: string | null } | undefined;
    if (!joined || !currentBetaRegistry().betas.some(beta => beta.key === 'announcements')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Join the Announcements beta to use the board.' });
    }
    return joined.schoolId;
  }

  /** A null scope here belongs only to the owner. */
  private publisherScope(userId: string) {
    const access = this.service.staffAccess(userId);
    if (access?.role === 'owner') return null;
    if (access?.role === 'school-manager' && access.schoolId) return access.schoolId;
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the owner or the assigned School Manager can post to this audience.' });
  }

  upcoming(userId: string) {
    return this.db.transaction(() => {
      this.requireEnrollment(userId);
      const scope = this.publisherScope(userId);
      const rows = this.db.prepare(`${announcementRows} WHERE a.cancelled_at IS NULL AND a.publish_at>@now AND (@scope IS NULL OR a.school_id=@scope)
        ORDER BY a.publish_at, a.id LIMIT 100`).all({ userId, scope, now: new Date().toISOString() }) as Row[];
      return rows.map(item);
    })();
  }

  unread(userId: string) {
    return this.db.transaction(() => {
      const schoolId = this.requireEnrollment(userId);
      const row = this.db.prepare(`${announcementRows} WHERE ${published} AND d.announcement_id IS NULL ORDER BY ${publication} DESC, a.id DESC LIMIT 1`)
        .get({ userId, schoolId, now: new Date().toISOString() }) as Row | undefined;
      return row ? item(row) : null;
    })();
  }

  list(userId: string, before?: number) {
    return this.db.transaction(() => {
      const schoolId = this.requireEnrollment(userId);
      // Keep the ID cursor older clients send. Resolve its (release time, ID) within this reader's audience.
      const rows = this.db.prepare(`${announcementRows} WHERE ${published} AND (@before IS NULL OR
        (${publication}, a.id)<(SELECT ${publication}, a.id FROM announcements a WHERE a.id=@before AND ${published}))
        ORDER BY ${publication} DESC, a.id DESC LIMIT @limit`)
        .all({ userId, schoolId, now: new Date().toISOString(), before: before ?? null, limit: pageSize + 1 }) as Row[];
      const items = rows.slice(0, pageSize).map(item);
      return { items, nextBefore: rows.length > pageSize ? items.at(-1)!.id : null };
    })();
  }

  publish(userId: string, raw: z.input<typeof publishAnnouncementSchema>) {
    const input = publishAnnouncementSchema.parse(raw);
    return this.db.transaction(() => {
      this.requireEnrollment(userId);
      const scope = this.publisherScope(userId);
      if (scope !== null && scope !== input.schoolId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the owner or the assigned School Manager can post to this audience.' });
      }
      if (input.schoolId) this.service.school(input.schoolId);
      const existing = this.db.prepare('SELECT id, school_id, title, body, publish_at, cancelled_at FROM announcements WHERE author_id=? AND request_id=?')
        .get(userId, input.requestId) as { id: number; school_id: string | null; title: string; body: string; publish_at: string | null; cancelled_at: string | null } | undefined;
      if (existing) {
        if (existing.cancelled_at) throw new TRPCError({ code: 'CONFLICT', message: 'This scheduled announcement was cancelled.' });
        if (existing.school_id !== input.schoolId || existing.title !== input.title || existing.body !== input.body || existing.publish_at !== (input.publishAt ?? null)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This post request already published a different announcement.' });
        }
        return { id: existing.id };
      }
      const createdAt = new Date().toISOString();
      if (input.publishAt && input.publishAt <= createdAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose a publication time in the future.' });
      }
      const { lastInsertRowid } = this.db.prepare('INSERT INTO announcements(school_id,author_id,request_id,title,body,created_at,publish_at) VALUES(?,?,?,?,?,?,?)')
        .run(input.schoolId, userId, input.requestId, input.title, input.body, createdAt, input.publishAt ?? null);
      const id = Number(lastInsertRowid);
      this.db.prepare('INSERT INTO announcement_dismissals(user_id,announcement_id,dismissed_at) VALUES(?,?,?)').run(userId, id, createdAt);
      this.service.audit(userId, 'announcement.publish', input.schoolId, { announcementId: id, ...(input.publishAt ? { publishAt: input.publishAt } : {}) }, createdAt);
      return { id };
    }).immediate();
  }

  cancel(userId: string, id: number) {
    this.db.transaction(() => {
      this.requireEnrollment(userId);
      const scope = this.publisherScope(userId);
      const row = this.db.prepare(`SELECT school_id, publish_at, cancelled_at FROM announcements
        WHERE id=@id AND (@scope IS NULL OR school_id=@scope)`).get({ id, scope }) as
        { school_id: string | null; publish_at: string | null; cancelled_at: string | null } | undefined;
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Scheduled announcement not found.' });
      if (row.cancelled_at) return;
      const now = new Date().toISOString();
      if (!row.publish_at || row.publish_at <= now) throw new TRPCError({ code: 'CONFLICT', message: 'This announcement has already been published.' });
      this.db.prepare('UPDATE announcements SET cancelled_at=? WHERE id=?').run(now, id);
      this.service.audit(userId, 'announcement.cancel', row.school_id, { announcementId: id, publishAt: row.publish_at }, now);
    }).immediate();
  }

  dismiss(userId: string, id: number) {
    this.db.transaction(() => {
      const schoolId = this.requireEnrollment(userId);
      const now = new Date().toISOString();
      const visible = this.db.prepare(`SELECT 1 FROM announcements a WHERE a.id=@id AND ${published}`)
        .get({ id, schoolId, now });
      if (!visible) throw new TRPCError({ code: 'NOT_FOUND', message: 'Announcement not found.' });
      this.db.prepare('INSERT OR IGNORE INTO announcement_dismissals(user_id,announcement_id,dismissed_at) VALUES(?,?,?)')
        .run(userId, id, now);
    }).immediate();
  }
}
