import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';
import { readJson, validateMigrationCatalog } from './podcast-lib.mjs';

const root = process.cwd();
const dist = path.join(root, 'dist');
const siteUrl = 'https://brav.in';
const birthDate = { year: 1988, month: 7, day: 8 };
const templatePath = path.join(root, 'templates/page.html');
const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const required = ['index.md', '404.md', 'favicon.png', 'me.JPG', 'templates/page.html', 'styles/main.css', 'podcast-ntt/show.json', 'assets/podcast-ntt-cover.jpg'];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function readPage(filePath) {
  const parsed = matter(await fs.readFile(filePath, 'utf8'));
  if (!parsed.data.title || typeof parsed.data.title !== 'string') throw new Error(`Нет title: ${filePath}`);
  return { data: parsed.data, content: parsed.content, filePath };
}

function getPostRoutes(filePath) {
  const name = path.basename(filePath, '.md');
  const match = name.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)$/);
  if (!match) throw new Error(`Неверное имя публикации: ${filePath}`);
  const [, year, month, day, slug] = match;
  return { year, month, day, slug, route: `/${year}/${month}/${day}/${slug}/`, legacy: `/${year}/${month}/${day}/${slug}.html` };
}

function slugifyHeading(text, used) {
  const slug = text.toLowerCase().normalize('NFKC').trim().replace(/\s+/g, '-').replace(/[^\p{Letter}\p{Number}_-]/gu, '').replace(/-+/g, '-') || 'heading';
  let result = slug; let number = 2;
  while (used.has(result)) result = `${slug}-${number++}`;
  used.add(result);
  return result;
}

function renderMarkdown(source) {
  const env = {};
  const tokens = md.parse(source, env);
  const used = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    const inline = tokens[index + 1];
    const text = inline?.children?.map(child => child.content).join('') || inline?.content || '';
    token.attrSet('id', slugifyHeading(text, used));
  }
  return md.renderer.render(tokens, md.options, env);
}

function renderPage({ title, description, canonical, content, ogType = 'website' }) {
  const template = templateSource;
  return template
    .replaceAll('{{title}}', escape(title))
    .replaceAll('{{description}}', escape(description))
    .replaceAll('{{canonical}}', escape(canonical))
    .replaceAll('{{ogType}}', escape(ogType))
    .replace('{{content}}', content);
}

