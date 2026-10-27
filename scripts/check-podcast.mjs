import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { verifyPublicObject, validatePreparedEpisode, publicObjectKey, ensureObject, sourceItems, rssItem, markMigrationInProgress, id3Metadata } from './podcast-lib.mjs';

const root = process.cwd();
const podcast = path.join(root, 'podcast-ntt');
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);
const exec = promisify(execFile);

test('настройки S3 загружаются из .env, а окружение имеет приоритет', async () => {
  const stateDir = path.join(root, '.podcast-publish');
  await fs.mkdir(stateDir, { recursive: true });
  const temp = await fs.mkdtemp(path.join(stateDir, 'env-test-'));
  const env = { ...process.env };
  for (const key of ['VK_CLOUD_ENDPOINT', 'VK_CLOUD_REGION', 'VK_CLOUD_BUCKET', 'VK_CLOUD_PUBLIC_BASE_URL', 'AWS_PROFILE']) delete env[key];
  const script = `import { s3Config } from ${JSON.stringify(new URL('./podcast-lib.mjs', import.meta.url).href)}; console.log(JSON.stringify({ ...s3Config(), profile: process.env.AWS_PROFILE }));`;
  const config = async overrides => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: temp, env: { ...env, ...overrides } })).stdout);
  try {
    assert.deepEqual(await config(), {});
    await fs.writeFile(path.join(temp, '.env'), 'VK_CLOUD_ENDPOINT=https://s3.fixture.test\nVK_CLOUD_REGION=ru-msk\nVK_CLOUD_BUCKET=fixture\nVK_CLOUD_PUBLIC_BASE_URL=https://public.fixture.test/\nAWS_PROFILE=fixture-profile\n');
    const expected = { endpoint: 'https://s3.fixture.test', region: 'ru-msk', bucket: 'fixture', publicBaseUrl: 'https://public.fixture.test', profile: 'fixture-profile' };
    assert.deepEqual(await config(), expected);
    assert.deepEqual(await config({ VK_CLOUD_BUCKET: 'override', AWS_PROFILE: 'override-profile' }), { ...expected, bucket: 'override', profile: 'override-profile' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('название и описание берутся из ID3, а не из конфликтующих APEv2 тегов', () => {
  for (const format of ['ID3v2.3', 'ID3v2.4']) {
    assert.deepEqual(id3Metadata({ common: { title: '129' }, native: { [format]: [{ id: 'TIT2', value: ' 129. Кол оф дьюти на скейтборде ' }, { id: 'TIT3', value: ' Описание ' }], APEv2: [{ id: 'Title', value: '129' }] } }), { title: '129. Кол оф дьюти на скейтборде', description: 'Описание' });
  }
  assert.deepEqual(id3Metadata({ common: { title: 'Только APEv2' }, native: { APEv2: [{ id: 'Title', value: 'Только APEv2' }] } }), { title: '', description: '' });
});

test('имя корневого объекта безопасно и не содержит SHA или префикса', () => {
  assert.equal(publicObjectKey('001.mp3'), '001.mp3');
  assert.throws(() => publicObjectKey('../001.mp3'));
  assert.throws(() => publicObjectKey('podcast-ntt/001.mp3'));
  assert.throws(() => publicObjectKey('001.wav'));
});

test('каталог сохраняет снимок RSS и стабильные идентификаторы', async () => {
  const source = await fs.readFile(path.join(podcast, 'migration/source.xml'), 'utf8');
  const mapping = await readJson(path.join(podcast, 'migration/mapping.json'));
  const files = (await fs.readdir(path.join(podcast, 'episodes'))).filter(file => file.endsWith('.json'));
  assert.equal(source.includes('<rss'), true);
  const catalog = [];
  for (const file of files) catalog.push(await readJson(path.join(podcast, 'episodes', file)));
  const catalogByGuid = new Map(catalog.map(episode => [episode.guid, episode]));
  const sourceGuids = new Set((await sourceItems()).map((item, index) => rssItem(item, index).guid));
  assert.equal(mapping.entries.length, sourceGuids.size);
  assert.deepEqual(new Set(mapping.entries.map(entry => entry.guid)), sourceGuids);
  assert.equal(mapping.entries.every(entry => catalogByGuid.has(entry.guid)), true);
  assert.equal(mapping.entries.every(entry => entry.status === 'matched'), true);
  assert.equal(mapping.entries.every(entry => entry.audioPath && !path.isAbsolute(entry.audioPath)), true);
  assert.equal(new Set(catalog.map(episode => episode.guid)).size, catalog.length);
  assert.equal(new Set(catalog.map(episode => episode.stableId)).size, catalog.length);
  const mappingByGuid = new Map(mapping.entries.map(entry => [entry.guid, entry]));
  for (const file of files) {
    const episode = await readJson(path.join(podcast, 'episodes', file));
    const mappingEntry = mappingByGuid.get(episode.guid);
    if (mappingEntry) assert.equal(file, `${path.basename(mappingEntry.audioPath, '.mp3')}.json`);
    assert.ok(episode.guid);
    assert.ok(episode.pubDate);
  }
});

test('объект переиспользуется только при совпадении содержимого и заменяется без ACL', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-object-'));
  const file = path.join(temp, '001.mp3');
  const originalFetch = global.fetch;
  const puts = [];
  let remote = Buffer.from('old');
  const client = { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: remote.length, ContentType: 'audio/mpeg' };
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([remote]) };
    if (command.constructor.name === 'PutObjectCommand') { puts.push(command.input); remote = await fs.readFile(file); return {}; }
    throw new Error(`Неожиданная команда ${command.constructor.name}`);
  } };
  global.fetch = async (_url, options = {}) => options.method === 'HEAD'
    ? new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(remote.length) } })
    : options.headers?.Range ? new Response(remote.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${remote.length}` } }) : new Response(remote);
  try {
    await fs.writeFile(file, 'old');
    assert.equal((await ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client })).reused, true);
    assert.equal(puts.length, 0);
    await fs.writeFile(file, 'new');
    assert.equal((await ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client })).reused, false);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].ACL, undefined);
    assert.equal(puts[0].CacheControl, 'no-cache');
  } finally { global.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }); }
});

test('ошибка чтения существующего объекта не приводит к слепой перезаписи', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-object-error-'));
  const file = path.join(temp, '001.mp3');
  await fs.writeFile(file, 'new');
  let puts = 0;
  let gets = 0;
  const client = { send: async command => { if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: 3, ContentType: 'audio/mpeg' }; if (command.constructor.name === 'GetObjectCommand') { gets += 1; throw Object.assign(new Error('network'), { name: 'TimeoutError' }); } if (command.constructor.name === 'PutObjectCommand') puts += 1; } };
  await assert.rejects(() => ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client }));
  assert.equal(gets, 3);
  assert.equal(puts, 0);
  await fs.rm(temp, { recursive: true, force: true });
});

test('обрыв чтения первого потока повторяет загрузку с начала', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-retry-read-'));
  const file = path.join(temp, '001.mp3');
  const body = Buffer.from('полный аудиофайл');
  await fs.writeFile(file, body);
  const originalFetch = global.fetch;
  const puts = [];
  let remote = Buffer.alloc(0);
  const client = { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') throw Object.assign(new Error('missing'), { name: 'NotFound' });
    if (command.constructor.name === 'PutObjectCommand') {
      puts.push(command.input.Body);
      if (puts.length === 1) {
        command.input.Body.once('error', () => {});
        queueMicrotask(() => command.input.Body.destroy(Object.assign(new Error('pipe closed'), { code: 'EPIPE' })));
        await new Promise(resolve => command.input.Body.once('close', resolve));
        throw Object.assign(new Error('pipe closed'), { code: 'EPIPE' });
      }
      const chunks = [];
      for await (const chunk of command.input.Body) chunks.push(chunk);
      remote = Buffer.concat(chunks);
      return {};
    }
    throw new Error(`Неожиданная команда ${command.constructor.name}`);
  } };
  global.fetch = async (_url, options = {}) => options.method === 'HEAD'
    ? new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(remote.length) } })
    : options.headers?.Range ? new Response(remote.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${remote.length}` } }) : new Response(remote);
  try {
    const result = await ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client });
    assert.equal(result.reused, false);
    assert.equal(puts.length, 2);
    assert.deepEqual(remote, body);
  } finally { global.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }); }
});

