import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';

const root = process.cwd();
const dist = path.join(root, 'dist');
const siteUrl = 'https://brav.in';
const posts = [
  '2017/04/15/talks-stachka', '2017/04/20/talks-rif-kib', '2017/06/08/talks-arvrmr-conf',
  '2017/07/06/talks-ux-maraphone', '2017/09/30/talks-bif', '2018/03/17/talks-secon',
  '2018/08/13/podcast-post-launch', '2018/09/15/talks-bif', '2018/10/27/podcast-kdi',
  '2019/04/19/talks-secon-1', '2019/04/19/talks-secon-2', '2019/09/14/talks-bif',
  '2019/10/12/talks-stachka', '2020/02/29/gamedev-in-kazan', '2021/06/08/masterplan-tycoon-is-not-a-real-game'
];
const read = file => fs.readFile(path.join(dist, file), 'utf8');
const walk = node => [node, ...(node.childNodes || []).flatMap(walk)];
const attrs = node => Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value]));

async function document(file) { return parse(await read(file)); }
function links(doc) { return walk(doc).filter(node => node.nodeName === 'a' || node.nodeName === 'img' || node.nodeName === 'iframe' || node.nodeName === 'video').map(node => ({ node, attrs: attrs(node) })); }
function textContent(node) { return (node.childNodes || []).map(child => child.nodeName === '#text' ? child.value : textContent(child)).join(''); }
async function exists(candidates) { for (const candidate of candidates) { try { await fs.access(path.join(dist, candidate)); return true; } catch {} } return false; }

test('обязательные файлы существуют', async () => {
  for (const file of ['index.html', '404.html', 'assets/styles.css', 'favicon.png', 'robots.txt', 'sitemap.xml']) await fs.access(path.join(dist, file));
});

test('главная содержит только нужные контакты и не содержит Tokyo', async () => {
  const source = await read('index.html');
  const doc = await document('index.html');
  const contactBlock = walk(doc).find(node => attrs(node).class === 'contact-links');
  assert.ok(contactBlock, 'не найден блок контактов');
  const contactLinks = walk(contactBlock).filter(node => node.nodeName === 'a');
  assert.deepEqual(contactLinks.map(node => attrs(node).href), [
    'mailto:anton.bravin@yandex.ru',
    'https://t.me/rootools',
    'https://x.com/rootools'
  ]);
  for (const link of contactLinks) {
    const linkAttrs = attrs(link);
    assert.ok(linkAttrs['aria-label']);
    assert.ok(linkAttrs.title);
    const icon = walk(link).find(node => node.nodeName === 'svg');
    assert.equal(attrs(icon)['aria-hidden'], 'true');
  }
  assert.doesNotMatch(source, /Tokyo|tokyo_logo|facebook|instagram/i);
});

test('все публикации имеют два адреса и правильный canonical', async () => {
  for (const route of posts) {
    const page = await document(`${route}/index.html`);
    const legacy = await document(`${route}.html`);
    const canonical = walk(page).find(node => node.nodeName === 'link' && attrs(node).rel === 'canonical');
    assert.equal(attrs(canonical).href, `${siteUrl}/${route}/`);
    assert.match(textContent(legacy), /Masterplan|Стачка|Конференция|игр|VR|Secon|Post Launch|GameDev|БИФ|КИБ|Joy Lab/);
  }
});

test('локальные ресурсы разрешаются', async () => {
  const files = ['index.html', '404.html', ...posts.map(route => `${route}/index.html`), ...posts.map(route => `${route}.html`)];
  for (const file of files) {
    const doc = await document(file);
    for (const { attrs: item } of links(doc)) {
      for (const value of [item.href, item.src]) {
        if (!value || !value.startsWith('/') || value.startsWith('//')) continue;
        const target = value.split('#')[0].split('?')[0];
        if (!target || target === '/') continue;
        const candidates = [target.slice(1), `${target.slice(1)}index.html`];
        assert.ok(await exists(candidates), `${file}: ${value}`);
      }
    }
  }
});

test('сохранены якоря большой статьи', async () => {
  const doc = await document('2021/06/08/masterplan-tycoon-is-not-a-real-game/index.html');
  const ids = new Set(walk(doc).map(node => attrs(node).id).filter(Boolean));
  assert.deepEqual([...['глава-1', 'глава-2', 'глава-3']].filter(id => ids.has(id)), ['глава-1', 'глава-2', 'глава-3']);
});

test('результат не содержит старые шаблоны и разделы', async () => {
  const files = ['index.html', '404.html', ...posts.map(route => `${route}/index.html`), 'sitemap.xml'];
  const text = await Promise.all(files.map(read)).then(values => values.join('\n'));
  assert.doesNotMatch(text, /Liquid|Jekyll|localhost|\{%|\{%/i);
  assert.doesNotMatch(text, /href="\/(cv|talks|search|atom\.xml|feed\.json)/);
  const sitemap = await read('sitemap.xml');
  assert.equal((sitemap.match(/<loc>/g) || []).length, 16);
  assert.doesNotMatch(sitemap, /\.html/);
});
