# ShipProof tag firmware (Arduino Uno / Nano + MPU6050)

The tag signs every reading with its own key. The server checks the signature, so the computer or phone that carries the readings doesn't have to be trusted.

## Parts
- Arduino Uno or Nano (ATmega328P) and a USB cable
- MPU6050 breakout. Wiring: VCC to 5V (or 3.3V, depending on the breakout), GND to GND, SDA to A4, SCL to A5

## Put it on the board
1. Arduino IDE, Library Manager, install **micro-ecc** (by Kenneth MacKay).
2. Open `firmware/shipproof_tag/shipproof_tag.ino` (the other files in that folder open next to it).
3. Pick the board and port, then Upload.
4. Open the Serial Monitor at 115200 baud. A new tag prints `# shipproof-tag v2 imu=ok key=none`. If it says `imu=MISSING`, check the wiring.

## Set the tag up
1. Close the Serial Monitor (only one program can use the port).
2. Sign in to the console, open **Tags, Set up a hardware tag** (`/dock`), and press **Connect tag**. Use Chrome or Edge.
3. Press **Set up this tag**. The page makes a key, loads it into the tag, registers it and links it to your company, then forgets the key.
4. Leave the tag connected. A signed reading appears every 5 seconds and is sent to the server by the page.

## Serial commands (for debugging)
`T <unix seconds>`, `KEY <64 hex>`, `WIPE`, `PARCEL <label>`, `INFO`. Lines starting with `{` are signed readings.

## Test on a computer
The core (signing, windows, commands) has no hardware code, so it runs on a PC:
```
git clone https://github.com/kmackay/micro-ecc
UECC_DIR=$PWD/micro-ecc firmware/host/build.sh
npm test
```

## Known limits (be honest about these in the pitch)
- **Not compiled for the Arduino yet.** Only the hardware-free core has been built and tested, on a computer. Signing speed and RAM on the ATmega328P are unmeasured. If the sketch runs out of memory or signing is too slow, use an ESP32; the same files work.
- **No storage and no radio.** Readings go out over USB as they're made. If the dock is unplugged, that stretch has no evidence. Real trips need an SD card or a radio module.
- **No real-time clock.** The dock sets the time and the tag counts from it. Power loss means the time must be set again, and whoever sets it could set it wrong. An RTC or GPS fixes this.
- **The key sits in EEPROM, unprotected.** A secure chip such as the ATECC608 keeps it unreadable. This is the main upgrade for the funded version.
- **One reading per 5 seconds**: the sample furthest from 1 g in that window, flagged as a shock if any sample reached 2.5 g. The sensor keeps collecting while the chip signs (its FIFO holds about 3.4 s); a longer signing time would lose samples.


## Free-fall time and sound level (reading format v2)

- Every reading carries `ff`: the longest unbroken free fall in the window, in milliseconds (samples at or below 0.3 g, 20 ms each). The server turns it into an estimated drop height (h = g t^2 / 2, ignoring air drag), for example 500 ms is about 1.2 m.
- Optional sound level: wire an analog sound-sensor module (KY-038 or a MAX4466 board, AO pin) to A0, set `ENABLE_MIC` to 1 in `shipproof_tag.ino`, and re-upload. Readings then carry `snd` (0-100), the loudest moment since the last reading. Only a level is measured: no audio is stored or sent. The scale is relative to the quiet level measured at power-up (keep the tag still and quiet for the first second), not calibrated decibels.
- `ff` and `snd` are inside the signed bytes, so editing either after the fact makes the signature fail.
- Not yet tested on a real board: the microphone code, the AVR build, and signing time with the longer string.