test('сброс первого публичного запроса повторяет проверку и проходит', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-retry-public-'));
  const file = path.join(temp, '001.mp3');
  const body = Buffer.from('публичный файл');
  await fs.writeFile(file, body);
  const originalFetch = global.fetch;
  let remote = null;
  let publicRequests = 0;
  const client = { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') {
      if (!remote) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return { ContentLength: remote.length, ContentType: 'audio/mpeg' };
    }
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([remote]) };
    if (command.constructor.name === 'PutObjectCommand') {
      const chunks = [];
      for await (const chunk of command.input.Body) chunks.push(chunk);
      remote = Buffer.concat(chunks);
      return {};
    }
    throw new Error(`Неожиданная команда ${command.constructor.name}`);
  } };
  global.fetch = async (_url, options = {}) => {
    publicRequests += 1;
    if (publicRequests === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return options.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(remote.length) } })
      : options.headers?.Range ? new Response(remote.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${remote.length}` } }) : new Response(remote);
  };
  try {
    const result = await ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client });
    assert.equal(result.attempts, 2);
    assert.equal(publicRequests, 4);
  } finally { global.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }); }
});

test('публичный 404 после PUT повторяет проверку без лишнего PUT', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-public-404-retry-'));
  const file = path.join(temp, '001.mp3');
  const body = Buffer.from('публичная задержка');
  await fs.writeFile(file, body);
  const originalFetch = global.fetch;
  let remote = null;
  let puts = 0;
  let publicRequests = 0;
  const client = { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') {
      if (!remote) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return { ContentLength: remote.length, ContentType: 'audio/mpeg' };
    }
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([remote]) };
    if (command.constructor.name === 'PutObjectCommand') {
      puts += 1;
      const chunks = [];
      for await (const chunk of command.input.Body) chunks.push(chunk);
      remote = Buffer.concat(chunks);
      return {};
    }
    throw new Error(`Неожиданная команда ${command.constructor.name}`);
  } };
  global.fetch = async (_url, options = {}) => {
    publicRequests += 1;
    if (publicRequests === 1) return new Response(null, { status: 404 });
    return options.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(remote.length) } })
      : options.headers?.Range ? new Response(remote.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${remote.length}` } }) : new Response(remote);
  };
  try {
    const result = await ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client });
    assert.equal(result.attempts, 2);
    assert.equal(puts, 1);
    assert.equal(publicRequests, 4);
  } finally { global.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }); }
});

