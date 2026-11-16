#!/usr/bin/env node
/**
 * magiceraser — CLI over the Magic Eraser API.
 *
 *   magiceraser remove-bg  in.jpg out.bin
 *   magiceraser inpaint    in.jpg out.jpg --rect 96,96,160,160 [--pro] [--invert]
 *   magiceraser segment    in.jpg out.bin --rect 96,96,160,160 | --text car | --points 10,10,20,20
 *   magiceraser upscale    in.jpg out.jpg 1024 1024
 *   magiceraser enhance    in.jpg out.jpg [--x4] [--face] [--color]
 *   magiceraser flash      in.jpg out.jpg [--style rosy_haze] [--list]
 *   magiceraser imagen     out.jpg "a cat" [--size 1024x1024] [--style watercolor] [--version flux]
 *   magiceraser expand     in.jpg out --rect x1,y1,x2,y2 [-n 2]
 *   magiceraser replace    in.jpg out --rect x1,y1,x2,y2 --prompt "a red apple"
 *   magiceraser genbg      in.jpg out --rect x1,y1,x2,y2 --prompt "beach sunset"
 *   magiceraser depth      in.jpg out.bin          (long edge must be 392)
 *   magiceraser relight    in.jpg out.bin [--saliency]
 *   magiceraser face       in.jpg out.bin [--jawline]
 *   magiceraser quota      [deviceId] [feature]
 *   magiceraser info       in.jpg
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MagicEraser, imageSize, rleRect, quota } from '../index.js';

const argv = process.argv.slice(2);
const cmd = argv.shift();

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  argv.splice(i, 2);
  return v;
}

const input = argv[0];
const output = argv[1];
const load = () => readFileSync(input);
const maskArgs = () => {
  const { width, height } = imageSize(load());
  const rect = flag('rect');
  if (!rect) throw new Error('need --rect x1,y1,x2,y2 (brush masks: use the JS API)');
  return rleRect(width, height, String(rect).split(',').map(Number), { invert: !!flag('invert') });
};
// one image + a real image extension -> write exactly `output`; otherwise `output-N.jpg`
const images = (arr) => arr.map((b, i) => {
  const p = arr.length === 1 && /\.(jpe?g|png)$/i.test(output) ? output : `${output.replace(/\.\w+$/, '')}-${i}.jpg`;
  writeFileSync(p, b);
  return p;
});

const me = new MagicEraser();

switch (cmd) {
  case 'info': {
    const { width, height } = imageSize(load());
    console.log(`${width}x${height}, ${load().length} bytes`);
    break;
  }
  case 'remove-bg': {
    writeFileSync(output, await me.removeBg(load(), { userType: flag('user-type') || 'free' }));
    console.log(`matte -> ${output} (image id ${me.lastImageId.toString('hex')})`);
    break;
  }
  case 'segment': {
    const text = flag('text');
    const points = flag('points');
    let mask;
    if (text) mask = await me.segmentText(load(), String(text));
    else if (points) mask = await me.segmentPoints(load(), String(points).split(',').reduce((a, v, i, s) => (i % 2 ? a : [...a, [Number(v), Number(s[i + 1])]]), []));
    else mask = maskArgs();
    writeFileSync(output, mask);
    console.log(`${mask.length} bytes rle -> ${output}`);
    break;
  }
  case 'inpaint': {
    const outs = await me.inpaint(load(), maskArgs(), { pro: !!flag('pro'), safety: flag('safety') || 'strict' });
    console.log(images(outs).join('\n'));
    break;
  }
  case 'upscale': {
    writeFileSync(output, await me.upscale(load(), Number(argv[2]), Number(argv[3])));
    console.log(`-> ${output}`);
    break;
  }
  case 'enhance': {
    writeFileSync(output, await me.enhance(load(), { x4: !!flag('x4'), enhanceFace: !!flag('face'), enhanceColor: !!flag('color') }));
    console.log(`-> ${output}`);
    break;
  }
  case 'flash': {
    if (flag('list')) { console.log((await me.flashTemplates()).map((t) => `${t.id}\t${t.name}`).join('\n')); break; }
    writeFileSync(output, await me.flash(load(), flag('style') || 'rosy_haze'));
    console.log(`-> ${output}`);
    break;
  }
  case 'imagen': {
    const outPath = argv[0];
    const prompt = argv[1];
    if (!outPath || !prompt) throw new Error('usage: imagen out.jpg "prompt"');
    writeFileSync(outPath, await me.imagen(prompt, {
      size: flag('size') || '1024x1024', style: flag('style') || '', version: flag('version') || 'flux',
    }));
    console.log(`-> ${outPath}`);
    break;
  }
  case 'expand':
    console.log(images(await me.expand(load(), maskArgs(), { numImages: Number(flag('n') || 1) })).join('\n'));
    break;
  case 'replace':
    console.log(images(await me.replace(load(), maskArgs(), String(flag('prompt')), { numImages: Number(flag('n') || 1) })).join('\n'));
    break;
  case 'genbg':
    console.log(images(await me.generateBackground(load(), maskArgs(), String(flag('prompt')), { numImages: Number(flag('n') || 1) })).join('\n'));
    break;
  case 'depth':
    writeFileSync(output, await me.depth(load()));
    console.log(`-> ${output}`);
    break;
  case 'relight':
    writeFileSync(output, await me.relight(load(), { saliency: !!flag('saliency') }));
    console.log(`-> ${output}`);
    break;
  case 'face':
    writeFileSync(output, await me.faceEdit(load(), { jawline: !!flag('jawline') }));
    console.log(`-> ${output}`);
    break;
  case 'quota': {
    const { status, data } = await quota(argv[0] || 'unknown-device', argv[1] || 'ai-fill');
    console.log(status, JSON.stringify(data));
    break;
  }
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].split('/**')[1].trim());
    process.exit(cmd ? 1 : 0);
}
