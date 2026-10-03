#!/usr/bin/env node
// node scripts/hcu-audit.mjs <domain> > audit.json  (人读摘要在 stderr)
// 零依赖；复用 seo-audit 的 sitemap / HTML 函数，不修改原文件。
// ponytail: HTML 静态近似不执行 CSS/JS；真实可见性、功能和质量由人工判读。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
if (process.env.NODE_USE_ENV_PROXY !== '1') {
  const r = spawnSync(process.execPath, process.argv.slice(1), { env: { ...process.env, NODE_USE_ENV_PROXY: '1' }, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const base = new URL(process.argv[2].includes('://') ? process.argv[2] : `https://${process.argv[2]}`);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const cache = new Map(), xmls = [], failures = [];
async function get(url) {
  if (!cache.has(url)) cache.set(url, (async () => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000), redirect: 'follow' });
      const html = await r.text();
      if (/<(?:sitemapindex|urlset)[\s>]/i.test(html)) xmls.push({ url, html });
      return { status: r.status, finalUrl: r.url, html };
    } catch (e) { failures.push({ url, error: e.message }); return { status: null, finalUrl: url, html: '', error: e.message }; }
  })());
  return cache.get(url);
}
const source = readFileSync(new URL('./seo-audit.mjs', import.meta.url), 'utf8');
const ctx = vm.createContext({ fetch: async url => {
  const r = await get(url);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, url: r.finalUrl, text: async () => r.html };
}});
vm.runInContext(source.slice(source.indexOf('async function fetchHtml('), source.indexOf('// ─── Analysis: Overview')), ctx);
const { fetchSitemapUrls, extractVisibleText: text, extractTag, extractAllTags, extractAttr, meta, extractLang } = ctx;
const home = await get(base.href);
let urls = [], sitemapError = null;
try { urls = [...new Set(await fetchSitemapUrls(new URL('/sitemap.xml', base).href))]; }
catch (e) { sitemapError = e.message; }
const dates = new Map();
for (const { html } of xmls) for (const m of html.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
  const u = m[1].match(/<loc>(.*?)<\/loc>/s)?.[1];
  if (u) dates.set(u.trim(), m[1].match(/<lastmod>(.*?)<\/lastmod>/s)?.[1] ?? null);
}
const locales = /^(en|en-us|en-gb|ja|jp|ko|zh|zh-cn|zh-tw|fr|de|es|pt|pt-br|ru|ar|it|tr|id|vi|th|nl|pl)$/i;
function pathInfo(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const locale = locales.test(parts[0] ?? '') ? parts.shift() : 'default';
  const trust = /^(about|about-us|contact|contact-us|privacy|privacy-policy|terms|terms-of-service|methodology|methods|editorial-policy)$/;
  if (parts[0] === 'games' && parts.length >= 3) parts[1] = ':game';
  const template = !parts.length ? '/' : trust.test(parts[0]) ? '/@trust' : parts.length === 1 ? '/:page' : '/' + parts.slice(0, -1).map(p => /^\d+$/.test(p) ? ':id' : p).join('/') + '/:entity';
  return { locale, template };
}
const groups = new Map();
for (const url of new Set([base.href, ...urls])) {
  const p = pathInfo(url), key = `${p.locale} ${p.template}`;
  if (!groups.has(key)) groups.set(key, { ...p, urls: [] });
  groups.get(key).urls.push(url);
}
const selected = [];
for (const g of groups.values()) {
  g.samples = g.urls.length <= 8 ? g.urls : Array.from({length:8}, (_, i) => g.urls[Math.round(i * (g.urls.length - 1) / 7)]);
  selected.push(...g.samples);
}
function links(html, url) {
  return extractAllTags(html, 'a').map(a => {
    const href = extractAttr(a.attrs, 'href');
    try { return href && { url: new URL(href.replace(/&amp;/g, '&'), url).href, label: text(a.text), rel: extractAttr(a.attrs, 'rel') }; } catch { return null; }
  }).filter(Boolean);
}
function schemas(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1])); } catch { out.push({ parseError: true }); }
  }
  return out;
}
const pages = [];
for (let i = 0; i < selected.length; i += 6) {
  pages.push(...await Promise.all(selected.slice(i, i + 6).map(async url => {
    const r = await get(url), html = r.html;
    const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
    const main = mainMatch?.[1] ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
    const cleaned = main.replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+\bhidden(?:\s|=|>)[\s\S]*?<\/[^>]+>/gi, ' ');
    const body = text(cleaned), allLinks = links(html, url), structured = schemas(html);
    const authorLinks = allLinks.filter(a => /author/i.test(a.rel ?? '') || /\/(authors?|team|contributors?)(?:\/|$)/i.test(a.url) || /editorial|written by|著者|作者/i.test(a.label));
    const trustLinks = allLinks.filter(a => new URL(a.url).origin === base.origin && /about|contact|privacy|terms|method|editorial|sobre|contato|privacidade|termos|運営|お問い合わせ|プライバシー|利用規約|소개|문의|개인정보|이용약관/i.test(a.url + ' ' + a.label));
    const sourceLinks = allLinks.filter(a => /^https?:/.test(a.url) && new URL(a.url).hostname !== base.hostname);
    const headings = extractAllTags(main, 'h2').map(x => x.text);
    const claimSnippets = [...body.matchAll(/.{0,80}(?:\d+[%％]|\b(?:best|tested|expert|certified|accurate|healing|cure|scientific|million)\b|AI|人工|監修|科学).{0,150}/gi)].slice(0,25).map(m => m[0]);
    return { url, ...pathInfo(url), status:r.status, finalUrl:r.finalUrl, error:r.error, lang:extractLang(html), title:extractTag(html,'title'), h1:extractAllTags(html,'h1').map(x=>x.text), headings,
      visibleBodyChars:body.replace(/\s/g,'').length, visibleBodyWords:[...new Intl.Segmenter(extractLang(html) ?? 'en', {granularity:'word'}).segment(body)].filter(s=>s.isWordLike).length,
      body, excerpt:body.slice(0,1100), claimSnippets, robots:meta(html,'robots'), lastmod:dates.get(url)??null,
      byline:meta(html,'author') ?? body.match(/(?:By|Written by|著者|作者|작성자)\s+([^·|]{3,70})/i)?.[1] ?? null, authorLinks, trustLinks, sourceLinks, structured,
      dateModified:[...html.matchAll(/["']dateModified["']\s*:\s*["']([^"']+)/gi)].map(m=>m[1]),
      aiDisclosureCandidates:claimSnippets.filter(s=>/AI|generated|人工/i.test(s)), methodCandidates:headings.filter(s=>/how|method|source|works|使い方|方法|como|comment|كيف/i.test(s)),
      manualReview:{titleContentAlignment:'待人工判读',schemaVisibleConsistency:'待人工判读',fabricatedAuthorOrPortrait:'待人工判读；姓名/头像存在不能证明伪造',aiDisclosureAdequacy:'待人工判读',thinOrUniqueIncrement:'待人工判读；无字数门槛',url} };
  })));
  console.error(`已抓取 ${Math.min(i+6, selected.length)}/${selected.length}`);
}
const linkChecks = [];
const checkUrls = [...new Set(pages.flatMap(p => [...p.authorLinks,...p.trustLinks].map(x=>x.url)).filter(u=>/^https?:/.test(u)))];
for (let i=0;i<checkUrls.length;i+=6) linkChecks.push(...await Promise.all(checkUrls.slice(i,i+6).map(async url=>{const r=await get(url);return {url,status:r.status,finalUrl:r.finalUrl,title:extractTag(r.html,'title'),excerpt:text(r.html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]??r.html).slice(0,1600)};})));
function shingles(p) {
  let s=p.body.toLowerCase();
  for (const entity of [...p.h1,decodeURIComponent(new URL(p.url).pathname.split('/').filter(Boolean).at(-1)??'').replaceAll('-',' ')]) if(entity) s=s.split(entity.toLowerCase()).join(' ENTITY ');
  const words=[...new Intl.Segmenter(p.lang??'en',{granularity:'word'}).segment(s)].filter(x=>x.isWordLike).map(x=>x.segment);
  return new Set(words.slice(0,-4).map((_,i)=>words.slice(i,i+5).join(' ')));
}
const shingleMap=new Map(pages.map(p=>[p.url,shingles(p)]));
function overlap(a,b) {const x=shingleMap.get(a.url),y=shingleMap.get(b.url);const intersection=[...x].filter(s=>y.has(s)).length;return x.size+y.size-intersection ? +(intersection/(x.size+y.size-intersection)).toFixed(4):null;}
const similarities=[], multilingual=[];
for(let i=0;i<pages.length;i++) for(let j=i+1;j<pages.length;j++) {
  const a=pages[i],b=pages[j];
  if(a.template===b.template && a.locale===b.locale) similarities.push({a:a.url,b:b.url,jaccard:overlap(a,b)});
  if(a.locale!==b.locale && new URL(a.url).pathname.split('/').filter(Boolean).filter((s,i)=>i!==0||!locales.test(s)).join('/')===new URL(b.url).pathname.split('/').filter(Boolean).filter((s,i)=>i!==0||!locales.test(s)).join('/')) multilingual.push({a:a.url,b:b.url,bodyLiteralOverlap:overlap(a,b),h2CountA:a.headings.length,h2CountB:b.headings.length,judgment:'待人工判读；跨语言字面低重合不代表有增量'});
}
const dateCounts={};for(const d of dates.values()) if(d) dateCounts[d.slice(0,10)]=(dateCounts[d.slice(0,10)]??0)+1;
const result={domain:base.hostname,checkedAt:new Date().toISOString(),nodeUseEnvProxy:process.env.NODE_USE_ENV_PROXY,userAgent:UA,homeStatus:home.status,homeFinalUrl:home.finalUrl,sitemapError,sitemapUrls:urls,sitemaps:xmls.map(x=>x.url),
  groups:[...groups.values()].map(g=>({...g,count:g.urls.length})),pages,linkChecks,similarities,multilingual,lastmod:{counts:dateCounts,allSameDay:Object.keys(dateCounts).length===1&&dates.size>1,dailyChanges:'未验证；单次快照不能判每日变化'},
  indexedPageCount:'未验证；sitemap URL 数不等于 Google 索引数',thinPageRatio:'待人工判读；功能也属于主内容',uniqueIncrementRatio:'待人工判读；需逐 URL 功能/数据证据',failures,
  limitations:['路径自动分组需对照仓库路由人工校正','复用 sitemap 递归函数上限 3 层；不是无限深度','未执行 JS/CSS；可见正文字数为 raw HTML 去导航近似','非抽样页只读取 sitemap URL/lastmod，未全量抓 HTML','不以相似度、字数、统一 lastmod 自动命中红线']};
console.log(JSON.stringify(result,null,2));
console.error(`${base.hostname}: 首页 HTTP ${home.status}；sitemap ${urls.length} URL；${groups.size} 模板×语言组；抽样 ${pages.length} 页；链接核实 ${linkChecks.length}；失败 ${failures.length}。语义、薄页、独有增量、作者真实性均待人工判读。`);
