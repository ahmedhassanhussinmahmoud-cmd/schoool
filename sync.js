// sync.js — مزامنة Offline/Online
import { idb } from "./db.js";
import { CLOUD_TABLES, cloudFetchAll, cloudFetchSchoolsById, cloudUpsert, cloudDelete, checkIdempotency, recordIdempotency } from "./supabase.js";

const MAX_RETRIES = 5;
let syncing = false;
const listeners = { status: [], data: [] };

function on(evt, fn) { listeners[evt].push(fn); }
function emit(evt, payload) { listeners[evt].forEach(f => { try { f(payload); } catch (e) { console.error(e); } }); }

function isOnline() { return navigator.onLine; }

async function enqueue(operation) {
  const op = {
    operation_id: crypto.randomUUID(),
    entity: operation.entity,
    record_id: operation.record_id,
    operation_type: operation.operation_type,
    payload: operation.payload || null,
    school_id: operation.school_id,
    created_at: Date.now(),
    updated_at: Date.now(),
    sync_status: "pending",
    retry_count: 0
  };
  await idb.put("sync_queue", op);
  emit("status", { pending: true });
  if (isOnline()) queueMicrotask(() => syncNow());
  return op;
}

async function getAllPending() {
  const all = await idb.getAll("sync_queue");
  return all.filter(o => o.sync_status === "pending" || o.sync_status === "retry")
            .sort((a, b) => a.created_at - b.created_at);
}

async function syncNow() {
  if (syncing) return;
  if (!isOnline()) return;
  syncing = true;
  emit("status", { syncing: true });
  try {
    const pending = await getAllPending();
    for (const op of pending) {
      try {
        const already = await checkIdempotency(op.operation_id).catch(() => false);
        if (already) {
          op.sync_status = "synced";
          op.updated_at = Date.now();
          await idb.put("sync_queue", op);
          continue;
        }
        if (op.operation_type === "delete") {
          await cloudDelete(op.entity, op.record_id);
        } else {
          await cloudUpsert(op.entity, op.payload);
        }
        await recordIdempotency(op.operation_id, op.school_id, op.entity, op.record_id).catch(() => {});
        op.sync_status = "synced";
        op.updated_at = Date.now();
        await idb.put("sync_queue", op);
      } catch (err) {
        console.warn("sync op failed", op.operation_id, err);
        op.retry_count = (op.retry_count || 0) + 1;
        op.updated_at = Date.now();
        op.sync_status = op.retry_count >= MAX_RETRIES ? "failed" : "retry";
        await idb.put("sync_queue", op);
      }
    }
  } finally {
    syncing = false;
    emit("status", { syncing: false });
  }
}

async function refreshFromCloud(schoolId) {
  if (!isOnline() || !schoolId) return;
  emit("status", { syncing: true });
  try {
    for (const table of CLOUD_TABLES) {
      if (table === "schools") continue;
      try {
        const rows = await cloudFetchAll(schoolId, table);
        await idb.bulkPut(table, rows);
      } catch (e) {
        console.warn("fetch failed", table, e.message);
      }
    }
    try {
      const school = await cloudFetchSchoolsById(schoolId);
      if (school) await idb.put("schools", school);
    } catch (e) { console.warn("school fetch failed", e.message); }
    emit("data", { refreshed: true });
  } finally {
    emit("status", { syncing: false });
  }
}

function startWatchers(getSchoolId) {
  window.addEventListener("online", async () => {
    emit("status", { online: true });
    await syncNow();
    const sid = await getSchoolId();
    if (sid) await refreshFromCloud(sid);
  });
  window.addEventListener("offline", () => emit("status", { online: false }));
  setInterval(async () => {
    if (!isOnline()) return;
    await syncNow();
    const sid = await getSchoolId();
    if (sid) await refreshFromCloud(sid);
  }, 45000);
  if (isOnline()) {
    getSchoolId().then(sid => { if (sid) refreshFromCloud(sid); });
  }
}

export { enqueue, syncNow, refreshFromCloud, startWatchers, isOnline, on };