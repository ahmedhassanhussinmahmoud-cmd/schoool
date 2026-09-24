// db.js — IndexedDB helper
const DB_NAME = "school_db";
const DB_VERSION = 3;

const STORES = {
  meta: { keyPath: "key" },
  schools: { keyPath: "id", indexes: [["updated_at","updated_at"]] },
  profiles: { keyPath: "id" },
  students: {
    keyPath: "id",
    indexes: [
      ["school_id","school_id"],
      ["tracking_number","tracking_number"],
      ["class_id","class_id"],
      ["section_id","section_id"],
      ["status","status"]
    ]
  },
  teachers: { keyPath: "id", indexes: [["school_id","school_id"],["email","email"]] },
  classes: { keyPath: "id", indexes: [["school_id","school_id"]] },
  sections: { keyPath: "id", indexes: [["school_id","school_id"],["class_id","class_id"]] },
  subjects: { keyPath: "id", indexes: [["school_id","school_id"]] },
  teacher_assignments: { keyPath: "id", indexes: [["teacher_id","teacher_id"],["school_id","school_id"]] },
  schedules: { keyPath: "id", indexes: [["school_id","school_id"],["teacher_id","teacher_id"]] },
  attendance: { keyPath: "id", indexes: [["school_id","school_id"],["student_id","student_id"],["date","date"]] },
  grades: { keyPath: "id", indexes: [["school_id","school_id"],["student_id","student_id"],["subject_id","subject_id"]] },
  homework: { keyPath: "id", indexes: [["school_id","school_id"],["student_id","student_id"]] },
  behavior_notes: { keyPath: "id", indexes: [["school_id","school_id"],["student_id","student_id"]] },
  announcements: { keyPath: "id", indexes: [["school_id","school_id"],["date","date"]] },
  school_files: { keyPath: "id", indexes: [["school_id","school_id"],["category","category"]] },
  parent_cache: { keyPath: "cache_key", indexes: [["school_id","school_id"],["student_id","student_id"]] },
  parent_notes: { keyPath: "id", indexes: [["school_id","school_id"],["student_id","student_id"],["date","date"]] },
  sync_queue: { keyPath: "operation_id", indexes: [["sync_status","sync_status"],["created_at","created_at"]] }
};

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const [name, cfg] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
          (cfg.indexes || []).forEach(([iname, path]) => store.createIndex(iname, path));
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode) {
  return openDB().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

const idb = {
  async get(store, key) {
    const s = await tx(store, "readonly");
    return new Promise((res, rej) => {
      const r = s.get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async put(store, value) {
    const s = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = s.put(value);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async bulkPut(store, values) {
    if (!values || !values.length) return 0;
    const s = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      let n = 0;
      values.forEach(v => {
        const r = s.put(v);
        r.onsuccess = () => { n++; if (n === values.length) res(n); };
        r.onerror = () => rej(r.error);
      });
    });
  },
  async delete(store, key) {
    const s = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = s.delete(key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
  async clear(store) {
    const s = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = s.clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
  async getAll(store) {
    const s = await tx(store, "readonly");
    return new Promise((res, rej) => {
      const r = s.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async getAllByIndex(store, indexName, key) {
    const s = await tx(store, "readonly");
    const idx = s.index(indexName);
    return new Promise((res, rej) => {
      const r = idx.getAll(key);
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async count(store) {
    const s = await tx(store, "readonly");
    return new Promise((res, rej) => {
      const r = s.count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
};

const metaStore = {
  async set(key, value) { return idb.put("meta", { key, value }); },
  async get(key) {
    const r = await idb.get("meta", key);
    return r ? r.value : null;
  },
  async del(key) { return idb.delete("meta", key); }
};

export { idb, metaStore, STORES };