test('публичный 404 различается на HEAD, Range и полном GET', async () => {
  const body = Buffer.from('аудио');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const originalFetch = global.fetch;
  for (const [stage, fetchMock] of [
    ['HEAD', options => options.method === 'HEAD' ? new Response(null, { status: 404 }) : new Response(body)],
    ['Range', options => options.headers?.Range ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(body.length) } })],
    ['GET', options => options.method === 'HEAD' ? new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(body.length) } }) : options.headers?.Range ? new Response(body.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${body.length}` } }) : new Response(null, { status: 404 })]
  ]) {
    global.fetch = async (_url, options = {}) => fetchMock(options);
    await assert.rejects(() => verifyPublicObject('https://public.test/001.mp3', body.length, digest), new RegExp(`Публичный ${stage} вернул 404`));
  }
  global.fetch = originalFetch;
});

test('постоянный публичный 404 ограничен тремя попытками и не перезаписывает объект', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-public-404-persistent-'));
  const file = path.join(temp, '001.mp3');
  await fs.writeFile(file, 'audio');
  const originalFetch = global.fetch;
  let puts = 0;
  let publicRequests = 0;
  let remote = null;
  const client = { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') {
      if (!remote) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return { ContentLength: remote.length, ContentType: 'audio/mpeg' };
    }
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([remote]) };
    if (command.constructor.name === 'PutObjectCommand') {
      puts += 1;
      const chunks = [];
      for await (const chunk of command.input.Body) chunks.push(chunk);
      remote = Buffer.concat(chunks);
      return {};
    }
    throw new Error(`Неожиданная команда ${command.constructor.name}`);
  } };
  global.fetch = async () => { publicRequests += 1; return new Response(null, { status: 404 }); };
  try {
    await assert.rejects(() => ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client }), /Публичный HEAD вернул 404/);
    assert.equal(publicRequests, 3);
    assert.equal(puts, 1);
  } finally { global.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }); }
});

test('ошибка SHA публичного объекта не повторяется и не перезаписывает объект', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-public-sha-'));
  const file = path.join(temp, '001.mp3');
  const body = Buffer.from('ожидаемое аудио');
  await fs.writeFile(file, body);
  const originalFetch = global.fetch;
  let puts = 0;
  const remote = body;
  const wrongPublic = Buffer.alloc(body.length, 0x78);
  const client = { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: remote.length, ContentType: 'audio/mpeg' };
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([remote]) };
    if (command.constructor.name === 'PutObjectCommand') { puts += 1; return {}; }
    throw new Error(`Неожиданная команда ${command.constructor.name}`);
  } };
  global.fetch = async (_url, options = {}) => options.method === 'HEAD'
    ? new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(wrongPublic.length) } })
    : options.headers?.Range ? new Response(wrongPublic.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${wrongPublic.length}` } }) : new Response(wrongPublic);
  try {
    await assert.rejects(() => ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client }), /Контрольная сумма/);
    assert.equal(puts, 0);
  } finally { global.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }); }
});

