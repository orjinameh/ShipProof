#include "tag_core.h"
#include "sha256.h"
#include <string.h>
#include <uECC.h>

// ---------- small helpers (no printf, no floats: identical output on every platform) ----------

static size_t put_u(char* out, uint32_t v) {
  char tmp[11]; size_t n = 0;
  do { tmp[n++] = '0' + (v % 10); v /= 10; } while (v);
  for (size_t i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
  return n;
}
static size_t put_i(char* out, int32_t v) {
  if (v < 0) { out[0] = '-'; return 1 + put_u(out + 1, (uint32_t)(-(int64_t)v)); }
  return put_u(out, (uint32_t)v);
}
static size_t put_s(char* out, const char* s) { size_t n = strlen(s); memcpy(out, s, n); return n; }

size_t tag_base64(const uint8_t* in, size_t n, char* out) {
  static const char A[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < n) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < n) v |= in[i + 2];
    out[o++] = A[(v >> 18) & 63]; out[o++] = A[(v >> 12) & 63];
    out[o++] = i + 1 < n ? A[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? A[v & 63] : '=';
  }
  out[o] = 0;
  return o;
}

static int hexval(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }

// ---------- deterministic ECDSA (RFC 6979 via micro-ecc): no random number generator needed to sign ----------

// micro-ecc builds the HMAC itself; it only needs a plain SHA-256 from us.
struct HashCtx { uECC_HashContext uecc; Sha256 sha; };
static void h_init(const uECC_HashContext* ctx) { sha256_init(&((HashCtx*)ctx)->sha); }
static void h_update(const uECC_HashContext* ctx, const uint8_t* msg, unsigned n) { sha256_update(&((HashCtx*)ctx)->sha, msg, n); }
static void h_finish(const uECC_HashContext* ctx, uint8_t* out) { sha256_final(&((HashCtx*)ctx)->sha, out); }

static bool sign_hash(const uint8_t priv[32], const uint8_t hash[32], uint8_t sig[64]) {
  HashCtx c;
  static uint8_t tmp[128];  // 2 * result_size + block_size
  c.uecc.init_hash = h_init; c.uecc.update_hash = h_update; c.uecc.finish_hash = h_finish;
  c.uecc.block_size = 64; c.uecc.result_size = 32; c.uecc.tmp = tmp;
  return uECC_sign_deterministic(priv, hash, 32, &c.uecc, sig, uECC_secp256r1()) == 1;
}

// ---------- state ----------

void tag_reset(TagState* t) {
  memset(t, 0, sizeof *t);
  strcpy(t->parcel, "tag");
}

bool tag_set_key(TagState* t, const uint8_t priv[32]) {
  uint8_t pub[64];
  if (!uECC_compute_public_key(priv, pub, uECC_secp256r1())) return false;
  memcpy(t->priv, priv, 32); memcpy(t->pub, pub, 64);
  uint8_t raw[65], h[32];
  raw[0] = 0x04; memcpy(raw + 1, pub, 64);
  sha256_once(raw, 65, h);
  static const char X[] = "0123456789abcdef";
  strcpy(t->deviceId, "ph-");
  for (int i = 0; i < 6; i++) { t->deviceId[3 + 2*i] = X[h[i] >> 4]; t->deviceId[4 + 2*i] = X[h[i] & 15]; }
  t->deviceId[15] = 0;
  t->haveKey = true;
  return true;
}

static uint32_t isqrt(uint32_t x) { uint32_t r = 0, b = 1UL << 30; while (b > x) b >>= 2; while (b) { if (x >= r + b) { x -= r + b; r = (r >> 1) + b; } else r >>= 1; b >>= 2; } return r; }

void tag_feed(TagState* t, int16_t ax, int16_t ay, int16_t az, uint32_t nowMs) {
  if (t->n == 0) { t->windowStartMs = nowMs; t->bestDev = -1; t->shock = 0; t->maxRunSamples = t->runSamples; }
  int32_t mag = (int32_t)isqrt((uint32_t)((int32_t)ax * ax + (int32_t)ay * ay + (int32_t)az * az));
  int32_t dev = mag > 1000 ? mag - 1000 : 1000 - mag;
  if (dev > t->bestDev) { t->bestDev = dev; t->bax = ax; t->bay = ay; t->baz = az; }
  if (mag >= TAG_SHOCK_MG) t->shock = 1;
  if (mag <= TAG_FREEFALL_MG) { if (t->runSamples < 65535) t->runSamples++; if (t->runSamples > t->maxRunSamples) t->maxRunSamples = t->runSamples; }
  else t->runSamples = 0;
  if (t->n < 65535) t->n++;
}

void tag_feed_sound(TagState* t, uint8_t level) {
  if (level > 100) level = 100;
  t->sndOn = true;
  if (level > t->snd) t->snd = level;
}

bool tag_window_due(const TagState* t, uint32_t nowMs, uint32_t windowMs) { return t->n > 0 && (uint32_t)(nowMs - t->windowStartMs) >= windowMs; }