function descriptionFrom(content) {
  const plain = content.replace(/<[^>]+>/g, ' ').replace(/[#*_`\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return plain.slice(0, 160);
}

function calculateAge(today = new Date()) {
  let age = today.getUTCFullYear() - birthDate.year;
  const birthdayPassed = today.getUTCMonth() > birthDate.month
    || (today.getUTCMonth() === birthDate.month && today.getUTCDate() >= birthDate.day);
  if (!birthdayPassed) age -= 1;
  return age;
}

function podcastText(value) {
  return escape(value).split(/\n{2,}/).map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('');
}

function podcastDate(episode) {
  const value = episode.pubDate || episode.publishAt;
  return new Date(value).toISOString().slice(0, 10);
}

async function buildPodcast(buildStartedAt) {
  const show = await readJson(path.join(root, 'podcast-ntt/show.json'));
  const { mapping } = await validateMigrationCatalog({ requireAudio: process.env.PODCAST_REQUIRE_READY === 'true' });
  const episodeFiles = (await fs.readdir(path.join(root, 'podcast-ntt/episodes'))).filter(file => file.endsWith('.json')).sort();
  const episodes = [];
  for (const file of episodeFiles) {
    const episode = await readJson(path.join(root, 'podcast-ntt/episodes', file));
    if (episode.audio?.url && new Date(episode.publishAt || episode.pubDate) <= buildStartedAt) episodes.push(episode);
  }
  if (mapping.migrationComplete !== true && (episodes.length || process.env.PODCAST_REQUIRE_READY === 'true')) throw new Error('Миграция подкаста не завершена: RSS не собирается из неполного архива');
  episodes.sort((a, b) => new Date(b.publishAt || b.pubDate) - new Date(a.publishAt || a.pubDate));
  const items = episodes.map(episode => `<article class="podcast-episode"><h2>${escape(episode.title)}</h2><p class="meta"><time datetime="${escape(new Date(episode.publishAt || episode.pubDate).toISOString())}">${escape(podcastDate(episode))}</time></p>${episode.descriptionFormat === 'html' ? episode.description : podcastText(episode.description)}<p><a href="${escape(episode.audio.url)}">Скачать MP3</a></p></article>`).join('\n');
  const content = `<h1>${escape(show.title)}</h1><img class="podcast-cover" src="${escape(show.image)}" alt="Обложка подкаста «${escape(show.title)}»"><p>${escape(show.description)}</p><p><a href="${escape(show.feedUrl)}">Подписаться по RSS</a></p>${show.platforms.map(platform => `<p><a href="${escape(platform.url)}">${escape(platform.title)}</a></p>`).join('')}<section class="podcast-episodes"><h2>Выпуски</h2>${items || '<p>Выпуски пока не опубликованы.</p>'}</section>`;
  await writePage('podcast-ntt/index.html', { title: show.title, description: show.description, canonical: show.pageUrl, content });
  const rssItems = episodes.map(episode => `<item><title>${cdata(episode.title)}</title><description>${episode.descriptionFormat === 'html' ? cdata(episode.description) : cdata(podcastText(episode.description))}</description><pubDate>${escape(episode.pubDate || new Date(episode.publishAt).toUTCString())}</pubDate><guid${episode.guidIsPermaLink == null ? '' : ` isPermaLink="${episode.guidIsPermaLink}"`}>${xmlEscape(episode.guid)}</guid><enclosure url="${escape(episode.audio.url)}" length="${episode.audio.size}" type="audio/mpeg"/><itunes:duration>${escape(episode.duration)}</itunes:duration>${episode.episode ? `<itunes:episode>${escape(episode.episode)}</itunes:episode>` : ''}${episode.season ? `<itunes:season>${escape(episode.season)}</itunes:season>` : ''}${episode.episodeType ? `<itunes:episodeType>${escape(episode.episodeType)}</itunes:episodeType>` : ''}</item>`).join('\n');
  const categories = show.categories.map(category => typeof category === 'string' ? `<itunes:category text="${escape(category)}"/>` : `<itunes:category text="${escape(category.name)}">${category.subcategory ? `<itunes:category text="${escape(category.subcategory)}"/>` : ''}</itunes:category>`).join('');
  const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${cdata(show.title)}</title><description>${cdata(show.description)}</description><language>${escape(show.language)}</language><link>${escape(show.pageUrl)}</link><atom:link href="${escape(show.feedUrl)}" rel="self" type="application/rss+xml"/><itunes:author>${cdata(show.author)}</itunes:author><itunes:owner><itunes:name>${cdata(show.author)}</itunes:name><itunes:email>${escape(show.email)}</itunes:email></itunes:owner><itunes:explicit>${show.explicit ? 'true' : 'false'}</itunes:explicit>${categories}<itunes:image href="${escape(`${siteUrl}${show.image}`)}"/><image><url>${escape(`${siteUrl}${show.image}`)}</url><title>${cdata(show.title)}</title><link>${escape(show.pageUrl)}</link></image>${rssItems}</channel></rss>\n`;
  await fs.mkdir(path.join(dist, 'podcast-ntt'), { recursive: true });
  await fs.writeFile(path.join(dist, 'podcast-ntt/feed.xml'), rss);
}

function cdata(value) { return `<![CDATA[${String(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`; }
function xmlEscape(value) { return escape(value); }

async function writePage(relativePath, page) {
  const output = path.join(dist, relativePath);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, renderPage(page));
}

let templateSource;
async function buildSite() {
  for (const file of required) await fs.access(path.join(root, file));
  templateSource = await fs.readFile(templatePath, 'utf8');
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });

  const home = await readPage(path.join(root, 'index.md'));
  const homeContent = home.content.replaceAll('{{age}}', String(calculateAge()));
  const homeHtml = renderMarkdown(homeContent);
  await writePage('index.html', { title: home.data.title, description: descriptionFrom(homeContent), canonical: `${siteUrl}/`, content: `<h1>${escape(home.data.title)}</h1>${homeHtml}` });

  const notFound = await readPage(path.join(root, '404.md'));
  await writePage('404.html', { title: notFound.data.title, description: descriptionFrom(notFound.content), canonical: `${siteUrl}/404.html`, content: `<h1>${escape(notFound.data.title)}</h1>${renderMarkdown(notFound.content)}` });

  const postFiles = (await fs.readdir(path.join(root, '_posts/talks'))).filter(file => file.endsWith('.md')).sort();
  const routes = [];
  for (const file of postFiles) {
    const page = await readPage(path.join(root, '_posts/talks', file));
    const route = getPostRoutes(file);
    if (routes.some(item => item.route === route.route || item.legacy === route.legacy)) throw new Error(`Коллизия маршрута: ${file}`);
    routes.push(route);
    const date = `${route.year}-${route.month}-${route.day}`;
    const content = `<h1>${escape(page.data.title)}</h1><p class="meta"><time datetime="${date}">${date}</time></p>${renderMarkdown(page.content)}`;
    await writePage(`${route.year}/${route.month}/${route.day}/${route.slug}/index.html`, { title: page.data.title, description: descriptionFrom(page.content), canonical: `${siteUrl}${route.route}`, ogType: 'article', content });
    await writePage(`${route.year}/${route.month}/${route.day}/${route.slug}.html`, { title: page.data.title, description: descriptionFrom(page.content), canonical: `${siteUrl}${route.route}`, ogType: 'article', content });
  }

  await fs.cp(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });
  await fs.copyFile(path.join(root, 'styles/main.css'), path.join(dist, 'assets/styles.css'));
  await fs.copyFile(path.join(root, 'favicon.png'), path.join(dist, 'favicon.png'));
  await fs.copyFile(path.join(root, 'me.JPG'), path.join(dist, 'me.JPG'));
  await fs.copyFile(path.join(root, 'assets/podcast-ntt-cover.jpg'), path.join(dist, 'assets/podcast-ntt-cover.jpg'));
  await fs.rm(path.join(dist, 'assets/js'), { recursive: true, force: true });
  await fs.writeFile(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);
  await buildPodcast(new Date());
  const sitemap = [`${siteUrl}/`, `${siteUrl}/podcast-ntt/`, ...routes.map(route => `${siteUrl}${route.route}`)].map(url => `  <url><loc>${url}</loc></url>`).join('\n');
  await fs.writeFile(path.join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap}\n</urlset>\n`);
}

buildSite().catch(error => { console.error(error.message); process.exitCode = 1; });
