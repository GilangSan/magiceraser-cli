/**
 * magiceraser-cli — Magic Eraser (com.duygiangdg.magiceraser) API client.
 *
 * Recovered from APK v3.3.35 (versionCode 402) by static analysis; every
 * endpoint and body framing below was verified against the live backends.
 *
 * Zero dependencies: Node's global fetch/FormData/Blob + Buffer only.
 *
 * Auth: the prod issuer (auth.magiceraser.live) wants a Play Integrity /
 * App Check token, but the debug issuer (auth-dev.magiceraser.live) still
 * accepts the literal string "android-debug-emulator" and mints a real
 * 15-minute JWT that every prod gateway accepts.
 */

const AUTH_DEV = 'https://auth-dev.magiceraser.live/login';
const GATEWAY = 'https://gateway.magiceraser.live';
const REMBG = 'https://apirembg.magiceraser.fyi';
const ENHANCE = 'https://apienhance.magiceraser.live';
const EXPAND = 'https://apiexpand.magiceraser.fyi';
const REPLACE = 'https://apireplace.magiceraser.live';
const GENBG = 'https://apigenbg.magiceraser.fyi';
const IMAGEN = 'https://apiimagen.magiceraser.fyi';
const FLASH = 'https://flash-service.magiceraser.live';
const BODYTUNE = 'https://apibodytune.magiceraser.fyi';
const DEPTH = 'https://apidepth.magiceraser.fyi';
const QUOTA = 'https://us-central1-magic-eraser-475709.cloudfunctions.net';
const UA = 'okhttp/4.12.0';
const DEBUG_TOKEN = 'android-debug-emulator';

async function req(url, { body, headers = {}, method = 'POST' } = {}) {
  const res = await fetch(url, { method, headers: { 'User-Agent': UA, ...headers }, body });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

async function must(url, opts, what) {
  const { status, body } = await req(url, opts);
  if (status !== 200) {
    throw new Error(`${what} -> ${status}: ${body.toString('utf8').slice(0, 300)}`);
  }
  return body;
}

/** {width, height} from a JPEG or PNG buffer. */
export function imageSize(buf) {
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG or PNG');
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('JPEG size not found');
}

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const len32 = (b) => Buffer.concat([u32(b.length), b]);

/**
 * Mask wire format.
 *
 * LAYOUT is verified: row-major runs of big-endian uint16 covering the whole
 * image (sum of counts must equal width*height, else the server 422s):
 *   v > 0x7fff -> (v - 0x7fff) pixels, high-bit runs
 *   v <= 0x7fff -> v pixels, plain runs
 *
 * POLARITY is the one soft spot. The default follows the app's own decoder
 * (`services/I` H() treats a high-bit run as a set pixel, and the set pixels
 * are the brush/segment area), i.e. `isMarked` -> high-bit run. My A/B probe
 * on a flat synthetic gradient came back inconsistent depending on mask size,
 * so if your erase region comes out inverted, pass `{ invert: true }`.
 */
export function rleEncode(width, height, isMarked = () => false, { invert = false } = {}) {
  const out = [];
  const emit = (count, marked) => {
    const high = invert ? !marked : marked;
    for (let n = count; n > 0;) {
      const k = Math.min(n, 0x7fff);
      out.push(u16(high ? 0x7fff + k : k));
      n -= k;
    }
  };
  for (let y = 0; y < height; y++) {
    let marked = null;
    let start = 0;
    for (let x = 0; x < width; x++) {
      const m = !!isMarked(x, y);
      if (marked === null) marked = m;
      else if (m !== marked) { emit(x - start, marked); start = x; marked = m; }
    }
    if (marked !== null) emit(width - start, marked);
  }
  return Buffer.concat(out);
}

/** Convenience mask: one rectangle is the marked (erase/replace) region. */
export function rleRect(width, height, [x1, y1, x2, y2], opts) {
  return rleEncode(width, height, (x, y) => x >= x1 && x < x2 && y >= y1 && y < y2, opts);
}

/** -> Buffer of 0/255, one byte per pixel; 255 marks the region. */
export function rleDecode(buf, width, height) {
  const out = Buffer.alloc(width * height);
  let o = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = buf.readUInt16BE(i);
    const n = v > 0x7fff ? v - 0x7fff : v;
    out.fill(v > 0x7fff ? 255 : 0, o, o + n);
    o += n;
  }
  return out;
}

