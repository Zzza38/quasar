import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
async function main() {
  const source=resolve(process.env.DATABASE_PATH || './data/quasar.sqlite');
  const destination=process.argv[2];
  if (!destination || resolve(destination)===source) throw new Error('Usage: npm run db:backup -- /secure/path/backup.sqlite (destination must differ from source)');
  mkdirSync(dirname(resolve(destination)),{recursive:true,mode:0o700});
  const db=new Database(source,{readonly:true,fileMustExist:true});
  try {
    await db.backup(destination);
    chmodSync(destination,0o600);
    const check=new Database(destination,{readonly:true});
    try { if (check.pragma('integrity_check',{simple:true})!=='ok') throw new Error('Backup integrity check failed'); }
    finally { check.close(); }
    console.log(`Verified backup written to ${resolve(destination)}`);
  } finally {db.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
