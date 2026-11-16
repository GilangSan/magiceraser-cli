/**
 * Runnable self-check: every method against the live API.
 *
 *   python3 -c "from PIL import Image; Image.new('RGB',(256,256),(120,80,200)).save('t.jpg')"
 *   node selfcheck.mjs [t.jpg]
 */
import { readFileSync } from 'node:fs';
import { MagicEraser, imageSize, rleRect, rleEncode, rleDecode, quota } from './index.js';

const path = process.argv[2] || 't.jpg';
const jpeg = readFileSync(path);
const { width, height } = imageSize(jpeg);
const me = new MagicEraser();

const ok = (label, value) => console.log(`${label.padEnd(18)} ${value}`);

ok('input', `${width}x${height}, ${jpeg.length} bytes`);
ok('login', `token ${(await me.login()).length} chars`);

const mask = await me.segmentPoints(jpeg, [[10, 10], [20, 20]]);
ok('segmentPoints', `${mask.length} bytes rle, ${rleDecode(mask, width, height).filter((v) => v).length} px selected`);
ok('segmentText', `${(await me.segmentText(jpeg, 'cat')).length} bytes rle`);

const rect = rleRect(width, height, [width * 0.3 | 0, height * 0.3 | 0, width * 0.7 | 0, height * 0.7 | 0]);
ok('inpaint', (await me.inpaint(jpeg, rect)).map((b) => `${b.length}b`).join(', '));
ok('inpaint(pro)', `${(await me.inpaint(jpeg, rect, { pro: true })).length} images`);
ok('upscale', `${imageSize(await me.upscale(jpeg, 512, 512)).width}px`);

const matte = await me.removeBg(jpeg);
ok('removeBg', `${matte.length}b, id ${me.lastImageId.toString('hex').slice(0, 8)}…`);
ok('refineMask', `${(await me.refineMask(me.lastImageId, jpeg, rleEncode(width, height), rect)).length}b`);

ok('expand', `${(await me.expand(jpeg, rect)).length} images`);
ok('replace', `${(await me.replace(jpeg, rect, 'a red apple')).length} images`);
ok('generateBackground', `${(await me.generateBackground(jpeg, rect, 'beach sunset')).length} images`);
ok('imagen', `${imageSize(await me.imagen('a cat')).width}px`);
ok('enhance', `${imageSize(await me.enhance(jpeg)).width}px`);
ok('flash', `${imageSize(await me.flash(jpeg)).width}px`);
ok('flashTemplates', `${(await me.flashTemplates()).length} styles`);
ok('relight', `${(await me.relight(jpeg)).subarray(0, 4).toString('latin1')}`);
ok('relight(saliency)', `${(await me.relight(jpeg, { saliency: true })).subarray(0, 4).toString('latin1')}`);
ok('faceEdit', `${(await me.faceEdit(jpeg)).subarray(0, 4).toString('latin1')}`);
try {
  await me.depth(jpeg);
  ok('depth guard', 'FAILED — accepted a non-392 image');
} catch (e) {
  ok('depth guard', e.message.slice(0, 60));
}
const j392 = process.argv[3] ? readFileSync(process.argv[3]) : null;
ok('depth', j392 ? `${(await me.depth(j392)).subarray(0, 4).toString('latin1')}` : 'skipped (pass a 392px jpeg as argv[3])');
ok('quota', JSON.stringify((await quota('selfcheck-device')).data));
