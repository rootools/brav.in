import fs from 'node:fs/promises';
import path from 'node:path';
import { podcastDir, sourceItems, rssItem, inspectAudio, readJson, writeJson } from './podcast-lib.mjs';

const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const audioRoot = arg('--audio-root');
if (!audioRoot) throw new Error('Укажите --audio-root');
const files = [];
async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.name.toLowerCase().endsWith('.mp3')) files.push(file); } }
await walk(audioRoot);
const rss = (await sourceItems()).map((item, index) => rssItem(item, index));
const scanned = [];
for (const file of files) { const metadata = await inspectAudio(file); scanned.push({ path: path.relative(audioRoot, file), ...metadata }); }
const oldMapping = await (async () => { try { return await readJson(path.join(podcastDir, 'migration/mapping.json')); } catch { return {}; } })();
const oldEntries = new Map((oldMapping.entries || []).map(entry => [entry.guid, entry]));
const normalized = value => String(value || '').toLowerCase().replace(/^\d+\.\s*/, '').replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
const durationOf = value => { const parts = String(value || '').split(':').map(Number); return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : Number(value) || 0; };
const entries = []; const used = new Set();
for (const episode of rss) {
  const number = episode.episode && String(episode.episode).match(/\d+/)?.[0];
  const numberCandidates = scanned.filter(file => !used.has(file.path) && number && path.basename(file.path).match(new RegExp(`(?:^|\\D)0*${Number(number)}\\.mp3$`, 'i')));
  const titleCandidates = scanned.filter(file => !used.has(file.path) && normalized(file.title) && normalized(episode.title) && (normalized(file.title).includes(normalized(episode.title)) || normalized(episode.title).includes(normalized(file.title))));
  const candidates = numberCandidates.length ? numberCandidates : titleCandidates;
  const valid = candidates.filter(file => normalized(file.title) === normalized(episode.title) || (durationOf(file.durationSeconds) && Math.abs(durationOf(file.durationSeconds) - durationOf(episode.duration)) <= 1));
  const old = oldEntries.get(episode.guid);
  const match = valid.length === 1 && candidates.length === 1 ? valid[0] : null;
  const discrepancies = match ? [
    ...(normalized(match.title) !== normalized(episode.title) ? [`title: RSS=${episode.title}; ID3=${match.title}`] : []),
    ...(episode.duration && Math.abs(durationOf(match.durationSeconds) - durationOf(episode.duration)) > 1 ? [`duration: RSS=${episode.duration}; audio=${match.durationSeconds}`] : []),
    ...(episode.enclosureLength && match.size !== episode.enclosureLength ? [`size: RSS=${episode.enclosureLength}; audio=${match.size}`] : [])
  ] : [];
  if (old?.status === 'matched' && old.audioPath === match?.path && old.sha256 === match?.sha256) { used.add(match.path); entries.push({ ...old, discrepancies }); }
  else if (match && !discrepancies.some(item => item.startsWith('title:') || item.startsWith('duration:'))) { used.add(match.path); entries.push({ stableId: old?.stableId || episode.stableId, guid: episode.guid, audioPath: match.path, status: 'matched', sha256: match.sha256, size: match.size, durationSeconds: match.durationSeconds, title: match.title, discrepancies }); }
  else entries.push({ stableId: old?.stableId || episode.stableId, guid: episode.guid, audioPath: old?.audioPath || null, status: candidates.length > 1 ? 'ambiguous' : match ? 'conflict' : 'missing', candidates: candidates.map(item => item.path), discrepancies });
}
const extra = scanned.filter(file => !used.has(file.path)).map(file => file.path);
await writeJson(path.join(podcastDir, 'migration/mapping.json'), { ...oldMapping, source: 'migration/source.xml', audioRoot: '--audio-root', entries, extraFiles: extra, scannedFiles: scanned.length, migrationComplete: oldMapping.migrationComplete === true && !extra.length && entries.every(entry => entry.status === 'matched') });
const counts = entries.reduce((result, entry) => { result[entry.status] = (result[entry.status] || 0) + 1; return result; }, {});
const discrepancies = entries.filter(entry => entry.discrepancies?.length).length;
console.log(JSON.stringify({ rssRecords: rss.length, audioFiles: scanned.length, ...counts, extraFiles: extra.length, discrepancies }, null, 2));
if (counts.missing || counts.ambiguous || counts.conflict || extra.length) process.exitCode = 2;
