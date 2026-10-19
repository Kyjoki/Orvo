import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {workingWorkstation} from './workstation-animation.mjs';

// Reproducible extraction of the supplied design. No exported runtime is executed.
const source = process.argv[2] || 'C:/Users/Maksim/Downloads/Orvo-Pixel-Office-Seated.html';
const out = path.resolve('public/design');
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
const html = fs.readFileSync(source, 'utf8');
const packed = (text, name) => {
 const match = text.match(new RegExp('<script type="__bundler/' + name + '">([\\s\\S]*?)<\\/script>'));
 return match ? JSON.parse(match[1]) : null;
};
const decode = entry => {
 const bytes = Buffer.from(entry.data, 'base64');
 return entry.compressed ? zlib.gunzipSync(bytes) : bytes;
};
const topGroups = svg => {
 let depth = 0, start = 0; const groups = [];
 for (const match of svg.matchAll(/<g\b[^>]*>|<\/g>/g)) {
  if (match[0].startsWith('</')) { if (--depth === 0) groups.push(svg.slice(start, match.index + match[0].length)); }
  else { if (depth++ === 0) start = match.index; }
 }
 return groups;
};
const removeGroups = (svg, className) => {
 const starts = [...svg.matchAll(new RegExp('<g\\b[^>]*class="[^"]*' + className + '[^"]*"[^>]*>', 'g'))];
 for (const start of starts.reverse()) {
  let depth = 0;
  for (const token of svg.slice(start.index).matchAll(/<g\b[^>]*>|<\/g>/g)) {
   if (token[0].startsWith('</')) depth--; else depth++;
   if (depth === 0) { svg = svg.slice(0, start.index) + svg.slice(start.index + token.index + token[0].length); break; }
  }
 }
 return svg;
};
const normalizeSvg = svg => removeGroups(svg, 'pixel-bubble')
 .replaceAll('sc-camel-view-box', 'viewBox')
 .replace(/<rect[^>]*class="\{\{sl\.[^>]*\/>/g, '')
 .replace(/\{\{an\.[^}]+\}\}/g, 'pixel-idle')
 .replace(/\s[\w-]+="[^"]*\{\{[^>]*?"/g, '')
 .replace('<svg ', '<svg shape-rendering="crispEdges" ');
const rootManifest = packed(html, 'manifest');
const order = packed(html, 'page_order');
const titles = [...packed(html, 'template').matchAll(/<h2>(.*?)<\/h2>/g)].map(m => m[1]);
const license = html.match(/<!--([\s\S]*?)-->/)?.[1];
if (license) fs.writeFileSync(path.join(out, 'FONT-LICENSES.txt'), license.trim() + '\n');
const pages = [];
for (const [index, id] of order.entries()) {
 let page = decode(rootManifest[id]).toString('utf8');
 const localManifest = packed(page, 'manifest') || {};
 page = packed(page, 'template') || page;
 for (const [assetId, entry] of Object.entries(localManifest)) {
  if (entry.mime.startsWith('font/')) {
   fs.writeFileSync(path.join(out, 'fonts', assetId + '.woff2'), decode(entry));
   page = page.replaceAll(assetId, '/design/fonts/' + assetId + '.woff2');
  }
 }
 // Static reference only: exclude all design-export framework/demo logic.
 page = page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
 page = page.replace(/@font-face\s*\{[^}]*https:\/\/[^}]*\}/g, '');
 const name = String(index + 1).padStart(2, '0');
 fs.writeFileSync(path.join(out, name + '-reference.html'), page);
 const styles = [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
 fs.writeFileSync(path.join(out, name + '-reference.css'), styles);
 const svgs = [...page.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map(m => m[0]);
 pages.push({ title: titles[index], html: name + '-reference.html', css: name + '-reference.css', svgCount: svgs.length });
 if (index === 0) {
  const office = svgs.find(s => s.includes('pixel-office'));
  if (!office) throw new Error('Pixel office SVG missing');
  fs.writeFileSync(path.join(out, 'office.svg'), normalizeSvg(office));
  fs.writeFileSync(path.join(out, 'icons.svg'), svgs[0].replaceAll('sc-camel-view-box', 'viewBox').replace(/<svg[^>]*>/,'<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'));
  const groups = topGroups(office);
  const desks = groups.filter(g => /^<g\b[^>]*transform="translate\((?:220 204|420 204|620 204|220 380|420 380)\)"/.test(g));
  const people = groups.filter(g => g.includes('class="pixel-person'));
  let background = office;
  for (const group of [...desks, ...people]) background = background.replace(group, '');
  fs.writeFileSync(path.join(out, 'office-background.svg'), normalizeSvg(background));
  const svgWrap = (inner, viewBox) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" shape-rendering="crispEdges">' + inner + '</svg>\n';
  for (const [i, person] of people.entries()) {
   const localPerson = normalizeSvg(person).replace(/transform="translate\([^)]*\)"/, '');
   fs.writeFileSync(path.join(out, 'person-' + (i + 1) + '.svg'), svgWrap(localPerson, '-30 -65 60 100'));
   const localDesk = desks[i % desks.length].replace(/transform="translate\([^)]*\)"/, '');
   fs.writeFileSync(path.join(out, 'empty-workstation-' + (i + 1) + '.svg'), svgWrap(localDesk, '-72 -76 144 168'));
   const seated = '<g transform="translate(0 52)">' + localPerson + '</g>';
   const workstation=svgWrap(localDesk + seated, '-72 -76 144 168');
   fs.writeFileSync(path.join(out, 'workstation-' + (i + 1) + '.svg'), workstation);
   fs.writeFileSync(path.join(out, 'workstation-working-' + (i + 1) + '.svg'), workingWorkstation(workstation));
  }
  const fonts = [...styles.matchAll(/@font-face\s*\{[^}]*\}/g)].map(m=>m[0]).join('\n');
  fs.writeFileSync(path.join(out,'fonts.css'), fonts + '\n');
  const dark = styles.match(/\.o\{(--bg:[\s\S]*?);?\s*background:/)?.[1];
  const light = styles.match(/\.o\.light\{([^}]+)\}/)?.[1];
  fs.writeFileSync(path.join(out,'tokens.css'), ':root,.o{'+dark+'}\n[data-theme="light"],.o.light{'+light+'}\n');
 }
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ source: path.basename(source), pages, fonts: ['Golos Text', 'JetBrains Mono', 'Unbounded'], canvas: {width:1000,height:600} }, null, 2));
console.log('Extracted ' + pages.length + ' static references, pixel office, 6 characters, 6 modular workstations, fonts and tokens.');