test('вложенный connect timeout повторяется и ограничен тремя попытками', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-retry-connect-timeout-'));
  const file = path.join(temp, '001.mp3');
  await fs.writeFile(file, 'audio');
  let attempts = 0;
  const client = { send: async () => {
    attempts += 1;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  } };
  try {
    await assert.rejects(() => ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client }), /fetch failed/);
    assert.equal(attempts, 3);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('вложенный постоянный сетевой сбой ограничен тремя попытками', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-retry-cause-'));
  const file = path.join(temp, '001.mp3');
  await fs.writeFile(file, 'audio');
  let attempts = 0;
  const client = { send: async () => {
    attempts += 1;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  } };
  try {
    await assert.rejects(() => ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client }), /fetch failed/);
    assert.equal(attempts, 3);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('сохранённый объект переиспользуется после потери ответа загрузки', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-retry-response-'));
  const file = path.join(temp, '001.mp3');
  const body = Buffer.from('сохранённый файл');
  await fs.writeFile(file, body);
  const originalFetch = global.fetch;
  let remote = null;
  let puts = 0;
  const client = { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') {
      if (!remote) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return { ContentLength: remote.length, ContentType: 'audio/mpeg' };
    }
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([remote]) };
    if (command.constructor.name === 'PutObjectCommand') {
      puts += 1;
      const chunks = [];
      for await (const chunk of command.input.Body) chunks.push(chunk);
      remote = Buffer.concat(chunks);
      throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
    }
    throw new Error(`Неожиданная команда ${command.constructor.name}`);
  } };
  global.fetch = async (_url, options = {}) => options.method === 'HEAD'
    ? new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(remote.length) } })
    : options.headers?.Range ? new Response(remote.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${remote.length}` } }) : new Response(remote);
  try {
    const result = await ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client });
    assert.equal(result.reused, true);
    assert.equal(puts, 1);
  } finally { global.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }); }
});

test('произвольный TypeError не повторяется', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-no-retry-typeerror-'));
  const file = path.join(temp, '001.mp3');
  await fs.writeFile(file, 'audio');
  let attempts = 0;
  const client = { send: async () => { attempts += 1; throw new TypeError('произвольная ошибка'); } };
  try {
    await assert.rejects(() => ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client }), /произвольная ошибка/);
    assert.equal(attempts, 1);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('ошибка доступа не повторяется', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-no-retry-access-'));
  const file = path.join(temp, '001.mp3');
  await fs.writeFile(file, 'audio');
  let attempts = 0;
  const client = { send: async () => { attempts += 1; throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); } };
  try {
    await assert.rejects(() => ensureObject(file, '001.mp3', { endpoint: 'test', bucket: 'test', publicBaseUrl: 'https://public.test', client }), /denied/);
    assert.equal(attempts, 1);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('публичный объект проверяется по HEAD, Range, MIME, размеру и SHA-256', async () => {
  const originalFetch = global.fetch;
  const body = Buffer.from('podcast-audio');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  global.fetch = async (_url, options = {}) => options.method === 'HEAD'
    ? new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(body.length) } })
    : options.headers?.Range ? new Response(body.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${body.length}` } })
      : new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(body.length) } });
  try { await verifyPublicObject('https://cdn.example.test/audio.mp3', body.length, digest); await assert.rejects(() => verifyPublicObject('https://cdn.example.test/audio.mp3', body.length + 1, digest)); }
  finally { global.fetch = originalFetch; }
});

test('повтор публикации отвергает изменения URL, описания и даты', () => {
  const publishAt = '2026-10-27T11:00:00+04:00';
  const info = { title: 'Название', description: 'Описание', sha256: 'a'.repeat(64), size: 10 };
  const expectedKey = '001.mp3';
  const episode = { stableId: 'episode-test', guid: 'podcast-ntt:episode-test', metadataOrigin: 'id3', title: info.title, description: info.description, descriptionFormat: 'text', publishAt: new Date(publishAt).toISOString(), pubDate: new Date(publishAt).toUTCString(), audio: { url: 'https://cdn.example.test/audio.mp3', key: expectedKey, sha256: info.sha256, size: info.size, mimeType: 'audio/mpeg' } };
  const state = { stableId: episode.stableId, guid: episode.guid, sha256: info.sha256, size: info.size, key: episode.audio.key, url: episode.audio.url, publishAt, title: info.title, description: info.description, id3Sha256: crypto.createHash('sha256').update(`${info.title}\0${info.description}`).digest('hex'), catalogSha256: crypto.createHash('sha256').update(`${JSON.stringify(episode, null, 2)}\n`).digest('hex') };
  const prepared = validatePreparedEpisode(episode, { stableId: episode.stableId, guid: episode.guid, info, fileName: '001.mp3', publishAt, state });
  assert.equal(prepared.recoveryRequired, false);
  assert.equal(prepared.prepared, true);
  assert.throws(() => validatePreparedEpisode({ ...episode, audio: { ...episode.audio, url: 'https://not-verified.invalid/missing.mp3' } }, { stableId: episode.stableId, guid: episode.guid, info, fileName: '001.mp3', publishAt, state }));
  assert.throws(() => validatePreparedEpisode({ ...episode, description: 'Подмена' }, { stableId: episode.stableId, guid: episode.guid, info, fileName: '001.mp3', publishAt, state }));
  assert.throws(() => validatePreparedEpisode(episode, { stableId: episode.stableId, guid: episode.guid, info, fileName: '001.mp3', publishAt: '2099-01-01T00:00:00+00:00', state }));
});

