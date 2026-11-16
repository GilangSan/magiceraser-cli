# magiceraser-cli

Client + CLI for the **Magic Eraser** Android app's HTTP API
(`com.duygiangdg.magiceraser` v3.3.35, versionCode 402), recovered by static
analysis and verified against the live backends.

Zero dependencies — Node's global `fetch`/`FormData`/`Blob` and `Buffer` only.

```js
import { MagicEraser } from 'magiceraser-cli';

const me = new MagicEraser();          // logs in on first use
const matte = await me.removeBg(jpeg);

const mask = await me.segmentText(jpeg, 'watermark');
const [fixed] = await me.inpaint(jpeg, mask);
```

```bash
npm i magiceraser-cli            # once published
magiceraser inpaint photo.jpg out.jpg --rect 96,96,200,150
magiceraser imagen out.jpg "a cat in a spacesuit"
magiceraser flash --list
```

## API

| Method | Returns |
|---|---|
| `upload(jpeg)` | 16-byte image id (also kept as `me.lastImageId`) |
| `segmentPoints(jpeg, [[x,y], …])` | RLE mask |
| `segmentText(jpeg, 'car')` | RLE mask |
| `inpaint(jpeg, mask, {pro, safety})` | `Buffer[]` of JPEGs |
| `upscale(jpeg, w, h)` | JPEG |
| `removeBg(jpeg, {userType})` | matte JPEG (id on `me.lastImageId`) |
| `refineMask(imageId, jpeg, baseMask, strokeMask)` | mask JPEG |
| `expand(jpeg, mask, {numImages})` | `Buffer[]` |
| `replace(jpeg, mask, prompt, {numImages, safety})` | `Buffer[]` |
| `generateBackground(jpeg, mask, prompt, {numImages})` | `Buffer[]` |
| `imagen(prompt, {size, style, version, negativePrompt})` | JPEG |
| `enhance(jpeg, {x4, enhanceFace, enhanceColor})` | JPEG |
| `flash(jpeg, styleId)` / `flashTemplates()` | JPEG / style list |
| `depth(jpeg)` | `DPT1` blob — input long edge must be exactly 392 |
| `relight(jpeg, {saliency})` | `RLA2` light map / `RLM1` saliency |
| `faceEdit(jpeg, {jawline})` | `FEA1` / `FJA1` blob |

Helpers: `imageSize(buf)`, `rleEncode(w, h, isMarked, opts)`, `rleRect(w, h, rect, opts)`,
`rleDecode(buf, w, h)`, `unpackImages(buf, skip)`, `quota(deviceId, feature)`.
Masks are `{ width, height }`-sized, one bit per pixel — see `rleEncode`'s comment.

## CLI

```
magiceraser --help
magiceraser info        in.jpg
magiceraser remove-bg   in.jpg out.bin
magiceraser segment     in.jpg out.bin --rect x1,y1,x2,y2 | --points x,y,x,y | --text car
magiceraser inpaint     in.jpg out.jpg --rect x1,y1,x2,y2 [--pro] [--safety strict]
magiceraser upscale     in.jpg out.jpg 1024 1024
magiceraser enhance     in.jpg out.jpg [--x4] [--face] [--color]
magiceraser flash       in.jpg out.jpg [--style rosy_haze] | --list
magiceraser imagen      out.jpg "prompt" [--size 1024x1024] [--style watercolor] [--version flux]
magiceraser expand      in.jpg out --rect x1,y1,x2,y2 [-n 2]
magiceraser replace     in.jpg out --rect x1,y1,x2,y2 --prompt "a red apple"
magiceraser genbg       in.jpg out --rect x1,y1,x2,y2 --prompt "beach sunset"
magiceraser depth       in.jpg out.bin        # long edge must be 392
magiceraser relight     in.jpg out.bin [--saliency]
magiceraser face        in.jpg out.bin [--jawline]
magiceraser quota       [deviceId] [feature]
```

`out` for the multi-image commands becomes `out-0.jpg`, `out-1.jpg`, …

## Auth

Prod (`auth.magiceraser.live`) demands a Play Integrity / App Check token in
`Authorization`. The **debug issuer** `auth-dev.magiceraser.live` still accepts
the literal string `android-debug-emulator` and mints a real 15-minute JWT that
every prod gateway accepts — that is what `new MagicEraser()` uses, so no
device, account or attestation is needed. Pass `{ token }` to reuse one.

## Verified behaviour worth knowing

- `removeBg()` returns a **matte**, not an alpha cutout — the app converts it
  on-device with a native call. Composite it yourself.
- Its upload header interleaves the bytes (`h>>8, w>>8, h&255, w&255`), while
  the gateway `upload_v6` uses `h,w` contiguous. Both are real; don't normalise.
- `user_type=free|pro` is a query param, not derived from the JWT, so the pro
  model path is reachable by asking for it.
