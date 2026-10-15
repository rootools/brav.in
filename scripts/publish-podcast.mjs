import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { episodesDir, podcastDir, stateDir, inspectAudio, publicObjectKey, episodeJsonFileName, ensureObject, episodeFromAudio, validatePreparedEpisode, readJson, writeJson, ensureDirs } from './podcast-lib.mjs';

const exec = promisify(execFile);
const run = async (command, args) => (await exec(command, args)).stdout.trim();
const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const audio = arg('--audio');
const suppliedPublishAt = arg('--publish-at');
if (!audio) throw new Error('Укажите --audio');
await fs.access(audio);
const fileName = path.basename(audio);
const key = publicObjectKey(fileName);
if (suppliedPublishAt && (!/[T ]\d{2}:\d{2}(:\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(suppliedPublishAt) || Number.isNaN(Date.parse(suppliedPublishAt)))) throw new Error('--publish-at должен быть корректной датой с часовым поясом');
const branch = await run('git', ['branch', '--show-current']);
if (branch !== 'master') throw new Error(`Публикация разрешена только из master, сейчас ${branch}`);
const remoteUrl = await run('git', ['remote', 'get-url', 'origin']).catch(() => '');
if (!/^((git@|ssh:\/\/)github\.com[:/]rootools\/brav\.in(?:\.git)?|https:\/\/github\.com\/rootools\/brav\.in(?:\.git)?)$/.test(remoteUrl)) throw new Error(`Неверный remote origin: ${remoteUrl || 'отсутствует'}`);

const info = await inspectAudio(audio);
if (!info.title) throw new Error('В ID3 отсутствует обязательный TIT2 (title)');
if (!info.description) throw new Error('В ID3 отсутствует обязательный TIT3 (description)');
await ensureDirs();
const files = (await fs.readdir(episodesDir)).filter(file => file.endsWith('.json'));
const mapping = await (async () => { try { return await readJson(path.join(podcastDir, 'migration/mapping.json')); } catch { return {}; } })();
const mapped = new Map((mapping.entries || []).filter(entry => entry.audioPath).map(entry => [path.basename(entry.audioPath), entry]));
const matches = [];
const fileByStableId = new Map();
for (const file of files) {
  const episode = await readJson(path.join(episodesDir, file));
  fileByStableId.set(episode.stableId, file);
  if (episode.audio?.key === key || mapped.get(fileName)?.stableId === episode.stableId) matches.push(episode);
}
if (matches.length > 1) throw new Error(`Имя объекта ${key} соответствует нескольким выпускам`);
const existing = matches[0] || null;
const id = `episode-${crypto.createHash('sha256').update(fileName).digest('hex').slice(0, 16)}`;
const stableId = existing?.stableId || mapped.get(fileName)?.stableId || id;
const guid = existing?.guid || `podcast-ntt:${id}`;
const episodeFileName = existing ? fileByStableId.get(stableId) : episodeJsonFileName(fileName);
const episodeFile = path.join(episodesDir, episodeFileName);
const relativeEpisodeFile = path.relative(process.cwd(), episodeFile);
const stateFile = path.join(stateDir, `${stableId}.json`);
let state = null;
try { state = await readJson(stateFile); } catch {}
if (existing && suppliedPublishAt && new Date(suppliedPublishAt).toISOString() !== existing.publishAt) throw new Error('Для редактирования нельзя менять publishAt: дата не совпадает с существующей записью');
const publishAt = existing?.publishAt || suppliedPublishAt;
if (!publishAt) throw new Error('Для нового выпуска укажите --publish-at');
const expectedPublishAt = new Date(publishAt).toISOString();
const expectedPubDate = new Date(publishAt).toUTCString();
const recoveryState = state && (state.kind === 'publish' || state.id3Sha256) && state.stableId === stableId && state.key === key && state.sha256 === info.sha256;
const preparedAttempt = existing && recoveryState ? validatePreparedEpisode(existing, { stableId, guid, info, fileName, publishAt, state }) : null;
const recoveryRequired = preparedAttempt?.recoveryRequired ?? false;
const localHead = await run('git', ['rev-parse', 'master']);
const remoteHead = await run('git', ['ls-remote', 'origin', 'refs/heads/master']).then(value => value.split(/\s/)[0]).catch(() => '');
if (!remoteHead) throw new Error('Не удалось проверить удалённую ветку origin/master');
if (remoteHead !== localHead) {
  try { await exec('git', ['merge-base', '--is-ancestor', remoteHead, localHead]); } catch { throw new Error('Удалённая master изменилась: сначала синхронизируйте ветку'); }
  const aheadCount = Number(await run('git', ['rev-list', '--count', `${remoteHead}..${localHead}`]));
  const subject = await run('git', ['show', '-s', '--format=%s', localHead]);
  const changedFiles = (await run('git', ['show', '--format=', '--name-only', localHead])).split('\n').filter(Boolean);
  if (aheadCount !== 1 || (state?.commit !== localHead && (subject !== `Publish podcast episode ${stableId}` || changedFiles.length !== 1 || changedFiles[0] !== relativeEpisodeFile))) throw new Error('Локальная master содержит неподтверждённые коммиты');
}
const statusOutput = (await exec('git', ['status', '--porcelain=v1'])).stdout;
const statusLines = statusOutput.split('\n').filter(line => line.length > 0);
const ownPreparedChange = preparedAttempt?.prepared && statusLines.length > 0 && statusLines.every(line => line.slice(3) === relativeEpisodeFile);
if (statusLines.length && !ownPreparedChange) throw new Error('Рабочее дерево содержит посторонние изменения');

if (!existing || recoveryRequired || !recoveryState) {
  const object = await ensureObject(audio, key);
  const base = existing || { stableId, guid, guidIsPermaLink: false, title: info.title, description: info.description, descriptionFormat: 'text', additionalDescriptions: {}, pubDate: expectedPubDate, publishAt: expectedPublishAt, episode: null, season: null, episodeType: 'full', metadataOrigin: 'id3' };
  const episode = episodeFromAudio(base, info, key, object.url);
  await writeJson(episodeFile, episode);
  const catalogSha256 = crypto.createHash('sha256').update(`${JSON.stringify(episode, null, 2)}\n`).digest('hex');
  const id3Sha256 = crypto.createHash('sha256').update(`${info.title}\0${info.description}`).digest('hex');
  await writeJson(stateFile, { ...(state || {}), kind: 'publish', stableId, guid, sha256: info.sha256, size: info.size, key, url: object.url, publishAt: expectedPublishAt, title: info.title, description: info.description, id3Sha256, catalogSha256, status: 'uploaded' });
}
const changed = (await exec('git', ['status', '--porcelain=v1', '--', relativeEpisodeFile])).stdout;
if (changed.split('\n').some(line => line.length > 0)) {
  await exec('git', ['add', relativeEpisodeFile]);
  await exec('git', ['commit', '-m', `Publish podcast episode ${stableId}`]);
  const commit = await run('git', ['log', '-1', '--format=%H', '--', relativeEpisodeFile]);
  await writeJson(stateFile, { ...(await readJson(stateFile)), stableId, guid, sha256: info.sha256, status: 'committed', commit });
}
await exec('git', ['push', 'origin', 'master']);
console.log(`Выпуск опубликован: ${stableId}. Проверьте Actions и Pages.`);