test('категории используют таксономию Apple Podcasts', async () => {
  const show = await readJson(path.join(podcast, 'show.json'));
  const valid = new Set(['Arts', 'Business', 'Comedy', 'Education', 'Fiction', 'Government', 'History', 'Health & Fitness', 'Kids & Family', 'Leisure', 'Music', 'News', 'Religion & Spirituality', 'Science', 'Society & Culture', 'Sports', 'Technology', 'True Crime', 'TV & Film', 'Personal Journals', 'Entrepreneurship']);
  assert.ok(show.categories.length);
  assert.equal(show.categories.every(category => valid.has(typeof category === 'string' ? category : category.name) && (!category.subcategory || valid.has(category.subcategory))), true);
});

const writeJson = (file, value) => fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`));

async function migrationFixture({ confirmed = [], stateOverrides = {}, mappingComplete = true } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-migration-cli-'));
  const podcastRoot = path.join(temp, 'podcast-ntt');
  const episodesRoot = path.join(podcastRoot, 'episodes');
  const audioRoot = path.join(temp, 'audio');
  await fs.mkdir(episodesRoot, { recursive: true });
  await fs.mkdir(audioRoot, { recursive: true });
  const body = Buffer.alloc(417 * 3);
  for (let offset = 0; offset < body.length; offset += 417) { body[offset] = 0xff; body[offset + 1] = 0xfb; body[offset + 2] = 0x90; body[offset + 3] = 0x64; }
  const entries = [];
  const episodes = [];
  for (const [index, number] of ['001', '002'].entries()) {
    const guid = `fixture-${number}`;
    const stableId = `episode-fixture-${number}`;
    const file = path.join(audioRoot, `${number}.mp3`);
    await fs.writeFile(file, body);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    entries.push({ stableId, guid, audioPath: `${number}.mp3`, status: 'matched', sha256, size: body.length });
    episodes.push({ stableId, guid, title: `Выпуск ${number}`, description: 'Описание', descriptionFormat: 'text', pubDate: 'Thu, 01 Jan 1970 00:00:00 GMT', publishAt: '1970-01-01T00:00:00.000Z', audio: null });
  }
  const source = entries.map(entry => `<item><guid>${entry.guid}</guid><title>${entry.guid}</title><description>Описание</description><pubDate>Thu, 01 Jan 1970 00:00:00 GMT</pubDate><enclosure url="https://example.test/${entry.audioPath}" length="${body.length}" type="audio/mpeg" /></item>`).join('');
  await fs.mkdir(path.join(podcastRoot, 'migration'), { recursive: true });
  await fs.writeFile(path.join(podcastRoot, 'migration/source.xml'), `<rss version="2.0"><channel>${source}</channel></rss>`);
  await writeJson(path.join(podcastRoot, 'migration/mapping.json'), { source: 'migration/source.xml', entries, migrationComplete: mappingComplete });
  for (const episode of episodes) await writeJson(path.join(episodesRoot, `${episode.guid === 'fixture-001' ? '001' : '002'}.json`), episode);
  const baseUrl = 'https://public.fixture.test';
  for (const number of confirmed) {
    const entry = entries[Number(number) - 1];
    const episodeFile = path.join(episodesRoot, `${number}.json`);
    const episode = episodes[Number(number) - 1];
    episode.audio = { url: `${baseUrl}/${number}.mp3`, key: `${number}.mp3`, sha256: entry.sha256, size: entry.size, mimeType: 'audio/mpeg' };
    await writeJson(episodeFile, episode);
    await writeJson(path.join(temp, '.podcast-publish', `${entry.stableId}.json`), { kind: 'migration', status: 'uploaded', stableId: entry.stableId, guid: entry.guid, sha256: entry.sha256, size: entry.size, key: `${number}.mp3`, url: `${baseUrl}/${number}.mp3`, ...stateOverrides[number] });
  }
  await fs.mkdir(path.join(temp, 'scripts'));
  await fs.copyFile(path.join(root, 'scripts/migrate-podcast.mjs'), path.join(temp, 'scripts/migrate-podcast.mjs'));
  await fs.copyFile(path.join(root, 'scripts/podcast-lib.mjs'), path.join(temp, 'scripts/podcast-lib.mjs'));
  await fs.symlink(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  const preload = path.join(temp, 'mock-network.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs/promises';\nimport { S3Client } from '${path.join(root, 'node_modules/@aws-sdk/client-s3/dist-cjs/index.js').replaceAll('\\', '/')}' ;\nconst log = process.env.MOCK_LOG; const mode = process.env.MOCK_MODE || 'allow'; let remote = null;\nasync function count(kind) { const current = JSON.parse(await fs.readFile(log, 'utf8').catch(() => '{"s3":0,"http":0}')); current[kind]++; await fs.writeFile(log, JSON.stringify(current)); }\nS3Client.prototype.send = async function(command) { await count('s3'); if (mode === 'deny') throw new Error('unexpected S3 request'); const name = command.constructor.name; if (name === 'HeadObjectCommand') { if (!remote) throw Object.assign(new Error('missing'), { name: 'NotFound' }); return { ContentLength: remote.length, ContentType: 'audio/mpeg' }; } if (name === 'GetObjectCommand') return { Body: (await import('node:stream')).Readable.from([remote]) }; if (name === 'PutObjectCommand') { remote = await fs.readFile(process.env.MOCK_AUDIO); return {}; } throw new Error('unexpected S3 command'); };\nglobalThis.fetch = async (_url, options = {}) => { await count('http'); if (mode === 'deny') throw new Error('unexpected HTTP request'); if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(remote?.length || 0) } }); if (options.headers?.Range) return new Response(remote?.subarray(0, 1), { status: 206, headers: { 'content-range': 'bytes 0-0/' + (remote?.length || 0) } }); return new Response(remote); };\n`);
  const log = path.join(temp, 'mock-log.json'); await fs.writeFile(log, '{"s3":0,"http":0}');
  return { temp, audioRoot, log, entries, episodesRoot, preload, baseUrl };
}

