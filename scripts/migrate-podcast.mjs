import fs from 'node:fs/promises';
import path from 'node:path';
import { podcastDir, episodesDir, stateDir, readJson, writeJson, inspectAudio, publicObjectKey, episodeJsonFileName, ensureObject, episodeFromAudio, ensureDirs, validateMigrationCatalog, markMigrationInProgress, s3Config, s3Client } from './podcast-lib.mjs';

const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const audioRoot = arg('--audio-root');
if (!audioRoot) throw new Error('Укажите --audio-root');
const mapping = await readJson(path.join(podcastDir, 'migration/mapping.json'));
await validateMigrationCatalog();
if (!mapping.entries?.length || mapping.entries.some(entry => entry.status !== 'matched')) throw new Error('Миграция остановлена: карта неполна или содержит пропуски');
const planned = [];
const keys = new Map();
for (const entry of mapping.entries) {
  const file = path.join(audioRoot, entry.audioPath);
  const episodeFile = episodeJsonFileName(path.basename(entry.audioPath));
  const base = await readJson(path.join(episodesDir, episodeFile));
  const audio = await inspectAudio(file);
  if (audio.sha256 !== entry.sha256 || audio.size !== entry.size) throw new Error(`Файл изменился: ${entry.audioPath}`);
  const key = publicObjectKey(path.basename(entry.audioPath));
  if (keys.has(key) && keys.get(key) !== entry.audioPath) throw new Error(`Коллизия имени объекта ${key}: разные локальные пути`);
  keys.set(key, entry.audioPath);
  if (base.audio?.sha256 && base.audio.sha256 !== entry.sha256) throw new Error(`Миграция остановлена: выпуск ${entry.guid} уже изменён после первоначальной миграции`);
  planned.push({ entry, base, file, audio, key });
}
const config = s3Config();
const s3 = s3Client(config);
const expectedUrl = key => `${s3.publicBaseUrl}/${key}`;
for (const item of planned) {
  let state;
  try {
    state = await readJson(path.join(stateDir, `${item.entry.stableId}.json`));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  const url = expectedUrl(item.key);
  item.confirmed = state.kind === 'migration'
    && state.status === 'uploaded'
    && state.stableId === item.entry.stableId
    && state.guid === item.entry.guid
    && item.base.stableId === item.entry.stableId
    && item.base.guid === item.entry.guid
    && state.sha256 === item.audio.sha256
    && state.size === item.audio.size
    && state.sha256 === item.entry.sha256
    && state.size === item.entry.size
    && item.base.audio?.sha256 === item.audio.sha256
    && item.base.audio?.size === item.audio.size
    && item.base.audio?.sha256 === item.entry.sha256
    && item.base.audio?.size === item.entry.size
    && item.base.audio?.mimeType === 'audio/mpeg'
    && state.key === item.key
    && item.base.audio.key === item.key
    && state.url === url
    && item.base.audio.url === url;
}
await ensureDirs();
if (mapping.migrationComplete === true) await writeJson(path.join(podcastDir, 'migration/mapping.json'), markMigrationInProgress(mapping));
let uploaded = 0; let reused = 0; let skipped = 0;
for (const item of planned) {
  if (item.confirmed) {
    skipped += 1;
    console.log(`Выпуск ${item.entry.audioPath} — ранее подтверждён, пропущен без сетевой проверки`);
    continue;
  }
  let object;
  try {
    object = await ensureObject(item.file, item.key, config, {
      onAttempt: ({ attempt, result, error }) => {
        const suffix = error ? `: ${error.message}` : '';
        console.log(`Выпуск ${item.entry.audioPath} — объект ${item.key}, попытка ${attempt}: ${result}${suffix}`);
      }
    });
  } catch (error) {
    throw new Error(`Не удалось обработать файл ${item.file}: ${error.message}`, { cause: error });
  }
  if (object.reused) reused += 1; else uploaded += 1;
  await writeJson(path.join(stateDir, `${item.entry.stableId}.json`), { kind: 'migration', stableId: item.entry.stableId, guid: item.entry.guid, sha256: item.audio.sha256, size: item.audio.size, key: item.key, url: object.url, status: 'uploaded' });
  await writeJson(path.join(episodesDir, episodeJsonFileName(item.key)), episodeFromAudio(item.base, item.audio, item.key, object.url, 'rss', true));
}
await writeJson(path.join(podcastDir, 'migration/mapping.json'), { ...mapping, migrationComplete: true });
if (uploaded + reused + skipped !== mapping.entries.length) throw new Error('Миграция остановлена: счётчики обработки не совпадают с картой');
console.log(`Миграция завершена: загружено ${uploaded}, переиспользовано ${reused}, пропущено подтверждённых ${skipped}`);
