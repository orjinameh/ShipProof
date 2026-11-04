/*
  ShipProof tag - Arduino Uno / Nano + MPU6050 (I2C: SDA=A4, SCL=A5, VCC=3.3V or 5V per your breakout, GND)

  What it does
   - Reads the MPU6050 accelerometer through its FIFO at 50 Hz, so no samples are lost while it is busy signing.
   - Every WINDOW_MS it picks the sample furthest from 1 g, signs it with ECDSA P-256 and prints one JSON line.
   - The private key lives only in EEPROM. The dock page loads it once, over USB, and never reads it back.

  Optional sound level: wire an analog sound-sensor module (KY-038 / MAX4466 style, AO pin) to A0 and set
  ENABLE_MIC to 1. The tag reports only how loud the loudest moment was, 0-100, since the last reading.
  It never stores or sends audio. The scale is relative to the quiet level measured at power-up, not calibrated dB.

  Every reading also carries "ff": the longest unbroken free fall in milliseconds (samples at or below 0.3 g,
  20 ms each). The server turns it into an estimated drop height.

  Needs the "micro-ecc" library by Kenneth MacKay (Arduino Library Manager). No other libraries.
  Serial: 115200 baud. Lines starting with "{" are signed readings, "#" lines are logs, anything else answers a command.
  Commands: T <unix seconds> | KEY <64 hex> | WIPE | PARCEL <label> | INFO
*/
#include <Wire.h>
#include <EEPROM.h>
#include "tag_core.h"

static const uint8_t MPU = 0x68;
static const uint32_t WINDOW_MS = 5000;
#define ENABLE_MIC 0                    // 1 = a sound-sensor module is wired to A0
static const int MIC_PIN = A0;
static const int KEY_ADDR = 0;          // magic byte, then 32 key bytes

static TagState tag;
static char line[96];
static uint8_t lineLen = 0;

void tag_store_key(const uint8_t priv[32]) { EEPROM.update(KEY_ADDR, 0xA5); for (int i = 0; i < 32; i++) EEPROM.update(KEY_ADDR + 1 + i, priv[i]); }
void tag_erase_key(void) { for (int i = 0; i < 33; i++) EEPROM.update(KEY_ADDR + i, 0xFF); }

static void wr(uint8_t reg, uint8_t val) { Wire.beginTransmission(MPU); Wire.write(reg); Wire.write(val); Wire.endTransmission(); }
static uint8_t rd8(uint8_t reg) { Wire.beginTransmission(MPU); Wire.write(reg); Wire.endTransmission(false); Wire.requestFrom(MPU, (uint8_t)1); return Wire.read(); }

static void resetFifo() { wr(0x6A, 0x44); wr(0x6A, 0x40); }   // reset, then enable

static bool imuStart() {
  Wire.begin();
  if (rd8(0x75) != 0x68) return false;          // WHO_AM_I
  wr(0x6B, 0x00);                                // wake
  wr(0x1A, 0x03);                                // low-pass about 44 Hz, 1 kHz internal rate
  wr(0x19, 19);                                  // 1000 / (1 + 19) = 50 Hz
  wr(0x1C, 0x10);                                // +-8 g: 4096 counts per g
  wr(0x23, 0x08);                                // accelerometer into the FIFO
  resetFifo();
  return true;
}

// Reads whatever the FIFO holds and feeds it to the tag. 6 bytes per sample (x, y, z, big endian).
static void drainFifo() {
  if (rd8(0x3A) & 0x10) { resetFifo(); return; } // overflow: the byte alignment is lost, start clean (a gap, not a wrong reading)
  Wire.beginTransmission(MPU); Wire.write(0x72); Wire.endTransmission(false); Wire.requestFrom(MPU, (uint8_t)2);
  uint16_t count = ((uint16_t)Wire.read() << 8) | Wire.read();
  uint32_t now = millis();
  while (count >= 6) {
    uint8_t n = count >= 30 ? 30 : (uint8_t)(count - count % 6);   // Wire buffers 32 bytes
    Wire.beginTransmission(MPU); Wire.write(0x74); Wire.endTransmission(false); Wire.requestFrom(MPU, n);
    for (uint8_t i = 0; i < n; i += 6) {
      int16_t x = (int16_t)((Wire.read() << 8) | Wire.read());
      int16_t y = (int16_t)((Wire.read() << 8) | Wire.read());
      int16_t z = (int16_t)((Wire.read() << 8) | Wire.read());
      // counts to milli-g: x * 1000 / 4096 = x * 125 / 512
      tag_feed(&tag, (int16_t)((int32_t)x * 125 / 512), (int16_t)((int32_t)y * 125 / 512), (int16_t)((int32_t)z * 125 / 512), now);
    }
    count -= n;
  }
}

#if ENABLE_MIC
static uint16_t micFloor = 0;   // quiet peak-to-peak, measured at power-up

// Peak-to-peak of the analog signal over about 20 ms (roughly 170 reads at 9 kHz). Amplitude only: nothing is kept.
static uint16_t micSpan() {
  uint16_t lo = 1023, hi = 0;
  uint32_t t0 = micros();
  while ((uint32_t)(micros() - t0) < 20000UL) { uint16_t v = analogRead(MIC_PIN); if (v < lo) lo = v; if (v > hi) hi = v; }
  return hi - lo;
}
static void micCalibrate() {                         // 1 s of whatever the room sounds like now
  uint32_t sum = 0; for (uint8_t i = 0; i < 50; i++) sum += micSpan();
  micFloor = sum / 50;
}
static void micSample() {
  uint16_t span = micSpan();
  int16_t above = (int16_t)span - (int16_t)micFloor;
  if (above <= 0) { tag_feed_sound(&tag, 0); return; }   // still tells the core a sensor is fitted
  int32_t level = (int32_t)above * 100 / 300;            // 300 counts above the quiet level = 100
  tag_feed_sound(&tag, level > 100 ? 100 : (uint8_t)level);
}
#endif

static void readSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[lineLen] = 0; lineLen = 0;
      if (!line[0]) continue;
      char reply[140];
      if (tag_command(&tag, line, millis(), reply, sizeof reply)) Serial.println(reply); else Serial.println(F("ERR unknown command"));
    } else if (lineLen < sizeof(line) - 1) line[lineLen++] = c;
    else lineLen = 0;                            // too long: drop it
  }
}

void setup() {
  Serial.begin(115200);
  tag_reset(&tag);
  if (EEPROM.read(KEY_ADDR) == 0xA5) { uint8_t k[32]; for (int i = 0; i < 32; i++) k[i] = EEPROM.read(KEY_ADDR + 1 + i); tag_set_key(&tag, k); memset(k, 0, 32); }
  bool ok = imuStart();
#if ENABLE_MIC
  micCalibrate();
#endif
  Serial.print(F("# shipproof-tag v2 imu=")); Serial.print(ok ? F("ok") : F("MISSING")); Serial.print(F(" key="));
  Serial.println(tag.haveKey ? tag.deviceId : "none");
}

void loop() {
  readSerial();
  if (!tag.haveKey || !tag.haveTime) { delay(5); return; }   // nothing to sign with, or no clock yet
  drainFifo();
#if ENABLE_MIC
  micSample();                                              // takes about 20 ms, so no extra delay below
#endif
  if (tag_window_due(&tag, millis(), WINDOW_MS)) {
    static char out[320];
    int n = tag_emit(&tag, millis(), out, sizeof out);      // signing blocks for a while; the FIFO keeps collecting
    if (n > 0) Serial.println(out);
  }
#if !ENABLE_MIC
  delay(20);
#endif
}