async function runMigration(fixture, mode = 'allow') {
  return exec(process.execPath, ['--import', fixture.preload, 'scripts/migrate-podcast.mjs', '--audio-root', fixture.audioRoot], { cwd: fixture.temp, env: { ...process.env, MOCK_MODE: mode, MOCK_LOG: fixture.log, MOCK_AUDIO: path.join(fixture.audioRoot, '001.mp3'), VK_CLOUD_ENDPOINT: 'https://s3.fixture.test', VK_CLOUD_REGION: 'ru-msk', VK_CLOUD_BUCKET: 'fixture', VK_CLOUD_PUBLIC_BASE_URL: fixture.baseUrl } });
}

if (!process.env.PODCAST_REGRESSION_CHILD) test('CLI миграции пропускает только согласованный выпуск без сети', async () => {
  const fixture = await migrationFixture({ confirmed: ['001'] });
  try {
    const beforeEpisode = await fs.readFile(path.join(fixture.episodesRoot, '001.json'));
    const beforeState = await fs.readFile(path.join(fixture.temp, '.podcast-publish', 'episode-fixture-001.json'));
    const result = await runMigration(fixture, 'allow');
    assert.match(result.stdout, /пропущено подтверждённых 1/);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.log)), { s3: 2, http: 3 });
    assert.deepEqual(await fs.readFile(path.join(fixture.episodesRoot, '001.json')), beforeEpisode);
    assert.deepEqual(await fs.readFile(path.join(fixture.temp, '.podcast-publish', 'episode-fixture-001.json')), beforeState);
  } finally { await fs.rm(fixture.temp, { recursive: true, force: true }); }
});

test('CLI миграции обрабатывает незавершённый выпуск и возобновляется после отказа', async () => {
  const fixture = await migrationFixture({ confirmed: ['001'] });
  try {
    await assert.rejects(() => runMigration(fixture, 'deny'), /unexpected S3 request/);
    assert.equal((await readJson(path.join(fixture.temp, 'podcast-ntt/migration/mapping.json'))).migrationComplete, false);
    assert.equal((await readJson(path.join(fixture.temp, 'podcast-ntt/episodes/002.json'))).audio, null);
    await runMigration(fixture, 'allow');
    assert.equal((await readJson(path.join(fixture.temp, 'podcast-ntt/migration/mapping.json'))).migrationComplete, true);
    assert.equal((await readJson(path.join(fixture.temp, 'podcast-ntt/episodes/002.json'))).audio.key, '002.mp3');
  } finally { await fs.rm(fixture.temp, { recursive: true, force: true }); }
});

