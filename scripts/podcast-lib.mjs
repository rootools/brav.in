import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { XMLParser } from 'fast-xml-parser';
import { parseFile } from 'music-metadata';

export const root = process.cwd();
try { loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
export const podcastDir = path.join(root, 'podcast-ntt');
export const episodesDir = path.join(podcastDir, 'episodes');
export const stateDir = path.join(root, '.podcast-publish');
export const siteUrl = 'https://brav.in';
export const feedUrl = `${siteUrl}/podcast-ntt/feed.xml`;
export const pageUrl = `${siteUrl}/podcast-ntt/`;
export const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', cdataPropName: '#text', parseTagValue: false, trimValues: false });

export const text = value => value == null ? '' : Array.isArray(value) ? text(value[0]) : typeof value === 'object' ? String(value['#text'] ?? '') : String(value);
export const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
export const stableId = (guid, index) => `episode-${crypto.createHash('sha256').update(index == null ? guid : `${guid}\0${index}`).digest('hex').slice(0, 16)}`;
export const sha256 = file => new Promise((resolve, reject) => { const hash = crypto.createHash('sha256'); fsSync.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))); });
export const xmlEscape = value => text(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[char]));
export const cdata = value => `<![CDATA[${text(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

export async function ensureDirs() { await fs.mkdir(episodesDir, { recursive: true }); await fs.mkdir(stateDir, { recursive: true }); }
export function markMigrationInProgress(mapping) { return mapping.migrationComplete === true ? { ...mapping, migrationComplete: false } : mapping; }
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }
export async function readSource(source = path.join(podcastDir, 'migration/source.xml')) { return parser.parse(await fs.readFile(source, 'utf8')); }
export async function sourceItems(source = path.join(podcastDir, 'migration/source.xml')) { const parsed = await readSource(source); return array(parsed.rss?.channel?.item); }
export async function sourceChannel(source = path.join(podcastDir, 'migration/source.xml')) { const parsed = await readSource(source); return parsed.rss?.channel || {}; }
export async function validateMigrationCatalog({ requireAudio = false } = {}) {
  const mapping = await readJson(path.join(podcastDir, 'migration/mapping.json'));
  const source = (await sourceItems()).map((item, index) => rssItem(item, index));
  const sourceGuids = new Set(source.map(item => item.guid));
  const entries = mapping.entries || [];
  if (sourceGuids.size !== source.length || entries.length !== source.length || new Set(entries.map(entry => entry.guid)).size !== entries.length || !entries.every(entry => sourceGuids.has(entry.guid))) throw new Error('Карта миграции не совпадает с полным набором GUID исходного RSS');
  const files = (await fs.readdir(episodesDir)).filter(file => file.endsWith('.json'));
  const catalog = await Promise.all(files.map(file => readJson(path.join(episodesDir, file))));
  const byGuid = new Map(catalog.map(episode => [episode.guid, episode]));
  const byStableId = new Map(catalog.map(episode => [episode.stableId, episode]));
  if (byGuid.size !== catalog.length || byStableId.size !== catalog.length) throw new Error('Каталог содержит дубли GUID или stableId');
  for (const entry of entries) {
    const episode = byGuid.get(entry.guid);
    if (!episode || episode.stableId !== entry.stableId || byStableId.get(entry.stableId) !== episode || entry.status !== 'matched') throw new Error(`Каталог не соответствует карте миграции для GUID ${entry.guid}`);
    if (requireAudio && (!episode.audio?.url || !episode.audio.sha256 || !episode.audio.size || episode.audio.mimeType !== 'audio/mpeg')) throw new Error(`Нет готовых аудиометаданных для GUID ${entry.guid}`);
  }
  if (requireAudio && mapping.migrationComplete !== true) throw new Error('Миграция подкаста не отмечена как завершённая');
  return { mapping, source, catalog };
}

export function rssItem(item, index, id = undefined) {
  const guidValue = item.guid;
  const guid = text(guidValue);
  const enclosure = item.enclosure || {};
  const content = item['content:encoded'];
  const description = item.description;
  const descriptionFormat = content != null ? 'html' : 'text';
  return {
    stableId: id || stableId(guid, index), guid, guidIsPermaLink: guidValue?.['@_isPermaLink'] ?? null,
    title: text(item.title ?? item['itunes:title']), description: text(content ?? description), descriptionFormat,
    additionalDescriptions: { description: text(description), contentEncoded: text(content) },
    pubDate: text(item.pubDate), publishAt: new Date(text(item.pubDate)).toISOString(),
    enclosureUrl: text(enclosure['@_url']), enclosureLength: Number(enclosure['@_length'] || 0), enclosureType: text(enclosure['@_type']) || 'audio/mpeg',
    duration: text(item['itunes:duration']), episode: text(item['itunes:episode']) || text(item['itunes:title'] ?? item.title).match(/^(\d+)/)?.[1] || null, season: text(item['itunes:season']) || null, episodeType: text(item['itunes:episodeType']) || null,
    metadataOrigin: 'rss', audio: null
  };
}

export function id3Metadata(metadata) {
  const frames = [...(metadata.native?.['ID3v2.3'] || []), ...(metadata.native?.['ID3v2.4'] || [])];
  const title = (frames.find(item => item.id === 'TIT2')?.value || '').toString().trim();
  const description = (frames.find(item => item.id === 'TIT3')?.value || '').toString().trim();
  return { title, description };
}

export async function inspectAudio(file) {
  const stat = await fs.stat(file);
  const metadata = await parseFile(file, { duration: true });
  const id3 = id3Metadata(metadata);
  return { size: stat.size, durationSeconds: metadata.format.duration ? Math.round(metadata.format.duration) : null, sha256: await sha256(file), ...id3 };
}

export function episodeJsonFileName(fileName) {
  const base = path.basename(fileName);
  if (!/^\d+\.mp3$/i.test(base)) throw new Error(`Недопустимое имя MP3 для JSON выпуска: ${fileName}`);
  return `${base.slice(0, -4)}.json`;
}

export function publicObjectKey(fileName) {
  if (typeof fileName !== 'string' || !fileName || fileName !== path.basename(fileName) || fileName.includes('..') || /[\\/]/.test(fileName) || !/^\d+\.mp3$/i.test(fileName)) throw new Error(`Недопустимое имя MP3 для корневого объекта: ${fileName}`);
  return fileName;
}
export function s3Config(env = process.env) { return { endpoint: env.VK_CLOUD_ENDPOINT, region: env.VK_CLOUD_REGION, bucket: env.VK_CLOUD_BUCKET, publicBaseUrl: env.VK_CLOUD_PUBLIC_BASE_URL?.replace(/\/$/, '') }; }
export function s3Client(config = s3Config()) {
  const missing = [['endpoint', 'VK_CLOUD_ENDPOINT'], ['bucket', 'VK_CLOUD_BUCKET'], ['publicBaseUrl', 'VK_CLOUD_PUBLIC_BASE_URL']].filter(([key]) => !config[key]).map(([, name]) => name);
  if (missing.length) throw new Error(`Не заданы ${missing.join(', ')}. Сохраните настройки в .env в корне проекта (см. .env.example) или задайте переменные окружения.`);
  return { client: config.client || new S3Client({ endpoint: config.endpoint, region: config.region || 'ru-msk', forcePathStyle: false }), ...config };
}

class PublicNotFoundError extends Error {
  constructor(stage, url) {
    super(`Публичный ${stage} вернул 404: ${url}`);
    this.name = 'PublicNotFound';
    this.stage = stage;
  }
}

export async function verifyPublicObject(url, expectedSize, expectedSha256) {
  if (!url.startsWith('https://')) throw new Error(`Публичный URL должен использовать HTTPS: ${url}`);
  const head = await fetch(url, { method: 'HEAD' });
  if (head.status === 404) throw new PublicNotFoundError('HEAD', url);
  if (!head.ok) throw new Error(`Публичный HEAD недоступен: ${head.status} ${url}`);
  if (head.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') throw new Error(`Неверный MIME публичного объекта: ${url}`);
  if (Number(head.headers.get('content-length')) !== expectedSize) throw new Error(`Неверный размер публичного объекта: ${url}`);
  const range = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (range.status === 404) throw new PublicNotFoundError('Range', url);
  if (range.status !== 206 || !/^bytes 0-0\//.test(range.headers.get('content-range') || '')) throw new Error(`Публичный объект не поддерживает корректный Range: ${url}`);
  const response = await fetch(url);
  if (response.status === 404) throw new PublicNotFoundError('GET', url);
  if (!response.ok || !response.body) throw new Error(`Публичное скачивание недоступно: ${url}`);
  const hash = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of response.body) { size += chunk.length; hash.update(chunk); }
  if (size !== expectedSize || hash.digest('hex') !== expectedSha256) throw new Error(`Контрольная сумма публичного объекта не совпадает: ${url}`);
}

async function bodySha256(body) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
}

const uploadAttempts = 3;
const retryDelays = [1000, 2000];
const retryableCodes = new Set(['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

function isRetryableNetworkError(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (retryableCodes.has(current.code) || current.name === 'TimeoutError' || current.constructor?.name === 'TimeoutError') return true;
  }
  return false;
}

function isRetryableError(error) {
  return isRetryableNetworkError(error) || error?.name === 'PublicNotFound';
}

function isNotFound(error) {
  return error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function ensureObject(file, key, config = s3Config(), { onAttempt } = {}) {
  const s3 = s3Client(config); const stat = await fs.stat(file); const expectedSha256 = await sha256(file);
  const url = `${s3.publicBaseUrl}/${key}`; let lastError;
  for (let attempt = 1; attempt <= uploadAttempts; attempt += 1) {
    let stream;
    try {
      let reused = false;
      try {
        const head = await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
        if (Number(head.ContentLength) === stat.size && (!head.ContentType || head.ContentType === 'audio/mpeg')) {
          const object = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
          reused = await bodySha256(object.Body) === expectedSha256;
        } else if (head.ContentType && head.ContentType !== 'audio/mpeg') {
          throw new Error(`Объект ${key} имеет неверный MIME`);
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (!reused) {
        stream = fsSync.createReadStream(file);
        await s3.client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: stream, ContentType: 'audio/mpeg', CacheControl: 'no-cache', Metadata: { sha256: expectedSha256 } }));
      }
      await verifyPublicObject(url, stat.size, expectedSha256);
      await onAttempt?.({ attempt, key, reused, result: reused ? 'переиспользован' : 'загружен' });
      return { url, reused, attempts: attempt };
    } catch (error) {
      lastError = error;
      await onAttempt?.({ attempt, key, result: 'ошибка', error });
      if (!isRetryableError(error) || attempt === uploadAttempts) throw error;
      await wait(retryDelays[attempt - 1]);
    } finally {
      stream?.destroy();
    }
  }
  throw lastError;
}

export function validatePreparedEpisode(existing, { stableId: expectedStableId, guid: expectedGuid, info, fileName, publishAt, state }) {
  const expectedPublishAt = new Date(publishAt).toISOString();
  const expectedPubDate = new Date(publishAt).toUTCString();
  const expectedKey = publicObjectKey(fileName);
  if (existing.stableId !== expectedStableId || existing.guid !== expectedGuid || existing.metadataOrigin !== 'id3' || existing.title !== info.title || existing.description !== info.description || existing.descriptionFormat !== 'text' || existing.publishAt !== expectedPublishAt || existing.pubDate !== expectedPubDate || existing.audio?.sha256 !== info.sha256 || existing.audio?.size !== info.size || existing.audio?.mimeType !== 'audio/mpeg' || existing.audio?.key !== expectedKey) throw new Error('Подготовленная запись выпуска изменена или конфликтует с текущими ID3/датой');
  const expectedId3Sha256 = crypto.createHash('sha256').update(`${info.title}\0${info.description}`).digest('hex');
  if (state && (state.stableId !== expectedStableId || state.guid !== expectedGuid || state.sha256 !== info.sha256 || state.size !== info.size || state.key !== expectedKey || new Date(state.publishAt).toISOString() !== expectedPublishAt || state.title !== info.title || state.description !== info.description || state.id3Sha256 !== expectedId3Sha256)) throw new Error('Служебное состояние публикации конфликтует с текущими аргументами');
  if (!state?.catalogSha256) return { expectedKey, recoveryRequired: true };
  const catalogSha256 = crypto.createHash('sha256').update(`${JSON.stringify(existing, null, 2)}\n`).digest('hex');
  if (state.catalogSha256 !== catalogSha256) throw new Error('JSON выпуска изменён после подготовки публикации');
  if (existing.audio.url !== state.url) throw new Error('URL аудио изменён после подготовки публикации');
  return { expectedKey, recoveryRequired: false, prepared: true };
}

export function episodeFromAudio(base, audio, key, url, origin = 'id3', preserveMetadata = false) {
  const metadata = preserveMetadata ? base : { ...base, title: audio.title, description: audio.description, descriptionFormat: 'text', duration: String(audio.durationSeconds ?? '') };
  return { ...metadata, enclosureLength: audio.size, enclosureType: 'audio/mpeg', metadataOrigin: origin, audio: { url, key, sha256: audio.sha256, size: audio.size, mimeType: 'audio/mpeg' } };
}
