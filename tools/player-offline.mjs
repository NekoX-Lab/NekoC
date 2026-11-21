// The version covers every byte of the shell, WASM and caching policy, not just
// a hand-maintained release number. An incomplete deploy never replaces it.
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function writeOfflineWorker(directory,files){
  const template=await readFile(new URL('../web/offline-sw.js',import.meta.url),'utf8');
  const names=[...files].sort(),hash=createHash('sha256').update(template),digests={};
  for(const name of names){
    const bytes=await readFile(path.join(directory,name));
    hash.update(name+'\0');hash.update(bytes);digests[name]=createHash('sha256').update(bytes).digest('hex');
  }
  const build={version:hash.digest('hex'),files:names,digests};
  await writeFile(path.join(directory,'offline-sw.js'),template.replace('__NEKOC_OFFLINE_BUILD__',JSON.stringify(build)));
  return build;
}