test('CLI миграции не пропускает отсутствующее, несогласованное или устаревшее state', async () => {
  for (const setup of [{ confirmed: [] }, { confirmed: ['001'], stateOverrides: { '001': { url: 'https://old.fixture.test/001.mp3' } } }]) {
    const fixture = await migrationFixture(setup);
    try { await runMigration(fixture, 'allow'); const counts = JSON.parse(await fs.readFile(fixture.log)); assert.ok(counts.s3 > 0 && counts.http > 0); }
    finally { await fs.rm(fixture.temp, { recursive: true, force: true }); }
  }
});

test('CLI миграции останавливается до сети при изменении локального файла или аудиоревизии', async () => {
  const fixture = await migrationFixture({ confirmed: ['001'] });
  try {
    await fs.appendFile(path.join(fixture.audioRoot, '001.mp3'), 'changed');
    await assert.rejects(() => runMigration(fixture, 'deny'), /Файл изменился/);
    const fixture2 = await migrationFixture({ confirmed: ['001'] });
    try { const episode = await readJson(path.join(fixture2.episodesRoot, '001.json')); episode.audio.sha256 = 'f'.repeat(64); await writeJson(path.join(fixture2.episodesRoot, '001.json'), episode); await assert.rejects(() => runMigration(fixture2, 'deny'), /уже изменён/); }
    finally { await fs.rm(fixture2.temp, { recursive: true, force: true }); }
  } finally { await fs.rm(fixture.temp, { recursive: true, force: true }); }
});

