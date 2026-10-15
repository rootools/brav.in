import fs from 'node:fs/promises';
import path from 'node:path';
import { podcastDir, episodesDir, sourceItems, sourceChannel, rssItem, stableId, episodeJsonFileName, readJson, writeJson, ensureDirs } from './podcast-lib.mjs';

const source = process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : path.join(podcastDir, 'migration/source.xml');
await ensureDirs();
const items = await sourceItems(source);
if (!items.length) throw new Error('В RSS нет выпусков');
const existingFiles = (await fs.readdir(episodesDir)).filter(file => file.endsWith('.json'));
const existing = new Map();
for (const file of existingFiles) { const episode = await readJson(path.join(episodesDir, file)); if (episode.guid) existing.set(episode.guid, episode); }
const imported = [];
for (const [index, item] of items.entries()) {
  const parsed = rssItem(item, index);
  const old = existing.get(parsed.guid);
  if (old) {
    for (const field of ['title', 'description', 'descriptionFormat', 'pubDate', 'guidIsPermaLink']) if (old[field] !== parsed[field]) throw new Error(`Конфликт повторного импорта для GUID ${parsed.guid}: изменено поле ${field}`);
    imported.push({ ...parsed, ...old, stableId: old.stableId });
  } else {
    const stable = rssItem(item, undefined, stableId(parsed.guid));
    imported.push(stable);
  }
}
const oldMapping = await (async () => { try { return await readJson(path.join(podcastDir, 'migration/mapping.json')); } catch { return {}; } })();
const oldEntries = new Map((oldMapping.entries || []).map(entry => [entry.guid, entry]));
const byGuid = new Map(imported.map(episode => [episode.guid, episode]));
for (const episode of imported) {
  const entry = oldEntries.get(episode.guid);
  const audioFileName = entry?.audioPath ? path.basename(entry.audioPath) : `${String(episode.episode || '').padStart(3, '0')}.mp3`;
  await writeJson(path.join(episodesDir, episodeJsonFileName(audioFileName)), episode);
}
const entries = imported.map(episode => ({ ...(oldEntries.get(episode.guid) || {}), stableId: episode.stableId, guid: episode.guid, audioPath: oldEntries.get(episode.guid)?.audioPath ?? null, status: oldEntries.get(episode.guid)?.status === 'matched' ? 'matched' : 'unmatched' }));
await writeJson(path.join(podcastDir, 'migration/mapping.json'), { ...oldMapping, source: 'migration/source.xml', entries, migrationComplete: oldMapping.migrationComplete === true && entries.every(entry => entry.status === 'matched') });
const channel = await sourceChannel(source);
const categories = [];
for (const category of [channel['itunes:category']].flat().filter(Boolean)) { if (category['@_text']) categories.push(category['itunes:category']?.['@_text'] ? { name: category['@_text'], subcategory: category['itunes:category']['@_text'] } : { name: category['@_text'] }); }
const oldShow = await (async () => { try { return await readJson(path.join(podcastDir, 'show.json')); } catch { return {}; } })();
await writeJson(path.join(podcastDir, 'show.json'), { title: oldShow.title || 'Стоит попробовать', description: oldShow.description || 'Подкаст о том, как, выгорев, я уволился с работы, чтобы довести свою игру до релиза и узнать, что из этого получится.', language: oldShow.language || 'ru-RU', author: oldShow.author || 'Антон Бравин', email: oldShow.email || 'anton.bravin@yandex.ru', categories: categories.length ? [...new Set(categories)] : (oldShow.categories || ['Society & Culture']), explicit: oldShow.explicit ?? false, image: oldShow.image || '/assets/podcast-ntt-cover.jpg', pageUrl: oldShow.pageUrl || 'https://brav.in/podcast-ntt/', feedUrl: oldShow.feedUrl || 'https://brav.in/podcast-ntt/feed.xml', platforms: oldShow.platforms || [{ title: 'Podcast.ru', url: 'https://podcast.ru/1610095958' }] });
console.log(`Импортировано записей без перезаписи технических данных: ${byGuid.size}`);
