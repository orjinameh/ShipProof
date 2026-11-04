// Host test harness: runs the real tag core (same files as the board) and talks over stdin/stdout.
// Extra test-only commands: "S ax ay az ms" feeds one sample at time ms; "N level" feeds a sound level; "E ms" emits a reading.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../shipproof_tag/tag_core.h"

static uint8_t stored[32]; static bool have = false;
void tag_store_key(const uint8_t* p) { memcpy(stored, p, 32); have = true; }
void tag_erase_key(void) { have = false; memset(stored, 0, 32); }

int main() {
  static TagState t; tag_reset(&t);
  char line[300], reply[200], out[320];
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\r\n")] = 0;
    if (line[0] == 'S' && line[1] == ' ') {
      int ax, ay, az; unsigned ms; sscanf(line + 2, "%d %d %d %u", &ax, &ay, &az, &ms);
      tag_feed(&t, ax, ay, az, ms); puts("OK");
    } else if (line[0] == 'N' && line[1] == ' ') {
      tag_feed_sound(&t, (uint8_t)atoi(line + 2)); puts("OK");
    } else if (line[0] == 'E' && line[1] == ' ') {
      int n = tag_emit(&t, (uint32_t)strtoul(line + 2, 0, 10), out, sizeof out);
      if (n < 0) puts("NOEMIT"); else puts(out);
    } else if (tag_command(&t, line, 0, reply, sizeof reply)) puts(reply);
    else puts("ERR unknown command");
    fflush(stdout);
  }
}