if (!process.env.PODCAST_REGRESSION_CHILD) test('build/check допускают первый обычный выпуск сверх миграционной карты', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-regression-'));
  try {
    await fs.cp(root, temp, { recursive: true, filter: source => !source.includes(`${path.sep}.git`) && !source.includes(`${path.sep}dist`) && !source.includes(`${path.sep}node_modules`) });
    await fs.symlink(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
    const tempMapping = await readJson(path.join(temp, 'podcast-ntt/migration/mapping.json'));
    tempMapping.migrationComplete = true;
    await fs.writeFile(path.join(temp, 'podcast-ntt/migration/mapping.json'), `${JSON.stringify(tempMapping, null, 2)}\n`);
    const preservedFile = (await fs.readdir(path.join(temp, 'podcast-ntt/episodes'))).find(file => file.endsWith('.json'));
    const preservedEpisode = await readJson(path.join(temp, 'podcast-ntt/episodes', preservedFile));
    preservedEpisode.audio = { url: 'https://cdn.example.test/imported.mp3', size: 2, sha256: '2'.repeat(64), key: 'podcast-ntt/imported.mp3', mimeType: 'audio/mpeg' };
    await fs.writeFile(path.join(temp, 'podcast-ntt/episodes', preservedFile), `${JSON.stringify(preservedEpisode, null, 2)}\n`);
    await exec('npm', ['run', 'podcast:import'], { cwd: temp });
    assert.equal((await readJson(path.join(temp, 'podcast-ntt/episodes', preservedFile))).audio.sha256, '2'.repeat(64));
    await fs.writeFile(path.join(temp, 'podcast-ntt/episodes/episode-regression.json'), `${JSON.stringify({ stableId: 'episode-regression', guid: 'podcast-ntt:regression', title: 'Регрессионный выпуск', description: 'Проверка <script>alert(1)</script> & *текст*\nСсылка: https://example.test/path?a=1&b=2\n\nЕщё https://example.test/second. javascript:alert(1)', descriptionFormat: 'text', pubDate: new Date(0).toUTCString(), publishAt: new Date(0).toISOString(), audio: { url: 'https://cdn.example.test/regression.mp3', size: 1, sha256: '0'.repeat(64), key: 'podcast-ntt/regression.mp3' }, duration: '1', enclosureLength: 1, enclosureType: 'audio/mpeg' }, null, 2)}\n`);
    await fs.writeFile(path.join(temp, 'podcast-ntt/episodes/episode-html.json'), `${JSON.stringify({ stableId: 'episode-html', guid: 'podcast-ntt:html', title: 'HTML', description: '<p>Сохранённый HTML</p>', descriptionFormat: 'html', pubDate: new Date(0).toUTCString(), publishAt: new Date(0).toISOString(), audio: { url: 'https://cdn.example.test/html.mp3', size: 1, sha256: '1'.repeat(64), key: 'podcast-ntt/html.mp3' }, duration: '1', enclosureLength: 1, enclosureType: 'audio/mpeg' }, null, 2)}\n`);
    tempMapping.migrationComplete = false;
    await fs.writeFile(path.join(temp, 'podcast-ntt/migration/mapping.json'), `${JSON.stringify(tempMapping, null, 2)}\n`);
    await assert.rejects(() => exec('npm', ['run', 'build'], { cwd: temp, env: { ...process.env, PODCAST_REQUIRE_READY: 'true' } }));
    tempMapping.migrationComplete = true;
    await fs.writeFile(path.join(temp, 'podcast-ntt/migration/mapping.json'), `${JSON.stringify(tempMapping, null, 2)}\n`);
    const tempEpisodes = (await fs.readdir(path.join(temp, 'podcast-ntt/episodes'))).filter(file => file.endsWith('.json'));
    for (const file of tempEpisodes) {
      const episodePath = path.join(temp, 'podcast-ntt/episodes', file);
      const episode = await readJson(episodePath);
      if (!episode.audio) episode.audio = { url: `https://cdn.example.test/${episode.stableId}.mp3`, size: 1, sha256: '3'.repeat(64), key: `podcast-ntt/${episode.stableId}/3.mp3`, mimeType: 'audio/mpeg' };
      await fs.writeFile(episodePath, `${JSON.stringify(episode, null, 2)}\n`);
    }
    await exec('npm', ['run', 'build'], { cwd: temp, env: { ...process.env, PODCAST_REQUIRE_READY: 'true' } });
    const feed = await fs.readFile(path.join(temp, 'dist/podcast-ntt/feed.xml'), 'utf8');
    assert.match(feed, /<!\[CDATA\[<p>Сохранённый HTML<\/p>\]\]>/);
    assert.doesNotMatch(feed, /&lt;p&gt;Сохранённый HTML/);
    const page = await fs.readFile(path.join(temp, 'dist/podcast-ntt/index.html'), 'utf8');
    for (const output of [page, feed]) {
      assert.ok(output.includes('<p>Проверка &lt;script&gt;alert(1)&lt;/script&gt; &amp; *текст*<br>Ссылка: <a href="https://example.test/path?a=1&amp;b=2">https://example.test/path?a=1&amp;b=2</a></p>'));
      assert.ok(output.includes('<p>Ещё <a href="https://example.test/second">https://example.test/second</a>. javascript:alert(1)</p>'));
      assert.doesNotMatch(output, /href="javascript:/);
    }
    await exec('npm', ['run', 'check'], { cwd: temp, env: { ...process.env, PODCAST_REGRESSION_CHILD: '1' } });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('неудачная проверка не отмечает миграцию завершённой', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-failed-validation-'));
  try {
    await fs.cp(root, temp, { recursive: true, filter: source => !source.includes(`${path.sep}.git`) && !source.includes(`${path.sep}dist`) && !source.includes(`${path.sep}node_modules`) });
    await fs.symlink(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
    const mappingFile = path.join(temp, 'podcast-ntt/migration/mapping.json');
    const before = await readJson(mappingFile);
    before.migrationComplete = false;
    await fs.writeFile(mappingFile, `${JSON.stringify(before, null, 2)}\n`);
    const stateDir = path.join(temp, '.podcast-publish');
    const stateBefore = await fs.readdir(stateDir).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    await assert.rejects(() => exec(process.execPath, ['--input-type=module', '-e', "import { validateMigrationCatalog } from './scripts/podcast-lib.mjs'; await validateMigrationCatalog({ requireAudio: true });"], { cwd: temp }));
    assert.deepEqual(await readJson(mappingFile), before);
    assert.deepEqual(await fs.readdir(stateDir).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), stateBefore);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('возобновление миграции снимает готовность только у готового каталога', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-migration-resume-'));
  try {
    const mappingFile = path.join(temp, 'mapping.json');
    await fs.writeFile(mappingFile, `${JSON.stringify({ migrationComplete: true, entries: [{ stableId: 'one' }, { stableId: 'two' }] }, null, 2)}\n`);
    const ready = await readJson(mappingFile);
    const interrupted = markMigrationInProgress(ready);
    await fs.writeFile(mappingFile, `${JSON.stringify(interrupted, null, 2)}\n`);
    assert.equal((await readJson(mappingFile)).migrationComplete, false);
    assert.equal(markMigrationInProgress({ migrationComplete: false }).migrationComplete, false);
    assert.deepEqual(interrupted.entries, ready.entries);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('служебное состояние не является обязательным для сборки', async () => {
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /^\.podcast-publish\/$/m);
});