- Multi-image responses are repeated `[u32be len][bytes]`.
- `inpaint` responses carry the new image id in the first 16 bytes.
- `depth` rejects anything whose long edge isn't exactly 392 (this client
  checks locally and says so instead of round-tripping a 422).
- `cutout-service.magiceraser.live` currently 502s
  `foreground_correction_unsupported` for synthetic input; it wants a real
  portrait. Not exposed as a method for that reason.
- `body-edit` (`apibodytune /v1/body-edit/{chest,necks}/analyze`) is **not**
  implemented: the 6-byte model-version framing before the JPEG was not fully
  reversed (`bArr[4]` = 3/2, `bArr[5]` = 0 are necessary but not sufficient).
- The mask RLE **layout** is verified; the **flag polarity** default follows the
  app's own decoder. My A/B probe on a flat synthetic gradient gave
  size-dependent, conflicting results, so if your region comes out inverted
  pass `{ invert: true }` to `rleEncode`/`rleRect`.

## Limits

Measured, not guessed — see the notes on how each was established.

**Quota (only two features are metered at all)**

`ai-fill` and `ai-background` are the only features with a counter. It lives in a
separate Cloud Function keyed on a client-supplied `deviceId`
(`Settings.Secure.ANDROID_ID`), and the counter is **3 per 7 days**:

```
POST /consumeQuota {"deviceId":"…","feature":"ai-fill"}
  #1 → {"remains":2,"limit":3,"periodDays":7,"expiresAt":"2026-11-23T…Z"}
  #3 → {"remains":0,…}
  #4 → 429 {"error":"quota_exceeded","retryAfter":"2026-11-23T…Z"}
GET  /consumeQuota → 405 method_not_allowed
GET  /getQuota?deviceId=…&feature=… → free read, any device id, no auth
```

`retryAfter` is the end of the 7-day window, not a short backoff.

This is **not** enforceable: no image endpoint carries a device identifier — every
feature call sends only `Authorization` + `X-Platform`, and `deviceId` appears
nowhere else in the app. The check is a local pre-flight in the client
(`e1.h().k(feature)` / the quota cache in `app_pref`). This library therefore
never calls `consumeQuota`; `quota()` is read-only, exposed only so you can
inspect the counter.

**HTTP rate limits**

None advertised and none observed: no `X-RateLimit-*` / `Retry-After` headers on
a 200 from the gateway (just Cloudflare's `cf-ray`, `cf-cache-status: DYNAMIC`),
and dozens of calls per host in one session never produced a 429. The app only
handles 429 for login and quota, which suggests it doesn't expect throttling on
the image endpoints either. Treat "no limit" as "no limit I could find", not a
guarantee — Cloudflare sits in front and can change that.

**Size / dimension limits (server-enforced unless noted)**

| Limit | Value | Source |
|---|---|---|
| Background removal input | 1–4096 px per side | `422 Image dimensions must be between 1 and 4096` |
| `depth_v1` input | long edge exactly 392 px | `422 Send upright RGB with long edge 392` |
| `depth_v1` response | ≤ 409,600 B | client check, `services/g0` |
| cutout response | ≤ 16 MB | client check, `services/g0` |
| face cutout response | ≤ 64 MB | client check, `face/u$a` |
| body-edit input | 20 B – 1,060,944 B | client check, `services/a0` |
| Gateway upload | ≤ 1280 px long edge (client-side) | app resizes via `S.j0` before `upload_v6` |
| Background-removal upload | ≤ 800 px long edge (client-side) | app resizes via `S.h0(bmp, 0x800)` |
| Calibration sizes | imagen only accepts enumerated `size` values | `400 Custom size is not supported` |

**Client timeouts** (what the app considers normal latency)

login / imagen / quota 15 s · body-edit 30 s · depth 60 s · cutout 150 s.
Everything else uses Volley's defaults. The library does not impose its own
timeout beyond `fetch`'s default — pass an `AbortSignal` if you need one.

## Self-check

```bash
python3 -c "from PIL import Image; im=Image.new('RGB',(256,256),(120,80,200)); im.save('t.jpg'); im.resize((392,392)).save('t392.jpg')"
node selfcheck.mjs t.jpg t392.jpg
```

Exercises every method against the live API. Last run: all green.

## Disclaimer

Unofficial and not affiliated with Creatix Technology Global Limited or Magic
Eraser. No vendor source was used — everything here comes from static analysis
of a publicly distributed APK plus requests the app itself makes, and is
published for interoperability and study.

The endpoints are third-party services that cost real GPU time to run and their
terms may prohibit this kind of access. Expect them to change at any time (the
debug issuer documented above is the most likely thing to be closed first). Use
it on your own content, at your own risk; the MIT licence disclaims all
warranties.
