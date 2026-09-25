import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// The copy is written under a temporary name and only renamed to the final name once it
// passes integrity_check, so a failed or interrupted run never leaves a file that looks
// like a verified backup. The umask keeps every file this run creates private.
process.umask(0o077);
const companions=['', '-journal', '-wal', '-shm'];
function removeWithCompanions(path: string) {
  for (const suffix of companions) rmSync(`${path}${suffix}`,{force:true});
}
async function main() {
  const source=resolve(process.env.DATABASE_PATH || './data/quasar.sqlite');
  const destination=process.argv[2];
  const target=destination ? resolve(destination) : '';
  // The final rename replaces whatever sits at the destination, so it must not be the live
  // database or one of its -journal/-wal/-shm companions.
  if (!target || companions.some(suffix=>target===`${source}${suffix}`)) throw new Error('Usage: npm run db:backup -- /secure/path/backup.sqlite (destination must differ from source)');
  // A fresh random name can never collide with the source database, its companions or any
  // file the operator already has, so this run only ever deletes files it created itself.
  const temporary=join(dirname(target),`${basename(target)}.${randomUUID()}.partial`);
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  const cleanupOnSignal=(signal: NodeJS.Signals)=>{
    removeWithCompanions(temporary);
    process.exit(128+(signal==='SIGINT'?2:15));
  };
  process.once('SIGTERM',cleanupOnSignal);
  process.once('SIGINT',cleanupOnSignal);
  const db=new Database(source,{readonly:true,fileMustExist:true});
  try {
    await db.backup(temporary);
    // The online backup copies the source header, so the copy starts in WAL mode. Switch it
    // to a rollback journal on a read-write connection so the backup is one standalone file
    // with no -wal/-shm companions left beside it.
    const check=new Database(temporary,{fileMustExist:true});
    try {
      if (check.pragma('journal_mode = DELETE',{simple:true})!=='delete') throw new Error('Could not switch backup out of WAL mode');
      if (check.pragma('integrity_check',{simple:true})!=='ok') throw new Error('Backup integrity check failed');
    } finally { check.close(); }
    for (const suffix of companions.slice(1)) rmSync(`${temporary}${suffix}`,{force:true});
    chmodSync(temporary,0o600);
    renameSync(temporary,target);
    console.log(`Verified backup written to ${target}`);
  } catch (error) {
    removeWithCompanions(temporary);
    throw error;
  } finally {
    db.close();
    process.off('SIGTERM',cleanupOnSignal);
    process.off('SIGINT',cleanupOnSignal);
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
