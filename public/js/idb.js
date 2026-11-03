// Tiny IndexedDB wrapper: the device key and the outbox of readings not yet accepted by the server.

const DB_NAME = "shipproof";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("keys");
      db.createObjectStore("outbox", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    tx.oncomplete = () => {
      db.close();
      resolve(request ? request.result : undefined);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const loadDeviceKey = () => run("keys", "readonly", (s) => s.get("device"));
export const saveDeviceKey = (value) => run("keys", "readwrite", (s) => s.put(value, "device"));
export const saveReading = (reading) =>
  run("outbox", "readwrite", (s) => s.put({ id: `${reading.parcelId}|${reading.ts}`, reading }));
export const deleteReadings = (ids) =>
  run("outbox", "readwrite", (s) => {
    for (const id of ids) s.delete(id);
  });
export const loadOutbox = async () => {
  const rows = await run("outbox", "readonly", (s) => s.getAll());
  return rows.sort((a, b) => a.reading.ts - b.reading.ts);
};
