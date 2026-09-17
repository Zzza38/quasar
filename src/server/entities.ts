import type { Db } from './db';
import type { Entity } from '@/domain/sync';
export function readEntity(db:Db,owner:string,id:string):Entity|null {
  const row=db.prepare('SELECT * FROM entities WHERE owner_id=? AND id=?').get(owner,id) as {id:string;kind:Entity['kind'];version:number;data:string;deleted:number}|undefined;
  return row ? {id:row.id,kind:row.kind,version:row.version,data:JSON.parse(row.data),deleted:!!row.deleted} : null;
}
/** Caller must include this and associated receipts/metadata in one transaction. */
export function writeEntity(db:Db,owner:string,entity:Entity):void {
  db.prepare(`INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,?,?,?,?)
    ON CONFLICT(owner_id,id) DO UPDATE SET version=excluded.version,data=excluded.data,deleted=excluded.deleted`)
    .run(owner,entity.id,entity.kind,entity.version,JSON.stringify(entity.data),Number(entity.deleted));
  db.prepare('INSERT INTO entity_history VALUES(?,?,?,?)').run(owner,entity.id,entity.version,JSON.stringify(entity));
}