/** Multi-image responses: repeated [u32be len][bytes]. */
export function unpackImages(buf, skip = 0) {
  const out = [];
  let o = skip;
  while (o + 4 <= buf.length) {
    const n = buf.readUInt32BE(o);
    o += 4;
    out.push(buf.subarray(o, o + n));
    o += n;
  }
  return out;
}

export class MagicEraser {
  /**
   * @param {object} [opts]
   * @param {string} [opts.token]      reuse an existing access_token, skip login
   * @param {string} [opts.debugToken] integrity token for the debug issuer
   * @param {string} [opts.authUrl]    override the issuer
   */
  constructor({ token, debugToken = DEBUG_TOKEN, authUrl = AUTH_DEV } = {}) {
    this.token = token ?? null;
    this.debugToken = debugToken;
    this.authUrl = authUrl;
    this.lastImageId = null; // set by removeBg()
    this._login = null;
  }

  /** Idempotent; called automatically by every method. */
  async login() {
    if (this.token) return this.token;
    if (!this._login) {
      this._login = (async () => {
        const body = await must(this.authUrl, {
          body: '{}',
          headers: { Authorization: `Bearer ${this.debugToken}`, 'X-Platform': 'android', 'Content-Type': 'application/json' },
        }, 'login');
        const token = JSON.parse(body.toString('utf8')).access_token;
        if (!token) throw new Error('login: no access_token in response');
        return (this.token = token);
      })();
    }
    return this._login;
  }

  async _h() {
    return { Authorization: `Bearer ${await this.login()}`, 'X-Platform': 'android' };
  }

  async _bin() {
    return { ...(await this._h()), 'Content-Type': 'application/octet-stream' };
  }

  // ---- gateway pipeline: upload once, act on the returned 16-byte image id ----

  /** @returns {Buffer} 16-byte image id. */
  async upload(jpeg) {
    const { width, height } = imageSize(jpeg);
    const body = Buffer.concat([u16(height), u16(width), jpeg]);
    const id = await must(`${GATEWAY}/upload_v6`, {
      body, headers: { ...(await this._h()), 'Content-Type': 'image/jpeg' },
    }, 'upload');
    if (id.length !== 16) throw new Error(`upload: expected 16-byte id, got ${id.length}`);
    return (this.lastImageId = id);
  }

  /**
   * Tap/brush point segmentation. points = [[x, y], ...]
   * @returns {Buffer} RLE mask — feed it straight to inpaint(). Polarity of a
   * server-produced mask is NOT asserted here; see README.
   */
  async segmentPoints(jpeg, points) {
    const id = await this.upload(jpeg);
    const pts = Buffer.alloc(points.length * 4);
    points.forEach(([x, y], i) => { pts.writeUInt16BE(y, i * 4); pts.writeUInt16BE(x, i * 4 + 2); });
    return must(`${GATEWAY}/segment_v6`, { body: Buffer.concat([id, pts]), headers: await this._bin() }, 'segment');
  }

  /** Text-prompt segmentation ("car", "person", …) -> RLE mask. */
  async segmentText(jpeg, prompt) {
    const id = await this.upload(jpeg);
    return must(`${GATEWAY}/segment_v6?prompt=${encodeURIComponent(prompt)}`,
      { body: id, headers: await this._bin() }, 'segment');
  }

