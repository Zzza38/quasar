/** Publish the configured owner's saved class metadata after explicit owner approval. */
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/server/db';
import { Service } from '../src/server/service';
import { DirectoryService } from '../src/server/directory';
import { GRADES, personalScheduleSchema } from '../src/domain/schedule';

const db = openDatabase();
try {
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('OWNER_EMAIL is required. Load the production environment explicitly.');
  const owner = db.prepare('SELECT id FROM users WHERE lower(email)=?').get(email) as { id: string } | undefined;
  if (!owner) throw new Error('The configured owner has no saved account.');
  const service = new Service(db);
  service.admin(owner.id);
  const schoolId = service.user(owner.id).schoolId;
  if (!schoolId) throw new Error('The owner must belong to a school.');
  const directory = new DirectoryService(service);
  let published = 0;
  db.transaction(() => {
    const base = service.entity(owner.id, 'personal');
    if (!base || base.deleted) throw new Error('No saved personal schedule.');
    const personal = personalScheduleSchema.parse(base.data);
    const existing = directory.list(owner.id, schoolId).classes;
    const classes = personal.classes.map(cls => {
      const match = existing.find(entry => entry.id === cls.directoryId || (entry.name.toLowerCase() === cls.name.toLowerCase() && (entry.teacher ?? '') === (cls.teacher ?? '') && (entry.room ?? '') === (cls.room ?? '')));
      const entry = match ?? directory.save(owner.id, { schoolId, details: { name: cls.name, teacher: cls.teacher, room: cls.room, grades: personal.grade ? [personal.grade] : [...GRADES] } });
      if (!match) { published++; existing.push(entry); }
      return { ...cls, directoryId: entry.id };
    });
    if (JSON.stringify(classes) !== JSON.stringify(personal.classes)) {
      const result = service.sync(owner.id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: { ...personal, classes } });
      if (result.status !== 'applied') throw new Error('The owner schedule changed. Retry after syncing.');
    }
  })();
  console.log(`Published ${published} classes; personal class IDs, assignments, and local details preserved.`);
} finally { db.close(); }
