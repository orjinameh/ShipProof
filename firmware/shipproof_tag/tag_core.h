#pragma once
// ShipProof tag core: reading selection, canonical string, signing and the serial command set.
// No hardware calls in here, so the same code runs on the board and in the host test.
#include <stddef.h>
#include <stdint.h>

#define TAG_SHOCK_MG 2500       // a sample at or above 2.5 g in a window marks the reading as a shock
#define TAG_FREEFALL_MG 300     // a sample at or below 0.3 g counts as free fall
#define TAG_SAMPLE_MS 20        // 50 Hz
#define TAG_PARCEL_MAX 24

struct TagState {
  uint8_t priv[32];
  uint8_t pub[64];              // x || y, as micro-ecc wants it
  char deviceId[16];            // "ph-" + 12 hex chars, derived from the public key
  bool haveKey;
  bool haveTime;
  uint32_t unixBase;            // unix seconds at baseMs
  uint32_t baseMs;
  char parcel[TAG_PARCEL_MAX];  // a label only; the company assigns the real parcel
  // window of samples since the last reading
  uint16_t n;
  int16_t bax, bay, baz;        // the sample furthest from 1 g
  int32_t bestDev;
  uint8_t shock;
  uint32_t windowStartMs;
  uint16_t runSamples;          // current unbroken free-fall run
  uint16_t maxRunSamples;       // longest run in this window
  bool sndOn;                   // a sound sensor is fitted: readings carry a level
  uint8_t snd;                  // loudest level 0-100 since the last reading
};

// Provided by the board sketch (EEPROM) or the host test (a file).
void tag_store_key(const uint8_t priv[32]);
void tag_erase_key(void);

void tag_reset(TagState* t);
bool tag_set_key(TagState* t, const uint8_t priv[32]);
void tag_feed(TagState* t, int16_t ax, int16_t ay, int16_t az, uint32_t nowMs);
// Sound LEVEL only (0-100), never audio. Call whenever the sketch has measured one; ignored levels above 100 are clamped.
void tag_feed_sound(TagState* t, uint8_t level);
bool tag_window_due(const TagState* t, uint32_t nowMs, uint32_t windowMs);
// Signs the window and writes one JSON line (no newline). Returns the length, or -1 if there is nothing to send.
int tag_emit(TagState* t, uint32_t nowMs, char* out, size_t cap);
// Handles "T <unix>", "KEY <64 hex>", "WIPE", "PARCEL <label>", "INFO". Writes a one-line reply. Returns false on an unknown command.
bool tag_command(TagState* t, const char* line, uint32_t nowMs, char* reply, size_t cap);
size_t tag_base64(const uint8_t* in, size_t n, char* out);