  /** Erase/retouch. mask = RLE (see rleRect). @returns {Buffer[]} JPEGs. */
  async inpaint(jpeg, mask, { pro = false, safety = 'strict' } = {}) {
    const id = await this.upload(jpeg);
    const ep = pro ? 'inpaint_pro_v7' : 'inpaint_v7';
    const res = await must(`${GATEWAY}/${ep}?safety=${safety}`,
      { body: Buffer.concat([id, mask]), headers: await this._bin() }, 'inpaint');
    return unpackImages(res, 16);
  }

  /** @returns {Buffer} upscaled JPEG. */
  async upscale(jpeg, targetWidth, targetHeight) {
    return must(`${GATEWAY}/upscale_v6?for_inpainting=true&target_width=${targetWidth}&target_height=${targetHeight}`,
      { body: jpeg, headers: await this._bin() }, 'upscale');
  }

  // ---- background ----

  /**
   * Server returns a matte (grayscale JPEG), not an alpha cutout — the app
   * converts it on-device with a native call. id is kept on `me.lastImageId`.
   * @returns {Buffer} matte JPEG.
   */
  async removeBg(jpeg, { userType = 'free' } = {}) {
    const { width, height } = imageSize(jpeg);
    // NB: this upload interleaves the bytes (h>>8, w>>8, h&255, w&255) — the
    // app really does this and the server really does require it.
    const head = Buffer.from([height >> 8, width >> 8, height & 255, width & 255]);
    const res = await must(`${REMBG}/remove_background_v1?user_type=${userType}`,
      { body: Buffer.concat([head, jpeg]), headers: await this._bin() }, 'removeBg');
    this.lastImageId = res.subarray(0, 16);
    return res.subarray(16);
  }

  /** needs the id from removeBg() (or any apirembg upload). */
  async refineMask(imageId, jpeg, baseMask, strokeMask, { userType = 'free' } = {}) {
    const body = Buffer.concat([imageId, len32(jpeg), len32(baseMask), len32(strokeMask)]);
    return must(`${REMBG}/refine_mask_v1?user_type=${userType}`,
      { body, headers: await this._bin() }, 'refineMask');
  }

  // ---- generative ----

  /** Generative expand/uncrop. @returns {Buffer[]} */
  async expand(jpeg, mask, { numImages = 1 } = {}) {
    const res = await must(`${EXPAND}/expand_v1?num_images=${numImages}`,
      { body: Buffer.concat([len32(jpeg), len32(mask)]), headers: await this._bin() }, 'expand');
    return unpackImages(res);
  }

  /** Replace the masked area with `prompt`. @returns {Buffer[]} */
  async replace(jpeg, mask, prompt, { numImages = 1, safety = 'strict' } = {}) {
    const url = `${REPLACE}/replace_v1?num_images=${numImages}&prompt=${encodeURIComponent(prompt)}&safety=${safety}`;
    const res = await must(url, { body: Buffer.concat([len32(jpeg), len32(mask)]), headers: await this._bin() }, 'replace');
    return unpackImages(res);
  }

  /** Generate a new background behind the masked subject. @returns {Buffer[]} */
  async generateBackground(jpeg, mask, prompt, { numImages = 1 } = {}) {
    const url = `${GENBG}/generate_background_v1?num_images=${numImages}&prompt=${encodeURIComponent(prompt)}`;
    const res = await must(url, { body: Buffer.concat([len32(jpeg), len32(mask)]), headers: await this._bin() }, 'generateBackground');
    return unpackImages(res);
  }

  /** Text-to-image. size must be an enumerated value (e.g. "1024x1024"). @returns {Buffer} JPEG. */
  async imagen(prompt, { size = '1024x1024', style = '', version = 'flux', negativePrompt = '' } = {}) {
    const q = new URLSearchParams({ prompt, size, style, version, negative_prompt: negativePrompt });
    return must(`${IMAGEN}/imagen_v1?${q}`, { body: '', headers: await this._bin() }, 'imagen');
  }

  // ---- enhancement (separate upload) ----

