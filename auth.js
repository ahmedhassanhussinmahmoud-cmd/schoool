// auth.js — المصادقة والجلسات والأدوار
import { getClient, callLoginWithUsername } from "./supabase.js";
import { metaStore, idb } from "./db.js";

const SESSION_KEY = "session";
const PARENT_KEY = "parent_session";

async function login(emailOrUsername, password) {
  const client = getClient();
  let session = null;
  let userId = null;
  let userEmail = null;

  if (!emailOrUsername.includes("@")) {
    const res = await callLoginWithUsername(emailOrUsername, password);
    const { data, error } = await client.auth.setSession({
      access_token: res.session.access_token,
      refresh_token: res.session.refresh_token
    });
    if (error) throw new Error(error.message);
    session = data.session;
    userId = res.session.user_id;
    userEmail = res.session.email;
  } else {
    const { data, error } = await client.auth.signInWithPassword({
      email: emailOrUsername,
      password
    });
    if (error) throw new Error(translateAuthError(error.message));
    session = data.session;
    userId = session.user.id;
    userEmail = session.user.email;
  }

  const { data: profile, error: pErr } = await client
    .from("profiles").select("*").eq("id", userId).maybeSingle();
  if (pErr) throw pErr;
  if (!profile) throw new Error("لا يوجد ملف شخصي مرتبط بهذا الحساب. تواصل مع المدير.");

  const sessionData = {
    user_id: userId,
    email: userEmail,
    role: profile.role,
    school_id: profile.school_id,
    full_name: profile.full_name || userEmail,
    access_token: session?.access_token,
    refresh_token: session?.refresh_token,
    must_change_password: !!profile.must_change_password,
    created_at: Date.now()
  };
  await metaStore.set(SESSION_KEY, sessionData);
  return sessionData;
}

async function logout() {
  try {
    const client = getClient();
    await client.auth.signOut();
  } catch (_) {}
  await metaStore.del(SESSION_KEY);
  await metaStore.del(PARENT_KEY);
}

async function getSession() { return metaStore.get(SESSION_KEY); }
async function getParentSession() { return metaStore.get(PARENT_KEY); }
async function setParentSession(payload) {
  await metaStore.set(PARENT_KEY, { ...payload, created_at: Date.now() });
}
async function clearParentSession() { await metaStore.del(PARENT_KEY); }
async function getCurrentUserRole() {
  const s = await getSession();
  return s ? s.role : null;
}

function translateAuthError(msg) {
  if (!msg) return "خطأ غير معروف";
  if (msg.includes("Invalid login")) return "البريد أو كلمة المرور غير صحيحة";
  if (msg.includes("Email not confirmed")) return "يجب تأكيد البريد الإلكتروني أولاً";
  if (msg.includes("rate")) return "محاولات كثيرة، انتظر قليلًا";
  return msg;
}

async function changePassword(newPassword) {
  const client = getClient();
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
  try {
    const uid = (await client.auth.getUser()).data.user?.id;
    if (uid) {
      await client.from("profiles").update({ must_change_password: false }).eq("id", uid);
    }
  } catch (e) {
    console.warn("Could not clear must_change_password flag", e);
  }
  const s = await metaStore.get(SESSION_KEY);
  if (s) {
    s.must_change_password = false;
    await metaStore.set(SESSION_KEY, s);
  }
}

export {
  login, logout, getSession, getParentSession, setParentSession,
  clearParentSession, getCurrentUserRole, changePassword,
  SESSION_KEY, PARENT_KEY
};