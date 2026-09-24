// supabase.js — عميل Supabase + كل عمليات السيرفر
const SUPABASE_URL = "https://ectyuhiueznogwvgnefj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_M09mgns32PNUKKIDGHkGbg_8413NkwXsb_publishable_M09mgns32PNUKKIDGHkGbg_8413NkwX";

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error("Supabase library not loaded");
  }
  _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  return _client;
}

const CLOUD_TABLES = [
  "schools","profiles","students","teachers","classes","sections","subjects",
  "teacher_assignments","schedules","attendance","grades","homework","behavior_notes","announcements",
  "parent_notes"
];

async function cloudFetchAll(schoolId, table) {
  const client = getClient();
  const { data, error } = await client.from(table).select("*").eq("school_id", schoolId);
  if (error) throw error;
  return data || [];
}

async function cloudFetchSchoolsById(schoolId) {
  const client = getClient();
  const { data, error } = await client.from("schools").select("*").eq("id", schoolId).maybeSingle();
  if (error) throw error;
  return data;
}

async function cloudUpsert(table, row) {
  const client = getClient();
  const { data, error } = await client.from(table).upsert(row, { onConflict: "id" }).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function cloudDelete(table, id) {
  const client = getClient();
  const { error } = await client.from(table).delete().eq("id", id);
  if (error) throw error;
}

async function recordIdempotency(operationId, schoolId, entity, recordId) {
  const client = getClient();
  const { error } = await client.from("sync_idempotency").insert({
    operation_id: operationId, school_id: schoolId, entity, record_id: recordId
  });
  if (error && error.code !== "23505") {
    console.warn("idempotency warn", error.message);
  }
}

async function checkIdempotency(operationId) {
  const client = getClient();
  const { data } = await client.from("sync_idempotency").select("operation_id").eq("operation_id", operationId).maybeSingle();
  return !!data;
}

async function parentLookup(tracking, name) {
  const client = getClient();
  const { data, error } = await client.rpc("parent_get_data", { p_tracking: tracking, p_name: name });
  if (error) throw error;
  return data;
}

async function callDeleteSchoolData(confirmText, alsoDeleteTeachers = true) {
  const client = getClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error("No session");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-school-data`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ confirm: confirmText, also_delete_teachers: alsoDeleteTeachers })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `فشل الحذف (${res.status})`);
  return data;
}

async function callCreateTeacherAccount(payload) {
  const client = getClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error("No session");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/create-teacher-account`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `فشل الإنشاء (${res.status})`);
  return data;
}

async function callResetTeacherPassword(teacherId, newPassword) {
  const client = getClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error("No session");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-reset-teacher-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ teacher_id: teacherId, new_password: newPassword })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `فشل التعيين (${res.status})`);
  return data;
}

async function callLoginWithUsername(username, password) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/login-with-username`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `فشل الدخول (${res.status})`);
  return data;
}

async function storageUploadFile(schoolId, category, fileOrBlob, filename, contentType) {
  const client = getClient();
  const ext = (filename.split(".").pop() || "bin").toLowerCase();
  const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const path = `${schoolId}/${category}/${safeName}`;
  const { error } = await client.storage
    .from("school-assets")
    .upload(path, fileOrBlob, {
      contentType: contentType || fileOrBlob.type || "application/octet-stream",
      upsert: false
    });
  if (error) throw new Error(error.message);
  return path;
}

async function storageGetSignedUrl(path, expiresIn = 3600) {
  const client = getClient();
  const { data, error } = await client.storage
    .from("school-assets")
    .createSignedUrl(path, expiresIn);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

async function storageDeleteFile(path) {
  const client = getClient();
  const { error } = await client.storage.from("school-assets").remove([path]);
  if (error) throw new Error(error.message);
  return true;
}

async function storageListFiles(schoolId, category) {
  const client = getClient();
  const { data, error } = await client.storage
    .from("school-assets")
    .list(`${schoolId}/${category}`, { limit: 200, sortBy: { column: "name", order: "desc" } });
  if (error) throw new Error(error.message);
  return data || [];
}

export {
  getClient, CLOUD_TABLES,
  cloudFetchAll, cloudFetchSchoolsById, cloudUpsert, cloudDelete,
  recordIdempotency, checkIdempotency,
  parentLookup, callDeleteSchoolData,
  callCreateTeacherAccount, callResetTeacherPassword, callLoginWithUsername,
  storageUploadFile, storageGetSignedUrl, storageDeleteFile, storageListFiles,
  SUPABASE_URL, SUPABASE_ANON_KEY
};