  /** @returns {Buffer} upscaled (+ optionally face/color enhanced) JPEG. */
  async enhance(jpeg, { x4 = false, enhanceFace = false, enhanceColor = false } = {}) {
    const { width, height } = imageSize(jpeg);
    const id = await must(`${ENHANCE}/upload_v6`, {
      body: Buffer.concat([u16(height), u16(width), jpeg]),
      headers: { ...(await this._h()), 'Content-Type': 'image/jpeg' },
    }, 'enhance/upload');
    const ep = x4 ? 'upscale_x4_v6' : 'upscale_x2_v6';
    return must(`${ENHANCE}/${ep}?enhance_face=${enhanceFace}&enhance_color=${enhanceColor}`,
      { body: id, headers: await this._bin() }, 'enhance');
  }

  // ---- misc ----

  /** AI look transfer. See flashTemplates(). @returns {Buffer} JPEG. */
  async flash(jpeg, styleId = 'rosy_haze') {
    const form = new FormData();
    form.append('style_id', styleId);
    form.append('image', new Blob([jpeg], { type: 'image/jpeg' }), 'image.jpg');
    return must(`${FLASH}/v1/flash`, { body: form, headers: await this._h() }, 'flash');
  }

  /** @returns {Promise<object[]>} 21 style templates. */
  async flashTemplates() {
    return JSON.parse((await must(`${FLASH}/v1/flash/templates`, { method: 'GET', headers: await this._h() }, 'flashTemplates')).toString('utf8'));
  }

  /** Monocular depth. Input must have long edge exactly 392 (server enforces it). @returns {Buffer} "DPT1". */
  async depth(jpeg) {
    const { width, height } = imageSize(jpeg);
    if (Math.max(width, height) !== 392) {
      throw new Error(`depth: needs long edge exactly 392, got ${width}x${height} — resize first`);
    }
    return must(`${DEPTH}/depth_v1`, {
      body: jpeg,
      headers: { ...(await this._h()), 'Content-Type': 'image/jpeg', Accept: 'application/vnd.relight.depth-u12+zlib', 'Accept-Encoding': 'identity' },
    }, 'depth');
  }

  /** @returns {Buffer} "RLA2" light map, or "RLM1" saliency mask. */
  async relight(jpeg, { saliency = false } = {}) {
    const [url, accept] = saliency
      ? [`${BODYTUNE}/v2/relight/analyze?mask=saliency`, 'application/vnd.magic-eraser.relight-mask.v1+binary']
      : [`${BODYTUNE}/v2/relight/analyze`, 'application/vnd.magic-eraser.relight.v2+binary'];
    return must(url, {
      body: jpeg,
      headers: { ...(await this._h()), 'Content-Type': 'image/jpeg', Accept: accept, 'Accept-Encoding': 'identity' },
    }, 'relight');
  }

  /** @returns {Buffer} "FEA1" (face) or "FJA1" (jawline) analysis blob. */
  async faceEdit(jpeg, { jawline = false } = {}) {
    const [accept, extra] = jawline
      ? ['application/vnd.magic-eraser.face-jawline.v1+binary', { 'X-Face-Jawline-Profile': 'magic-eraser-jaw118-skin256-f32-v1' }]
      : ['application/vnd.magic-eraser.face-edit.v1+binary', { 'X-Face-Profile': 'magic-eraser-face-core106-q13-v1' }];
    return must(`${BODYTUNE}/v1/face-edit/analyze`, {
      body: jpeg,
      headers: { ...(await this._h()), ...extra, 'Content-Type': 'image/jpeg', Accept: accept, 'Accept-Encoding': 'identity' },
    }, 'faceEdit');
  }
}

/** Unauthenticated quota read. feature: "ai-fill" | "ai-background". */
export async function quota(deviceId, feature = 'ai-fill') {
  const q = new URLSearchParams({ deviceId, feature });
  const { status, body } = await req(`${QUOTA}/getQuota?${q}`, { method: 'GET' });
  return { status, data: JSON.parse(body.toString('utf8')) };
}

export default MagicEraser;
