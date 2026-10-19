import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function workingWorkstation(svg){
 const style=`<style>
 .seated-arms{animation:orvo-type .22s steps(2,end) infinite}
 .seated-head{transform-box:fill-box;transform-origin:center;animation:orvo-focus 1.3s steps(3,end) infinite}
 .pixel-code{animation:orvo-code .9s steps(3,end) infinite}
 @keyframes orvo-type{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
 @keyframes orvo-focus{0%,100%{transform:rotate(0)}45%{transform:rotate(-2deg)}75%{transform:rotate(1deg)}}
 @keyframes orvo-code{0%,100%{opacity:1}50%{opacity:.35}}
 @media(prefers-reduced-motion:reduce){*{animation:none!important}}
 </style>`;
 if(!svg.includes('seated-arms')||!svg.includes('seated-head'))throw new Error('Original seated character is required');
 return svg.replace(/(<svg\b[^>]*>)/,`$1${style}`);
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 for(let index=1;index<=6;index++){
  const svg=fs.readFileSync(`public/design/workstation-${index}.svg`,'utf8');
  fs.writeFileSync(`public/design/workstation-working-${index}.svg`,workingWorkstation(svg));
 }
 console.log('Generated 6 working variants from the original seated characters.');
}