int tag_emit(TagState* t, uint32_t nowMs, char* out, size_t cap) {
  if (!t->haveKey || !t->haveTime || t->n == 0 || cap < 300) return -1;
  uint32_t ts = t->unixBase + (uint32_t)(nowMs - t->baseMs) / 1000;
  char canon[140]; size_t c = 0;
  c += put_s(canon + c, "v2|"); c += put_s(canon + c, t->deviceId); canon[c++] = '|';
  c += put_s(canon + c, t->parcel); canon[c++] = '|';
  c += put_u(canon + c, ts); canon[c++] = '|';
  c += put_i(canon + c, t->bax); canon[c++] = '|'; c += put_i(canon + c, t->bay); canon[c++] = '|'; c += put_i(canon + c, t->baz); canon[c++] = '|';
  c += put_u(canon + c, t->shock); c += put_s(canon + c, "||");   // no GPS: latE6 and lonE6 are empty
  uint32_t ff = (uint32_t)t->maxRunSamples * TAG_SAMPLE_MS; if (ff > 60000) ff = 60000;
  canon[c++] = '|'; if (t->sndOn) c += put_u(canon + c, t->snd);
  canon[c++] = '|'; c += put_u(canon + c, ff);
  canon[c] = 0;
  uint8_t hash[32], sig[64];
  sha256_once((const uint8_t*)canon, c, hash);
  if (!sign_hash(t->priv, hash, sig)) return -1;
  size_t o = 0;
  o += put_s(out + o, "{\"v\":2,\"deviceId\":\""); o += put_s(out + o, t->deviceId);
  o += put_s(out + o, "\",\"parcelId\":\""); o += put_s(out + o, t->parcel);
  o += put_s(out + o, "\",\"ts\":"); o += put_u(out + o, ts);
  o += put_s(out + o, ",\"ax\":"); o += put_i(out + o, t->bax);
  o += put_s(out + o, ",\"ay\":"); o += put_i(out + o, t->bay);
  o += put_s(out + o, ",\"az\":"); o += put_i(out + o, t->baz);
  o += put_s(out + o, ",\"shock\":"); o += put_u(out + o, t->shock);
  if (t->sndOn) { o += put_s(out + o, ",\"snd\":"); o += put_u(out + o, t->snd); }
  o += put_s(out + o, ",\"ff\":"); o += put_u(out + o, ff);
  o += put_s(out + o, ",\"sig\":\""); o += tag_base64(sig, 64, out + o);
  o += put_s(out + o, "\"}");
  out[o] = 0;
  t->n = 0;   // next window starts with the next sample
  t->snd = 0;
  // a fall still in progress carries over, so a drop spanning two windows is not cut in half
  return (int)o;
}

static void say(char* reply, size_t cap, const char* a, const char* b = "") {
  size_t n = strlen(a); if (n >= cap) n = cap - 1;
  memcpy(reply, a, n);
  size_t m = strlen(b); if (n + m >= cap) m = cap - 1 - n;
  memcpy(reply + n, b, m); reply[n + m] = 0;
}

bool tag_command(TagState* t, const char* line, uint32_t nowMs, char* reply, size_t cap) {
  if (strncmp(line, "T ", 2) == 0) {
    uint32_t v = 0; const char* p = line + 2;
    if (!*p) { say(reply, cap, "ERR time"); return true; }
    for (; *p; p++) { if (*p < '0' || *p > '9' || v > 429496728UL) { say(reply, cap, "ERR time"); return true; } v = v * 10 + (*p - '0'); }
    if (v < 1700000000UL) { say(reply, cap, "ERR time"); return true; }   // before Nov 2023 is a wrong clock
    t->unixBase = v; t->baseMs = nowMs; t->haveTime = true;
    say(reply, cap, "OK"); return true;
  }
  if (strncmp(line, "KEY ", 4) == 0) {
    if (t->haveKey) { say(reply, cap, "ERR key already set. Send WIPE first."); return true; }
    uint8_t d[32]; const char* p = line + 4;
    if (strlen(p) != 64) { say(reply, cap, "ERR key length"); return true; }
    for (int i = 0; i < 32; i++) { int a = hexval(p[2*i]), b = hexval(p[2*i + 1]); if (a < 0 || b < 0) { say(reply, cap, "ERR key hex"); return true; } d[i] = (uint8_t)(a * 16 + b); }
    if (!tag_set_key(t, d)) { say(reply, cap, "ERR key invalid"); return true; }
    tag_store_key(d);
    memset(d, 0, 32);
    uint8_t raw[65]; raw[0] = 0x04; memcpy(raw + 1, t->pub, 64);
    char b64[100]; tag_base64(raw, 65, b64);
    say(reply, cap, "PUB ", b64);
    return true;
  }
  if (strcmp(line, "WIPE") == 0) {
    memset(t->priv, 0, 32); memset(t->pub, 0, 64); t->deviceId[0] = 0; t->haveKey = false; t->n = 0;
    tag_erase_key();
    say(reply, cap, "OK"); return true;
  }
  if (strcmp(line, "INFO") == 0) {
    if (!t->haveKey) { say(reply, cap, "INFO nokey"); return true; }
    uint8_t raw[65]; raw[0] = 0x04; memcpy(raw + 1, t->pub, 64);
    char b64[100]; tag_base64(raw, 65, b64);
    char msg[130]; size_t o = 0; o += put_s(msg + o, t->deviceId); msg[o++] = ' '; o += put_s(msg + o, t->haveTime ? "time" : "notime"); msg[o++] = ' '; o += put_s(msg + o, b64); msg[o] = 0;
    say(reply, cap, "INFO ", msg); return true;
  }
  if (strncmp(line, "PARCEL ", 7) == 0) {
    const char* p = line + 7; size_t n = strlen(p);
    if (n < 1 || n >= TAG_PARCEL_MAX) { say(reply, cap, "ERR label"); return true; }
    for (size_t i = 0; i < n; i++) { char ch = p[i]; if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '-' || ch == '_')) { say(reply, cap, "ERR label"); return true; } }
    strcpy(t->parcel, p); say(reply, cap, "OK"); return true;
  }
  return false;
}
