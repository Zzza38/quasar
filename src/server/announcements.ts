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
});

type Row = {
  id: number; schoolId: string | null; schoolName: string | null;
  authorName: string; title: string; body: string; createdAt: string; dismissed: number;
};

const visibleRows = `SELECT a.id, a.school_id AS schoolId, s.name AS schoolName, coalesce(nullif(u.display_name, ''), 'Quasar staff') AS authorName, a.title, a.body, a.created_at AS createdAt,
    d.announcement_id IS NOT NULL AS dismissed
  FROM announcements a JOIN users u ON u.id=a.author_id LEFT JOIN schools s ON s.id=a.school_id
  LEFT JOIN announcement_dismissals d ON d.announcement_id=a.id AND d.user_id=@userId
  WHERE (a.school_id IS NULL OR a.school_id=@schoolId)`;

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

  unread(userId: string) {
    return this.db.transaction(() => {
      const schoolId = this.requireEnrollment(userId);
      const row = this.db.prepare(`${visibleRows} AND d.announcement_id IS NULL ORDER BY a.id DESC LIMIT 1`)
        .get({ userId, schoolId }) as Row | undefined;
      return row ? item(row) : null;
    })();
  }

  list(userId: string, before?: number) {
    return this.db.transaction(() => {
      const schoolId = this.requireEnrollment(userId);
      const rows = this.db.prepare(`${visibleRows} AND (@before IS NULL OR a.id<@before) ORDER BY a.id DESC LIMIT @limit`)
        .all({ userId, schoolId, before: before ?? null, limit: pageSize + 1 }) as Row[];
      const items = rows.slice(0, pageSize).map(item);
      return { items, nextBefore: rows.length > pageSize ? items.at(-1)!.id : null };
    })();
  }

  publish(userId: string, raw: z.input<typeof publishAnnouncementSchema>) {
    const input = publishAnnouncementSchema.parse(raw);
    return this.db.transaction(() => {
      this.requireEnrollment(userId);
      const access = this.service.staffAccess(userId);
      if (access?.role !== 'owner' && !(input.schoolId && access?.role === 'school-manager' && access.schoolId === input.schoolId)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the owner or the assigned School Manager can post to this audience.' });
      }
      if (input.schoolId) this.service.school(input.schoolId);
      const existing = this.db.prepare('SELECT id, school_id, title, body FROM announcements WHERE author_id=? AND request_id=?')
        .get(userId, input.requestId) as { id: number; school_id: string | null; title: string; body: string } | undefined;
      if (existing) {
        if (existing.school_id !== input.schoolId || existing.title !== input.title || existing.body !== input.body) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This post request already published a different announcement.' });
        }
        return { id: existing.id };
      }
      const createdAt = new Date().toISOString();
      const { lastInsertRowid } = this.db.prepare('INSERT INTO announcements(school_id,author_id,request_id,title,body,created_at) VALUES(?,?,?,?,?,?)')
        .run(input.schoolId, userId, input.requestId, input.title, input.body, createdAt);
      const id = Number(lastInsertRowid);
      this.db.prepare('INSERT INTO announcement_dismissals(user_id,announcement_id,dismissed_at) VALUES(?,?,?)').run(userId, id, createdAt);
      this.service.audit(userId, 'announcement.publish', input.schoolId, { announcementId: id }, createdAt);
      return { id };
    }).immediate();
  }

  dismiss(userId: string, id: number) {
    this.db.transaction(() => {
      const schoolId = this.requireEnrollment(userId);
      const visible = this.db.prepare('SELECT 1 FROM announcements WHERE id=? AND (school_id IS NULL OR school_id=?)')
        .get(id, schoolId);
      if (!visible) throw new TRPCError({ code: 'NOT_FOUND', message: 'Announcement not found.' });
      this.db.prepare('INSERT OR IGNORE INTO announcement_dismissals(user_id,announcement_id,dismissed_at) VALUES(?,?,?)')
        .run(userId, id, new Date().toISOString());
    }).immediate();
  }
}
