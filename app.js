// app.js — منطق الواجهة الكامل
import { idb, metaStore } from "./db.js";
import {
  login, logout, getSession, getParentSession, setParentSession,
  clearParentSession, changePassword
} from "./auth.js";
import { enqueue, syncNow, refreshFromCloud, startWatchers, isOnline, on } from "./sync.js";
import {
  getClient, parentLookup, callDeleteSchoolData, SUPABASE_URL,
  callCreateTeacherAccount, callResetTeacherPassword,
  storageUploadFile, storageGetSignedUrl, storageDeleteFile, storageListFiles
} from "./supabase.js";

/* ============ Helpers ============ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function normalizeArabic(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/[أإآٱا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function arabicIncludes(haystack, needle) {
  return normalizeArabic(haystack).includes(normalizeArabic(needle));
}

function uuid() { return crypto.randomUUID(); }
function todayISO() { return new Date().toISOString().slice(0,10); }
function fmtDate(d) {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString("ar-EG"); } catch { return d; }
}
function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toast(msg, type = "info", duration = 4000) {
  const c = $("#toastContainer");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function showModal({ title, bodyHtml, footerHtml, onMount }) {
  const modal = $("#modal");
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalFooter").innerHTML = footerHtml || "";
  modal.hidden = false;
  $$("[data-close]", modal).forEach(b => b.onclick = () => hideModal());
  if (onMount) onMount();
}
function hideModal() {
  $("#modal").hidden = true;
  $("#modalBody").innerHTML = "";
  $("#modalFooter").innerHTML = "";
}

/* ============ Theme ============ */
const THEME_KEY = "theme";

async function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const toggle = $("#themeToggle");
  if (toggle) toggle.textContent = theme === "dark" ? "☀️" : "🌙";
  const loginToggle = $("#loginThemeToggle");
  if (loginToggle) loginToggle.textContent = theme === "dark" ? "☀️ الوضع النهاري" : "🌙 الوضع الليلي";
}
async function getSavedTheme() {
  try { return (await metaStore.get(THEME_KEY)) || "light"; }
  catch { return "light"; }
}
async function toggleTheme() {
  const current = await getSavedTheme();
  const next = current === "dark" ? "light" : "dark";
  await metaStore.set(THEME_KEY, next);
  await applyTheme(next);
}

/* ============ Idle logout ============ */
let _idleTimer = null;
let _idleWarningTimer = null;
const IDLE_TIMEOUT = 30 * 60 * 1000;
const IDLE_WARNING = 60 * 1000;

function resetIdleTimer() {
  if (!state.session) return;
  if (_idleTimer) clearTimeout(_idleTimer);
  if (_idleWarningTimer) clearTimeout(_idleWarningTimer);
  _idleWarningTimer = setTimeout(() => showIdleWarning(), IDLE_TIMEOUT - IDLE_WARNING);
  _idleTimer = setTimeout(() => forceIdleLogout(), IDLE_TIMEOUT);
}

function startIdleWatcher() {
  const events = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "click"];
  events.forEach(evt => document.addEventListener(evt, resetIdleTimer, { passive: true }));
  resetIdleTimer();
}

function stopIdleWatcher() {
  if (_idleTimer) clearTimeout(_idleTimer);
  if (_idleWarningTimer) clearTimeout(_idleWarningTimer);
}

let _idleWarningOpen = false;
function showIdleWarning() {
  if (_idleWarningOpen) return;
  _idleWarningOpen = true;
  showModal({
    title: "⚠️ انتهاء الجلسة قريبًا",
    bodyHtml: `<p>ستنتهي جلستك خلال <strong>60 ثانية</strong> بسبب عدم النشاط.</p>`,
    footerHtml: `
      <button class="btn btn-primary" id="idleContinueBtn">متابعة العمل</button>
      <button class="btn btn-danger" id="idleLogoutBtn">تسجيل الخروج الآن</button>
    `,
    onMount: () => {
      $("#idleContinueBtn").onclick = () => {
        _idleWarningOpen = false;
        hideModal();
        resetIdleTimer();
        toast("تم تمديد الجلسة", "success");
      };
      $("#idleLogoutBtn").onclick = async () => {
        _idleWarningOpen = false;
        hideModal();
        await forceIdleLogout();
      };
    }
  });
}
async function forceIdleLogout() {
  try { await logout(); } catch (_) {}
  state.session = null;
  stopIdleWatcher();
  toast("تم تسجيل الخروج بسبب عدم النشاط", "info", 3000);
  setTimeout(() => location.reload(), 800);
}

/* ============ State ============ */
const state = {
  session: null,
  parentSession: null,
  school: null,
  students: [], teachers: [], classes: [], sections: [], subjects: [],
  assignments: [], schedules: [], attendance: [], grades: [],
  homework: [], behavior: [], announcements: [], parentNotes: [], profiles: [],
  currentPage: "dashboard"
};

/* ============ School ============ */
async function loadSchool() {
  if (!state.session || !state.session.school_id) return;
  const s = await idb.get("schools", state.session.school_id);
  state.school = s || null;
  applySchoolBranding();
}

function applySchoolBranding() {
  const name = state.school?.name || "نظام إدارة المدرسة";
  const loginName = $("#loginSchoolName");
  if (loginName) loginName.textContent = state.school?.name || "نظام إدارة المدرسة";
  const parentName = $("#parentSchoolName");
  if (parentName) parentName.textContent = state.school?.name || "متابعة الطالب";
  const sideName = $("#sidebarSchoolName");
  if (sideName) sideName.textContent = state.school?.name || "المدرسة";
  document.title = name;
  if (state.school?.logo_url) {
    const img = $("#schoolLogo");
    if (img) { img.src = state.school.logo_url; img.hidden = false; }
    const fb = $("#schoolLogoFallback");
    if (fb) fb.hidden = true;
  }
}

/* ============ Navigation ============ */
const ADMIN_MENU = [
  { id: "dashboard",     label: "الرئيسية",             ico: "🏠" },
  { id: "grades",        label: "الدرجات",               ico: "📚" },
  { id: "students",      label: "الطلاب",                ico: "👨‍🎓" },
  { id: "teachers",      label: "الكادر التدريسي",        ico: "👨‍🏫" },
  { id: "schedule",      label: "الجدول الأسبوعي",        ico: "📅" },
  { id: "attendance",    label: "الغياب والحضور",         ico: "✅" },
  { id: "reports",       label: "التقارير والإحصائيات",   ico: "📊" },
  { id: "files",         label: "الملفات",                ico: "📁" },
  { id: "announcements", label: "الإعلانات والتنبيهات",    ico: "🔔" },
  { id: "parent_notes",  label: "المتبقي من الرسوم",      ico: "💰" },
  { id: "settings",      label: "الإعدادات",              ico: "⚙️" }
];

const TEACHER_MENU = [
  { id: "dashboard",     label: "الرئيسية",          ico: "🏠" },
  { id: "grades",        label: "الدرجات",            ico: "📚" },
  { id: "students",      label: "طلابي",              ico: "👨‍🎓" },
  { id: "schedule",      label: "جدولي",              ico: "📅" },
  { id: "attendance",    label: "الحضور",             ico: "✅" },
  { id: "homework",      label: "الواجبات والكراسة",  ico: "📝" },
  { id: "behavior",      label: "السلوك",             ico: "💬" },
  { id: "announcements", label: "الإعلانات",          ico: "🔔" },
  { id: "parent_notes",  label: "المتبقي من الرسوم",  ico: "💰" },
  { id: "account",       label: "حسابي",              ico: "👤" }
];

function buildMenu() {
  const role = state.session?.role;
  const items = role === "admin" ? ADMIN_MENU : TEACHER_MENU;
  const nav = $("#navMenu");
  if (!nav) return;
  nav.innerHTML = "";
  items.forEach(it => {
    const a = document.createElement("div");
    a.className = "nav-item" + (state.currentPage === it.id ? " active" : "");
    a.dataset.page = it.id;
    a.innerHTML = `<span class="ico">${it.ico}</span><span>${it.label}</span>`;
    a.onclick = () => navigate(it.id);
    nav.appendChild(a);
  });
}

async function navigate(page) {
  state.currentPage = page;
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.page === page));
  const meta = (state.session?.role === "admin" ? ADMIN_MENU : TEACHER_MENU).find(x => x.id === page);
  $("#pageTitle").textContent = meta?.label || "الرئيسية";
  closeSidebar();
  await renderPage(page);
}

/* ============ Load ============ */
async function loadAllLocal() {
  const keys = ["students","teachers","classes","sections","subjects","teacher_assignments",
    "schedules","attendance","grades","homework","behavior_notes","announcements","profiles","parent_notes"];
  for (const k of keys) {
    const target = k === "behavior_notes" ? "behavior"
      : k === "teacher_assignments" ? "assignments"
      : k === "parent_notes" ? "parentNotes"
      : k;
    state[target] = await idb.getAll(k);
  }
  if (state.session?.school_id) {
    const sid = state.session.school_id;
    state.students = state.students.filter(s => s.school_id === sid);
    state.teachers = state.teachers.filter(s => s.school_id === sid);
    state.classes = state.classes.filter(s => s.school_id === sid);
    state.sections = state.sections.filter(s => s.school_id === sid);
    state.subjects = state.subjects.filter(s => s.school_id === sid);
    state.assignments = state.assignments.filter(s => s.school_id === sid);
    state.schedules = state.schedules.filter(s => s.school_id === sid);
    state.attendance = state.attendance.filter(s => s.school_id === sid);
    state.grades = state.grades.filter(s => s.school_id === sid);
    state.homework = state.homework.filter(s => s.school_id === sid);
    state.behavior = state.behavior.filter(s => s.school_id === sid);
    state.announcements = state.announcements.filter(s => s.school_id === sid);
    state.parentNotes = state.parentNotes.filter(n => n.school_id === sid);
  }
}

/* ============ Scope ============ */
function teacherStudents() {
  if (state.session.role === "admin") return state.students;
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  if (!me) return [];
  const set = new Set();
  const myAssign = state.assignments.filter(a => a.teacher_id === me.id);
  for (const st of state.students) {
    if (myAssign.some(a => a.class_id === st.class_id && a.section_id === st.section_id)) set.add(st.id);
  }
  return state.students.filter(s => set.has(s.id));
}

/* ============ Tracking ============ */
async function generateTrackingNumber(schoolId) {
  const existing = new Set(
    (await idb.getAll("students"))
      .filter(s => s.school_id === schoolId)
      .map(s => s.tracking_number)
  );
  for (let i = 0; i < 50; i++) {
    const len = Math.random() < 0.6 ? 4 : (Math.random() < 0.7 ? 5 : 6);
    const min = Math.pow(10, len - 1);
    const max = Math.pow(10, len) - 1;
    const candidate = String(Math.floor(min + Math.random() * (max - min)));
    if (!existing.has(candidate)) return candidate;
  }
  return String(Date.now()).slice(-6);
}

/* ============ Render pages ============ */
async function renderPage(page) {
  const c = $("#pageContent");
  c.innerHTML = `<div class="empty-state">جارٍ التحميل…</div>`;
  try {
    switch (page) {
      case "dashboard":     return renderDashboard(c);
      case "students":      return renderStudents(c);
      case "teachers":      return renderTeachers(c);
      case "grades":        return renderGrades(c);
      case "schedule":      return renderSchedule(c);
      case "attendance":    return renderAttendance(c);
      case "reports":       return renderReports(c);
      case "files":         return renderFiles(c);
      case "announcements": return renderAnnouncements(c);
      case "parent_notes":  return renderParentNotes(c);
      case "settings":      return renderSettings(c);
      case "homework":      return renderHomework(c);
      case "behavior":      return renderBehavior(c);
      case "account":       return renderAccount(c);
      default:              c.innerHTML = `<div class="empty-state">غير معروف</div>`;
    }
  } catch (e) {
    console.error(e);
    c.innerHTML = `<div class="card"><div class="error-msg">حدث خطأ: ${escapeHtml(e.message)}</div></div>`;
  }
}

function className(id) { return state.classes.find(c => c.id === id)?.name || "—"; }
function sectionName(id) { return state.sections.find(s => s.id === id)?.name || "—"; }
function subjectName(id) { return state.subjects.find(s => s.id === id)?.name || "—"; }
function teacherName(id) { return state.teachers.find(t => t.id === id)?.full_name || "—"; }

const DAYS_AR = ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];

function hwLabel(s) {
  return s === "completed" ? "مكتمل" : s === "incomplete" ? "غير مكتمل" : s === "not_submitted" ? "لم يسلم" : "—";
}
function bhLabel(t) {
  return t === "positive" ? "إيجابية" : t === "warning" ? "تنبيه" : "ملاحظة";
}

/* ===== Academic Alerts ===== */
function computeStudentAlerts(student, options = {}) {
  const {
    attendanceWindowDays = 30,
    gradeWindowDays = 90,
    absentThreshold = 3,
    consecutiveAbsentThreshold = 2,
    lowGradeThreshold = 50
  } = options;

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const attCutoff = now - attendanceWindowDays * DAY;
  const gradeCutoff = now - gradeWindowDays * DAY;

  const alerts = [];

  const myAtt = state.attendance
    .filter(a => a.student_id === student.id && new Date(a.date).getTime() >= attCutoff)
    .sort((a, b) => b.date.localeCompare(a.date));
  const absences = myAtt.filter(a => a.status === "absent");

  if (absences.length >= absentThreshold) {
    alerts.push({
      type: "attendance_repeated",
      severity: absences.length >= 5 ? "danger" : "warning",
      icon: "🚨",
      title: "غياب متكرر",
      message: `${absences.length} غيابات خلال آخر ${attendanceWindowDays} يوم`,
      date: absences[0]?.date || null,
      ref_id: student.id
    });
  }

  let consecutiveAbsent = 0, maxConsecutive = 0;
  const sortedAsc = myAtt.slice().sort((a, b) => a.date.localeCompare(b.date));
  for (const a of sortedAsc) {
    if (a.status === "absent") { consecutiveAbsent++; maxConsecutive = Math.max(maxConsecutive, consecutiveAbsent); }
    else consecutiveAbsent = 0;
  }
  if (maxConsecutive >= consecutiveAbsentThreshold) {
    alerts.push({
      type: "attendance_consecutive",
      severity: "danger",
      icon: "⚠️",
      title: "غياب متتالي",
      message: `${maxConsecutive} أيام غياب متتالية`,
      date: sortedAsc[sortedAsc.length - 1]?.date || null,
      ref_id: student.id
    });
  }

  const myGrades = state.grades
    .filter(g => g.student_id === student.id && new Date(g.date).getTime() >= gradeCutoff);
  const lowGrades = myGrades.filter(g => g.max_score > 0 && (g.score / g.max_score) * 100 < lowGradeThreshold);
  if (lowGrades.length >= 2) {
    alerts.push({
      type: "grade_low", severity: "warning", icon: "📉",
      title: "درجات منخفضة",
      message: `${lowGrades.length} تقييمات بأقل من ${lowGradeThreshold}%`,
      date: lowGrades[0]?.date || null, ref_id: student.id
    });
  }

  const myHw = state.homework.filter(h => h.student_id === student.id);
  const recentHw = myHw.filter(h => new Date(h.date).getTime() >= attCutoff);
  const notSubmitted = recentHw.filter(h => h.homework_status === "not_submitted");
  if (notSubmitted.length >= 3) {
    alerts.push({
      type: "homework_repeated", severity: "warning", icon: "📝",
      title: "واجبات لم تُسلَّم",
      message: `${notSubmitted.length} واجبات لم يتم تسليمها`,
      date: notSubmitted[0]?.date || null, ref_id: student.id
    });
  }

  const myBh = state.behavior.filter(b => b.student_id === student.id);
  const recentBh = myBh.filter(b => b.note_type === "warning" && new Date(b.date).getTime() >= attCutoff);
  if (recentBh.length >= 3) {
    alerts.push({
      type: "behavior_repeated", severity: "warning", icon: "⚠️",
      title: "تنبيهات سلوكية متكررة",
      message: `${recentBh.length} تنبيهات خلال آخر ${attendanceWindowDays} يوم`,
      date: recentBh[0]?.date || null, ref_id: student.id
    });
  }

  alerts.sort((a, b) => {
    const order = { danger: 0, warning: 1, info: 2 };
    return (order[a.severity] || 3) - (order[b.severity] || 3);
  });
  return alerts;
}

function countStudentsAtRisk(students) {
  let count = 0;
  for (const st of students) {
    const alerts = computeStudentAlerts(st);
    if (alerts.some(a => a.severity === "danger")) count++;
  }
  return count;
}

function openAtRiskStudents() {
  const students = state.students.filter(s => s.status === "active");
  const rows = students
    .map(st => ({ student: st, alerts: computeStudentAlerts(st) }))
    .filter(x => x.alerts.length > 0)
    .sort((a, b) => {
      const aDanger = a.alerts.filter(x => x.severity === "danger").length;
      const bDanger = b.alerts.filter(x => x.severity === "danger").length;
      if (aDanger !== bDanger) return bDanger - aDanger;
      return b.alerts.length - a.alerts.length;
    });

  if (!rows.length) {
    showModal({
      title: "لا يوجد طلاب في خطر",
      bodyHtml: `<div class="empty-state">كل الطلاب في وضع أكاديمي جيد ✅</div>`,
      footerHtml: `<button class="btn" data-close>إغلاق</button>`
    });
    return;
  }

  showModal({
    title: `طلاب في خطر (${rows.length})`,
    bodyHtml: `
      <p class="muted small">مرتب من الأخطر إلى الأقل خطرًا.</p>
      <div style="max-height:480px; overflow:auto">
        ${rows.map(({ student, alerts }) => {
          const dangerCount = alerts.filter(a => a.severity === "danger").length;
          return `
            <div class="list-item" style="border-right:4px solid ${dangerCount ? '#dc2626' : '#d97706'}">
              <div class="row" style="justify-content:space-between">
                <div>
                  <div class="list-item-title">${escapeHtml(student.full_name)}</div>
                  <div class="muted small">
                    رقم المتابعة: <span class="badge badge-info">${escapeHtml(student.tracking_number)}</span> —
                    ${escapeHtml(className(student.class_id))} / ${escapeHtml(sectionName(student.section_id))}
                  </div>
                </div>
                <button class="btn btn-sm" data-open="${student.id}">ملف الطالب</button>
              </div>
              <div style="margin-top:8px">
                ${alerts.map(a => `
                  <div class="row" style="gap:6px; margin-bottom:4px; align-items:center">
                    <span>${a.icon}</span>
                    <span class="badge ${a.severity === "danger" ? "badge-danger" : "badge-warning"}">${escapeHtml(a.title)}</span>
                    <span class="muted small">${escapeHtml(a.message)}</span>
                  </div>`).join("")}
              </div>
            </div>`;
        }).join("")}
      </div>
    `,
    footerHtml: `<button class="btn" data-close>إغلاق</button>`,
    onMount: () => {
      $$("[data-open]").forEach(b => b.onclick = () => {
        hideModal();
        openStudentProfile(b.dataset.open);
      });
    }
  });
}

/* ===== Dashboard ===== */
async function renderDashboard(c) {
  const role = state.session.role;
  if (role === "admin") {
    const totalStudents = state.students.filter(s => s.status === "active").length;
    const totalTeachers = state.teachers.filter(t => t.status === "active").length;
    const totalClasses = state.classes.length;
    const totalSections = state.sections.length;
    const totalAnnouncements = state.announcements.length;
    const pendingSync = (await idb.getAll("sync_queue")).filter(o => o.sync_status !== "synced").length;
    const atRisk = countStudentsAtRisk(state.students.filter(s => s.status === "active"));

    const atRiskBanner = atRisk > 0
      ? `<div class="card" style="border:1px solid #fca5a5; background:#fef2f2">
          <div class="row" style="justify-content:space-between">
            <div>
              <h3 class="card-title" style="margin:0; color:var(--danger)">🚨 ${atRisk} طالب في خطر</h3>
              <p class="muted small" style="margin-top:4px">طلاب لديهم إنذارات حرجة (غياب متكرر أو متتالي).</p>
            </div>
            <button class="btn btn-danger" id="viewAtRiskBtn">عرض القائمة</button>
          </div>
        </div>`
      : "";

    c.innerHTML = `
      ${atRiskBanner}
      <div class="stats-grid">
        <div class="stat-card"><div class="label">إجمالي الطلاب</div><div class="value">${totalStudents}</div></div>
        <div class="stat-card"><div class="label">إجمالي المعلمين</div><div class="value">${totalTeachers}</div></div>
        <div class="stat-card"><div class="label">الصفوف</div><div class="value">${totalClasses}</div></div>
        <div class="stat-card"><div class="label">الفصول</div><div class="value">${totalSections}</div></div>
        <div class="stat-card"><div class="label">الإعلانات</div><div class="value">${totalAnnouncements}</div></div>
        <div class="stat-card"><div class="label">عمليات في الانتظار</div><div class="value">${pendingSync}</div></div>
      </div>
      <div class="card">
        <h3 class="card-title">أحدث الإعلانات</h3>
        ${state.announcements.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5).map(a => `
          <div class="list-item">
            <div class="list-item-title">${escapeHtml(a.title)}</div>
            <div class="muted small">${fmtDate(a.date)}</div>
            <div>${escapeHtml(a.content)}</div>
          </div>`).join("") || `<div class="empty-state">لا توجد إعلانات</div>`}
      </div>`;

    const viewAtRiskBtn = $("#viewAtRiskBtn");
    if (viewAtRiskBtn) viewAtRiskBtn.onclick = () => openAtRiskStudents();
  } else {
    const myStudents = teacherStudents();
    const me = state.teachers.find(t => t.profile_id === state.session.user_id);
    const myAssign = state.assignments.filter(a => a.teacher_id === me?.id);

    const todayDow = new Date().getDay();
    const todaySchedules = state.schedules
      .filter(s => s.teacher_id === me?.id && s.day_of_week === todayDow)
      .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));

    c.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="label">طلابي</div><div class="value">${myStudents.length}</div></div>
        <div class="stat-card"><div class="label">تعييناتي</div><div class="value">${myAssign.length}</div></div>
        <div class="stat-card"><div class="label">حصص الأسبوع</div><div class="value">${state.schedules.filter(s=>s.teacher_id===me?.id).length}</div></div>
        <div class="stat-card"><div class="label">حصص اليوم</div><div class="value">${todaySchedules.length}</div></div>
      </div>

      <div class="card">
        <h3 class="card-title">📅 حصص اليوم — ${DAYS_AR[todayDow]}</h3>
        ${todaySchedules.length
          ? `<div class="today-schedules">
              ${todaySchedules.map(s => `
                <div class="today-schedule-item">
                  <div class="today-schedule-time">${escapeHtml(s.start_time)} — ${escapeHtml(s.end_time)}</div>
                  <div class="today-schedule-info">
                    <strong>${escapeHtml(subjectName(s.subject_id))}</strong>
                    <div class="muted small">${escapeHtml(className(s.class_id))} / ${escapeHtml(sectionName(s.section_id))}</div>
                  </div>
                </div>`).join("")}
            </div>`
          : `<div class="empty-state">لا حصص اليوم 🎉</div>`}
      </div>

      <div class="card">
        <h3 class="card-title">الإعلانات الموجهة إليّ</h3>
        ${state.announcements.filter(a=>a.audience==="teachers"||a.audience==="all").slice(0,5).map(a => `
          <div class="list-item">
            <div class="list-item-title">${escapeHtml(a.title)}</div>
            <div class="muted small">${fmtDate(a.date)}</div>
            <div>${escapeHtml(a.content)}</div>
          </div>`).join("") || `<div class="empty-state">لا توجد إعلانات</div>`}
      </div>`;
  }
}

/* ===== Students ===== */
let _studentsPagination = { page: 1, pageSize: 25, filter: "" };

async function renderStudents(c) {
  const role = state.session.role;
  const list = role === "admin" ? state.students : teacherStudents();
  const activeList = list.filter(s => s.status === "active");

  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="studentsSearch" class="search-input" placeholder="ابحث بالاسم أو رقم المتابعة أو الصف أو الفصل" />
        ${role === "admin" ? `<button id="addStudentBtn" class="btn btn-primary">➕ طالب جديد</button>
        <button id="archivedStudentsBtn" class="btn btn-ghost">الطلاب المؤرشفون</button>` : ``}
      </div>
      <div class="table-wrap">
        <table class="data" id="studentsTable">
          <thead><tr>
            <th>الاسم</th><th>رقم المتابعة</th><th>الصف</th><th>الفصل</th><th>ولي الأمر</th><th>الحالة</th><th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="row" style="justify-content:space-between; margin-top:12px">
        <span id="studentsCount" class="muted small"></span>
        <div class="row">
          <button class="btn btn-sm" id="studentsPrev">◀ السابق</button>
          <span id="studentsPage" class="muted small"></span>
          <button class="btn btn-sm" id="studentsNext">التالي ▶</button>
        </div>
      </div>
    </div>`;

  const renderRows = () => {
    const f = _studentsPagination.filter;
    const filtered = activeList.filter(s => {
      if (!f) return true;
      return arabicIncludes(s.full_name, f)
        || String(s.tracking_number || "").includes(f.trim())
        || arabicIncludes(className(s.class_id), f)
        || arabicIncludes(sectionName(s.section_id), f);
    });
    const total = filtered.length;
    const pageSize = _studentsPagination.pageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (_studentsPagination.page > totalPages) _studentsPagination.page = totalPages;
    const start = (_studentsPagination.page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);

    const tbody = $("#studentsTable tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">لا نتائج</td></tr>`;
    } else {
      tbody.innerHTML = rows.map(s => `
        <tr>
          <td>${escapeHtml(s.full_name)}</td>
          <td><span class="badge badge-info">${escapeHtml(s.tracking_number)}</span></td>
          <td>${escapeHtml(className(s.class_id))}</td>
          <td>${escapeHtml(sectionName(s.section_id))}</td>
          <td>${escapeHtml(s.parent_name || "—")}</td>
          <td>${s.status === "active" ? '<span class="badge badge-success">نشط</span>' : '<span class="badge badge-muted">مؤرشف</span>'}</td>
          <td><button class="btn btn-sm" data-open="${s.id}">ملف الطالب</button></td>
        </tr>`).join("");
      tbody.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openStudentProfile(b.dataset.open));
    }
    $("#studentsCount").textContent = `إجمالي: ${total}`;
    $("#studentsPage").textContent = `صفحة ${_studentsPagination.page} من ${totalPages}`;
    $("#studentsPrev").disabled = _studentsPagination.page <= 1;
    $("#studentsNext").disabled = _studentsPagination.page >= totalPages;
  };

  $("#studentsSearch").oninput = debounce(e => {
    _studentsPagination.filter = e.target.value;
    _studentsPagination.page = 1;
    renderRows();
  }, 200);
  $("#studentsPrev").onclick = () => { _studentsPagination.page--; renderRows(); };
  $("#studentsNext").onclick = () => { _studentsPagination.page++; renderRows(); };
  renderRows();

  if (role === "admin") {
    $("#addStudentBtn").onclick = () => openStudentForm();
    $("#archivedStudentsBtn").onclick = () => openArchivedStudents();
  }
}

async function openArchivedStudents() {
  const archived = state.students.filter(s => s.status === "archived");
  showModal({
    title: "الطلاب المؤرشفون",
    bodyHtml: archived.length ? archived.map(s => `
      <div class="list-item">
        <div class="list-item-title">${escapeHtml(s.full_name)}</div>
        <div class="muted small">رقم المتابعة: ${escapeHtml(s.tracking_number)} — ${escapeHtml(className(s.class_id))}</div>
        <button class="btn btn-sm btn-primary" data-restore="${s.id}">استعادة</button>
      </div>`).join("") : `<div class="empty-state">لا يوجد طلاب مؤرشفون</div>`,
    onMount: () => {
      $$("[data-restore]").forEach(b => b.onclick = async () => {
        const id = b.dataset.restore;
        const st = state.students.find(x => x.id === id);
        st.status = "active";
        st.updated_at = new Date().toISOString();
        await idb.put("students", st);
        await enqueue({ entity: "students", record_id: st.id, operation_type: "update", payload: st, school_id: st.school_id });
        await loadAllLocal();
        hideModal();
        toast("تم استعادة الطالب", "success");
        navigate("students");
      });
    }
  });
}

async function openStudentForm(existing = null) {
  const classes = state.classes;
  const sections = state.sections;
  const body = `
    <div class="form-grid">
      <div class="field"><label>الاسم الكامل</label><input id="stFullName" value="${escapeHtml(existing?.full_name || "")}" /></div>
      <div class="field"><label>الجنس</label>
        <select id="stGender">
          <option value="male" ${existing?.gender === "male" ? "selected" : ""}>ذكر</option>
          <option value="female" ${existing?.gender === "female" ? "selected" : ""}>أنثى</option>
        </select></div>
      <div class="field"><label>تاريخ الميلاد</label><input type="date" id="stBirth" value="${existing?.birth_date || ""}" /></div>
      <div class="field"><label>الصف</label>
        <select id="stClass">
          <option value="">— اختر —</option>
          ${classes.map(c => `<option value="${c.id}" ${existing?.class_id === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
        </select></div>
      <div class="field"><label>الفصل</label>
        <select id="stSection">
          <option value="">— اختر —</option>
          ${sections.map(c => `<option value="${c.id}" ${existing?.section_id === c.id ? "selected" : ""}>${escapeHtml(c.name)} (${escapeHtml(className(c.class_id))})</option>`).join("")}
        </select></div>
      <div class="field"><label>السنة الدراسية</label><input id="stYear" value="${escapeHtml(existing?.academic_year || state.school?.academic_year || "")}" /></div>
      <div class="field"><label>هاتف الطالب (اختياري)</label><input id="stPhone" value="${escapeHtml(existing?.phone || "")}" /></div>
      <div class="field"><label>اسم ولي الأمر</label><input id="stParentName" value="${escapeHtml(existing?.parent_name || "")}" /></div>
      <div class="field"><label>هاتف ولي الأمر</label><input id="stParentPhone" value="${escapeHtml(existing?.parent_phone || "")}" /></div>
    </div>`;
  showModal({
    title: existing ? "تعديل بيانات الطالب" : "إضافة طالب جديد",
    bodyHtml: body,
    footerHtml: `<button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveStudentBtn">حفظ</button>`,
    onMount: () => {
      $("#saveStudentBtn").onclick = async () => {
        const full_name = $("#stFullName").value.trim();
        if (!full_name) { toast("الاسم مطلوب", "error"); return; }
        const schoolId = state.session.school_id;
        let tracking = existing?.tracking_number;
        if (!existing) tracking = await generateTrackingNumber(schoolId);
        if (!existing) {
          const dup = state.students.find(s => s.school_id === schoolId && s.tracking_number === tracking);
          if (dup) { toast("رقم المتابعة مكرر، حاول مجددًا", "error"); return; }
        }
        const row = {
          id: existing?.id || uuid(),
          school_id: schoolId,
          full_name,
          gender: $("#stGender").value,
          birth_date: $("#stBirth").value || null,
          class_id: $("#stClass").value || null,
          section_id: $("#stSection").value || null,
          academic_year: $("#stYear").value.trim(),
          phone: $("#stPhone").value.trim() || null,
          parent_name: $("#stParentName").value.trim() || null,
          parent_phone: $("#stParentPhone").value.trim() || null,
          tracking_number: tracking,
          status: existing?.status || "active",
          created_at: existing?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await idb.put("students", row);
        await enqueue({
          entity: "students", record_id: row.id,
          operation_type: existing ? "update" : "insert",
          payload: row, school_id: schoolId
        });
        hideModal();
        await loadAllLocal();
        toast("تم الحفظ" + (existing ? "" : ` — رقم المتابعة: ${tracking}`), "success");
        navigate("students");
      };
    }
  });
}

/* ===== Group grades by subject ===== */
function groupGradesBySubject(grades) {
  const map = {};
  for (const g of grades) {
    const key = g.subject_id || "unknown";
    if (!map[key]) map[key] = [];
    map[key].push(g);
  }
  const result = [];
  for (const [subjectId, list] of Object.entries(map)) {
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
    const totalScore = sorted.reduce((s, g) => s + Number(g.score || 0), 0);
    const totalMax = sorted.reduce((s, g) => s + Number(g.max_score || 0), 0);
    const avgPct = totalMax > 0 ? (totalScore / totalMax) * 100 : 0;
    let gradeLabel, gradeClass;
    if (avgPct >= 90) { gradeLabel = "ممتاز"; gradeClass = "badge-success"; }
    else if (avgPct >= 80) { gradeLabel = "جيد جدًا"; gradeClass = "badge-success"; }
    else if (avgPct >= 70) { gradeLabel = "جيد"; gradeClass = "badge-info"; }
    else if (avgPct >= 60) { gradeLabel = "مقبول"; gradeClass = "badge-warning"; }
    else if (avgPct >= 50) { gradeLabel = "ضعيف"; gradeClass = "badge-warning"; }
    else { gradeLabel = "ضعيف جدًا"; gradeClass = "badge-danger"; }

    result.push({
      subject_id: subjectId,
      subject_name: subjectName(subjectId),
      records: sorted,
      count: sorted.length,
      totalScore, totalMax,
      avgPct: Number(avgPct.toFixed(1)),
      gradeLabel, gradeClass
    });
  }
  result.sort((a, b) => (a.subject_name || "").localeCompare(b.subject_name || "", "ar"));
  return result;
}

function buildGradesReportHTML(grades) {
  const grouped = groupGradesBySubject(grades);
  if (!grouped.length) return `<div class="empty-state">لا توجد درجات مسجلة</div>`;

  const overallScore = grouped.reduce((s, g) => s + g.totalScore, 0);
  const overallMax = grouped.reduce((s, g) => s + g.totalMax, 0);
  const overallPct = overallMax > 0 ? (overallScore / overallMax) * 100 : 0;
  let overallLabel, overallClass;
  if (overallPct >= 90) { overallLabel = "ممتاز"; overallClass = "badge-success"; }
  else if (overallPct >= 80) { overallLabel = "جيد جدًا"; overallClass = "badge-success"; }
  else if (overallPct >= 70) { overallLabel = "جيد"; overallClass = "badge-info"; }
  else if (overallPct >= 60) { overallLabel = "مقبول"; overallClass = "badge-warning"; }
  else { overallLabel = "ضعيف"; overallClass = "badge-danger"; }

  const summary = `
    <div class="stats-grid" style="margin-bottom:14px">
      <div class="stat-card"><div class="label">عدد المواد</div><div class="value">${grouped.length}</div></div>
      <div class="stat-card"><div class="label">إجمالي الدرجات</div><div class="value">${overallScore.toFixed(1)} / ${overallMax.toFixed(1)}</div></div>
      <div class="stat-card"><div class="label">النسبة الكلية</div><div class="value">${overallPct.toFixed(1)}%</div></div>
      <div class="stat-card"><div class="label">التقدير العام</div><div class="value"><span class="badge ${overallClass}">${overallLabel}</span></div></div>
    </div>`;

  const subjectsHtml = grouped.map(sub => `
    <div class="subject-block">
      <div class="subject-header">
        <div>
          <strong style="font-size:15px">${escapeHtml(sub.subject_name)}</strong>
          <span class="muted small" style="margin-right:8px">(${sub.count} تقييم)</span>
        </div>
        <div class="row" style="gap:8px">
          <span class="badge ${sub.gradeClass}">${sub.gradeLabel}</span>
          <span class="badge badge-info">${sub.avgPct}%</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>التاريخ</th><th>نوع التقييم</th><th>الدرجة</th><th>النسبة</th></tr></thead>
          <tbody>
            ${sub.records.map(g => {
              const pct = g.max_score > 0 ? ((g.score / g.max_score) * 100).toFixed(1) : "—";
              return `<tr>
                <td>${fmtDate(g.date)}</td>
                <td>${escapeHtml(g.assessment_type)}</td>
                <td>${g.score} / ${g.max_score}</td>
                <td>${pct}%</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `).join("");

  return summary + subjectsHtml;
}

async function openStudentProfile(studentId) {
  const st = state.students.find(s => s.id === studentId);
  if (!st) return;
  const myAtt = state.attendance.filter(a => a.student_id === studentId).sort((a,b)=>b.date.localeCompare(a.date));
  const myGrades = state.grades.filter(g => g.student_id === studentId).sort((a,b)=>b.date.localeCompare(a.date));
  const myHw = state.homework.filter(h => h.student_id === studentId).sort((a,b)=>b.date.localeCompare(a.date));
  const myBh = state.behavior.filter(b => b.student_id === studentId).sort((a,b)=>b.date.localeCompare(a.date));
  const myNotes = state.parentNotes.filter(n => n.student_id === studentId).sort((a,b)=>(b.date||"").localeCompare(a.date||""));

  const parentUrl = `${location.origin}${location.pathname}?page=parent`;
  const parentMsg = `رابط متابعة الطالب:\n${parentUrl}\n\nاسم الطالب:\n${st.full_name}\n\nرقم المتابعة:\n${st.tracking_number}`;

  showModal({
    title: `ملف الطالب — ${escapeHtml(st.full_name)}`,
    bodyHtml: `
      <div class="tabs">
        <button class="tab active" data-tab="info">البيانات</button>
        <button class="tab" data-tab="grades">الدرجات</button>
        <button class="tab" data-tab="att">الحضور</button>
        <button class="tab" data-tab="hw">الواجبات</button>
        <button class="tab" data-tab="bh">السلوك</button>
        <button class="tab" data-tab="notes">💰 الرسوم</button>
        <button class="tab" data-tab="parent">متابعة ولي الأمر</button>
      </div>
      <div id="tabPane"></div>
    `,
    footerHtml: `
      <button class="btn" data-close>إغلاق</button>
      ${state.session.role === "admin" ? `
        <button class="btn btn-primary" id="editStudentBtn">تعديل</button>
        <button class="btn btn-danger" id="archiveStudentBtn">${st.status === "active" ? "أرشفة" : "استعادة"}</button>
      ` : ``}
    `,
    onMount: () => {
      const pane = $("#tabPane");
      const renderTab = (tab) => {
        if (tab === "info") {
          pane.innerHTML = `
            <div class="row"><strong>رقم المتابعة:</strong> <span class="badge badge-info">${escapeHtml(st.tracking_number)}</span></div>
            <div class="row"><strong>الصف:</strong> ${escapeHtml(className(st.class_id))}</div>
            <div class="row"><strong>الفصل:</strong> ${escapeHtml(sectionName(st.section_id))}</div>
            <div class="row"><strong>الجنس:</strong> ${st.gender === "female" ? "أنثى" : "ذكر"}</div>
            <div class="row"><strong>تاريخ الميلاد:</strong> ${escapeHtml(st.birth_date || "—")}</div>
            <div class="row"><strong>ولي الأمر:</strong> ${escapeHtml(st.parent_name || "—")} — ${escapeHtml(st.parent_phone || "")}</div>
            <div class="row"><strong>السنة الدراسية:</strong> ${escapeHtml(st.academic_year || "—")}</div>`;
        }
        if (tab === "grades") pane.innerHTML = buildGradesReportHTML(myGrades);
        if (tab === "att") {
          pane.innerHTML = myAtt.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>التاريخ</th><th>الحالة</th></tr></thead><tbody>
            ${myAtt.map(a => `<tr><td>${fmtDate(a.date)}</td><td>${a.status === "present" ? '<span class="badge badge-success">حاضر</span>' : a.status === "late" ? '<span class="badge badge-warning">متأخر</span>' : '<span class="badge badge-danger">غائب</span>'}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="empty-state">لا يوجد سجل</div>`;
        }
        if (tab === "hw") {
          pane.innerHTML = myHw.length ? myHw.map(h => `
            <div class="list-item">
              <div class="list-item-title">${escapeHtml(subjectName(h.subject_id))} — ${fmtDate(h.date)}</div>
              <div>الواجب: <span class="badge badge-info">${hwLabel(h.homework_status)}</span> | الكراسة: <span class="badge badge-info">${hwLabel(h.notebook_status)}</span></div>
              ${h.notes ? `<div class="muted small">${escapeHtml(h.notes)}</div>` : ""}
            </div>`).join("") : `<div class="empty-state">لا توجد واجبات</div>`;
        }
        if (tab === "bh") {
          pane.innerHTML = myBh.length ? myBh.map(b => `
            <div class="list-item">
              <div class="list-item-title">${fmtDate(b.date)} — <span class="badge ${b.note_type === "positive" ? "badge-success" : b.note_type === "warning" ? "badge-danger" : "badge-info"}">${bhLabel(b.note_type)}</span></div>
              <div>${escapeHtml(b.note)}</div>
            </div>`).join("") : `<div class="empty-state">لا ملاحظات</div>`;
        }
        if (tab === "notes") {
          pane.innerHTML = myNotes.length
            ? `<div class="row" style="justify-content:flex-end; margin-bottom:10px">
                <button class="btn btn-sm btn-primary" id="addNoteFromProfile">➕ إضافة تنبيه</button>
              </div>
              ${myNotes.map(n => {
                const amountTxt = (n.amount !== null && n.amount !== undefined && n.amount !== "")
                  ? `${Number(n.amount).toLocaleString("ar-EG")} ${escapeHtml(n.currency || "جنيه")}`
                  : null;
                const subjTxt = n.subject_id
                  ? `<span class="badge badge-info">${escapeHtml(subjectName(n.subject_id))}</span>`
                  : `<span class="badge badge-muted">عام</span>`;
                return `
                  <div class="list-item" style="border-right:3px solid var(--danger)">
                    <div class="row" style="justify-content:space-between; align-items:center">
                      <div class="list-item-title" style="margin:0">${escapeHtml(n.title || "المتبقي من الرسوم")}</div>
                      ${subjTxt}
                    </div>
                    <div class="muted small">${fmtDate(n.date)} — ${escapeHtml(teacherName(n.teacher_id) || "المدير")}</div>
                    ${amountTxt ? `<div style="font-size:20px; font-weight:800; color:var(--danger); margin:6px 0">${amountTxt}</div>` : ""}
                    ${n.body ? `<div>${escapeHtml(n.body)}</div>` : ""}
                  </div>`;
              }).join("")}`
            : `<div class="empty-state">لا تنبيهات</div>
               <div class="row" style="justify-content:center">
                 <button class="btn btn-sm btn-primary" id="addNoteFromProfile">➕ إضافة تنبيه</button>
               </div>`;
          const btn = $("#addNoteFromProfile");
          if (btn) btn.onclick = () => {
            const student = state.students.find(s => s.id === studentId);
            hideModal();
            openParentNoteForm(null, [student]);
          };
        }
        if (tab === "parent") {
          pane.innerHTML = `
            <div class="card">
              <p><strong>رابط ولي الأمر:</strong> <code>${escapeHtml(parentUrl)}</code></p>
              <p><strong>اسم الطالب:</strong> ${escapeHtml(st.full_name)}</p>
              <p><strong>رقم المتابعة:</strong> <span class="badge badge-info">${escapeHtml(st.tracking_number)}</span></p>
              <div class="row">
                <button class="btn btn-sm" id="copyUrlBtn">نسخ الرابط</button>
                <button class="btn btn-sm btn-primary" id="copyMsgBtn">نسخ بيانات المتابعة</button>
              </div>
            </div>`;
          $("#copyUrlBtn").onclick = async () => { await navigator.clipboard.writeText(parentUrl); toast("تم نسخ الرابط", "success"); };
          $("#copyMsgBtn").onclick = async () => {
            await navigator.clipboard.writeText(parentMsg);
            toast("تم نسخ بيانات المتابعة", "success");
          };
        }
      };
      renderTab("info");
      $$(".tab", $("#modalBody")).forEach(t => t.onclick = () => {
        $$(".tab", $("#modalBody")).forEach(x => x.classList.remove("active"));
        t.classList.add("active");
        renderTab(t.dataset.tab);
      });

      if (state.session.role === "admin") {
        $("#editStudentBtn").onclick = () => { hideModal(); openStudentForm(st); };
        $("#archiveStudentBtn").onclick = async () => {
          st.status = st.status === "active" ? "archived" : "active";
          st.updated_at = new Date().toISOString();
          await idb.put("students", st);
          await enqueue({ entity: "students", record_id: st.id, operation_type: "update", payload: st, school_id: st.school_id });
          await loadAllLocal();
          hideModal();
          toast(st.status === "active" ? "تم الاستعادة" : "تم الأرشفة", "success");
          navigate("students");
        };
      }
    }
  });
}

/* ===== Teachers ===== */
async function renderTeachers(c) {
  if (state.session.role !== "admin") {
    c.innerHTML = `<div class="card"><div class="error-msg">لا تملك صلاحية الوصول</div></div>`;
    return;
  }
  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="teachersSearch" class="search-input" placeholder="ابحث بالاسم أو المادة أو الصف أو الفصل" />
        <button id="addTeacherBtn" class="btn btn-primary">➕ معلم جديد</button>
      </div>
      <div class="table-wrap">
        <table class="data" id="teachersTable">
          <thead><tr><th>الاسم</th><th>البريد</th><th>المواد</th><th>الحالة</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  const renderRows = (filter = "") => {
    const rows = state.teachers.filter(t => {
      if (!filter) return true;
      const mySubs = state.assignments.filter(a => a.teacher_id === t.id).map(a => subjectName(a.subject_id)).join(" ");
      const myClasses = state.assignments.filter(a => a.teacher_id === t.id).map(a => className(a.class_id) + " " + sectionName(a.section_id)).join(" ");
      return arabicIncludes(t.full_name, filter)
        || arabicIncludes(t.email, filter)
        || arabicIncludes(mySubs, filter)
        || arabicIncludes(myClasses, filter);
    });
    const tbody = $("#teachersTable tbody");
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty-state">لا نتائج</td></tr>`; return; }
    tbody.innerHTML = rows.map(t => {
      const subs = state.assignments.filter(a => a.teacher_id === t.id).map(a => subjectName(a.subject_id));
      return `<tr>
        <td>${escapeHtml(t.full_name)}</td>
        <td class="muted small">${escapeHtml(t.email || "—")}</td>
        <td>${subs.length ? subs.map(s => `<span class="badge badge-info">${escapeHtml(s)}</span>`).join(" ") : "—"}</td>
        <td>${t.status === "active" ? '<span class="badge badge-success">نشط</span>' : '<span class="badge badge-muted">معطّل</span>'}</td>
        <td><button class="btn btn-sm" data-open="${t.id}">إدارة</button></td>
      </tr>`;
    }).join("");
    tbody.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openTeacherPanel(b.dataset.open));
  };

  $("#teachersSearch").oninput = debounce(e => renderRows(e.target.value), 200);
  renderRows("");
  $("#addTeacherBtn").onclick = () => openTeacherForm();
}

async function openTeacherForm(existing = null) {
  const isEdit = !!existing;
  const body = `
    <div class="form-grid">
      <div class="field"><label>الاسم الكامل</label><input id="tFullName" value="${escapeHtml(existing?.full_name || "")}" /></div>
      <div class="field"><label>اسم المستخدم</label><input id="tUsername" value="${escapeHtml(existing?.username || "")}" /></div>
      ${!isEdit ? `
        <div class="field"><label>البريد الإلكتروني (للدخول)</label><input id="tEmail" type="email" placeholder="email@example.com" /></div>
        <div class="field"><label>كلمة مرور مؤقتة</label><input id="tPassword" type="text" placeholder="6 أحرف على الأقل" /></div>
      ` : `
        <div class="field"><label>البريد الحالي</label><input id="tEmail" type="email" value="${escapeHtml(existing?.email || "")}" disabled /></div>
      `}
      <div class="field"><label>الحالة</label>
        <select id="tStatus">
          <option value="active" ${existing?.status === "active" ? "selected" : ""}>نشط</option>
          <option value="disabled" ${existing?.status === "disabled" ? "selected" : ""}>معطّل</option>
        </select></div>
    </div>
    ${!isEdit ? `<p class="muted small">سيتم إنشاء حساب الدخول تلقائيًا عبر Supabase Auth.</p>` : ``}
  `;

  showModal({
    title: existing ? "تعديل معلم" : "إضافة معلم",
    bodyHtml: body,
    footerHtml: `
      <button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveTeacherBtn">${existing ? "حفظ التعديلات" : "إنشاء الحساب"}</button>
    `,
    onMount: () => {
      $("#saveTeacherBtn").onclick = async () => {
        const full_name = $("#tFullName").value.trim();
        const username = $("#tUsername").value.trim();
        if (!full_name || !username) { toast("الاسم واسم المستخدم مطلوبان", "error"); return; }
        const dup = state.teachers.find(t => t.username === username && t.id !== existing?.id);
        if (dup) { toast("اسم المستخدم مستخدم بالفعل", "error"); return; }

        try {
          if (!isEdit) {
            const email = $("#tEmail").value.trim();
            const password = $("#tPassword").value;
            if (!email || !password) { toast("البريد وكلمة المرور مطلوبان", "error"); return; }
            if (password.length < 6) { toast("كلمة المرور 6 أحرف على الأقل", "error"); return; }
            if (!isOnline()) { toast("إنشاء حساب معلم يتطلب الاتصال بالإنترنت", "error"); return; }

            toast("جارٍ إنشاء الحساب...", "info");
            const res = await callCreateTeacherAccount({ email, password, full_name, username });
            await idb.put("teachers", res.teacher);
            await idb.put("profiles", {
              id: res.user_id,
              school_id: state.session.school_id,
              role: "teacher",
              full_name,
              must_change_password: true
            });
            hideModal();
            await loadAllLocal();
            toast("تم إنشاء حساب المعلم بنجاح", "success");
            navigate("teachers");
          } else {
            const row = {
              ...existing,
              full_name, username,
              status: $("#tStatus").value,
              updated_at: new Date().toISOString()
            };
            await idb.put("teachers", row);
            await enqueue({ entity: "teachers", record_id: row.id, operation_type: "update", payload: row, school_id: row.school_id });
            hideModal();
            await loadAllLocal();
            toast("تم الحفظ", "success");
            navigate("teachers");
          }
        } catch (e) {
          console.error(e);
          toast(e.message || "فشل الحفظ", "error");
        }
      };
    }
  });
}

async function openTeacherPanel(teacherId) {
  const t = state.teachers.find(x => x.id === teacherId);
  if (!t) return;
  const myAssign = state.assignments.filter(a => a.teacher_id === teacherId);

  showModal({
    title: `إدارة المعلم — ${escapeHtml(t.full_name)}`,
    bodyHtml: `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <div><strong>اسم المستخدم:</strong> ${escapeHtml(t.username || "—")}</div>
            <div><strong>البريد:</strong> ${escapeHtml(t.email || "—")}</div>
            <div><strong>الحالة:</strong> ${t.status === "active" ? '<span class="badge badge-success">نشط</span>' : '<span class="badge badge-muted">معطّل</span>'}</div>
          </div>
          <button class="btn btn-sm btn-primary" id="resetPwdBtn">🔑 إعادة تعيين كلمة المرور</button>
        </div>
      </div>
      <div class="card">
        <h4>التعيينات الحالية</h4>
        <div id="assignList">
          ${myAssign.length ? myAssign.map(a => `
            <div class="list-item">
              <div class="list-item-title">${escapeHtml(subjectName(a.subject_id))} — ${escapeHtml(className(a.class_id))} / ${escapeHtml(sectionName(a.section_id))}</div>
              <button class="btn btn-sm btn-danger" data-remove="${a.id}">حذف</button>
            </div>`).join("") : `<div class="empty-state">لا توجد تعيينات</div>`}
        </div>
        <h4 style="margin-top:16px">إضافة تعيين</h4>
        <div class="form-grid">
          <div class="field"><label>المادة</label>
            <select id="aSubj">${state.subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select></div>
          <div class="field"><label>الصف</label>
            <select id="aClass">${state.classes.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select></div>
          <div class="field"><label>الفصل</label>
            <select id="aSection">${state.sections.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(className(s.class_id))})</option>`).join("")}</select></div>
        </div>
        <button class="btn btn-primary" id="addAssignBtn" style="margin-top:10px">إضافة تعيين</button>
      </div>
    `,
    footerHtml: `
      <button class="btn" data-close>إغلاق</button>
      <button class="btn btn-primary" id="editTeacherBtn">تعديل البيانات</button>
    `,
    onMount: () => {
      $$("[data-remove]").forEach(b => b.onclick = async () => {
        const id = b.dataset.remove;
        await idb.delete("teacher_assignments", id);
        await enqueue({ entity: "teacher_assignments", record_id: id, operation_type: "delete", payload: null, school_id: t.school_id });
        await loadAllLocal();
        hideModal();
        openTeacherPanel(teacherId);
      });
      $("#addAssignBtn").onclick = async () => {
        const row = {
          id: uuid(),
          school_id: t.school_id,
          teacher_id: teacherId,
          subject_id: $("#aSubj").value,
          class_id: $("#aClass").value,
          section_id: $("#aSection").value,
          created_at: new Date().toISOString()
        };
        await idb.put("teacher_assignments", row);
        await enqueue({ entity: "teacher_assignments", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });
        await loadAllLocal();
        hideModal();
        openTeacherPanel(teacherId);
      };
      $("#editTeacherBtn").onclick = () => { hideModal(); openTeacherForm(t); };
      $("#resetPwdBtn").onclick = () => openResetPasswordDialog(t);
    }
  });
}

function openResetPasswordDialog(teacher) {
  showModal({
    title: `إعادة تعيين كلمة مرور — ${escapeHtml(teacher.full_name)}`,
    bodyHtml: `
      <p class="muted">سيتم تعيين كلمة مرور مؤقتة، وسيُطلب من المعلم تغييرها عند أول دخول.</p>
      <div class="form-grid">
        <div class="field"><label>كلمة المرور المؤقتة الجديدة</label><input type="text" id="resetPwdVal" /></div>
        <div class="field"><label>تأكيد</label><input type="text" id="resetPwdVal2" /></div>
      </div>
      <div id="resetPwdError" class="error-msg" hidden></div>
    `,
    footerHtml: `
      <button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="confirmResetBtn">تعيين</button>
    `,
    onMount: () => {
      $("#confirmResetBtn").onclick = async () => {
        const p1 = $("#resetPwdVal").value;
        const p2 = $("#resetPwdVal2").value;
        const err = $("#resetPwdError");
        err.hidden = true;
        if (!p1 || p1.length < 6) { err.hidden = false; err.textContent = "كلمة المرور 6 أحرف على الأقل"; return; }
        if (p1 !== p2) { err.hidden = false; err.textContent = "غير متطابقتين"; return; }
        if (!isOnline()) { err.hidden = false; err.textContent = "يتطلب الاتصال بالإنترنت"; return; }
        try {
          await callResetTeacherPassword(teacher.id, p1);
          toast("تم تعيين كلمة مرور مؤقتة", "success");
          hideModal();
        } catch (e) {
          err.hidden = false;
          err.textContent = e.message;
        }
      };
    }
  });
}

/* ===== Grades ===== */
let _gradesPagination = { page: 1, pageSize: 25, filter: "" };

async function renderGrades(c) {
  const role = state.session.role;
  const myStudents = role === "admin" ? state.students : teacherStudents();
  const myGrades = state.grades.filter(g => myStudents.some(s => s.id === g.student_id));

  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="gradesSearch" class="search-input" placeholder="ابحث بالاسم أو رقم المتابعة أو الصف أو الفصل أو المادة" />
        <button id="addGradeBtn" class="btn btn-primary">➕ إضافة درجة</button>
      </div>
      <div class="table-wrap">
        <table class="data" id="gradesTable">
          <thead><tr><th>التاريخ</th><th>الطالب</th><th>رقم المتابعة</th><th>المادة</th><th>النوع</th><th>الدرجة</th><th>المعلم</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="row" style="justify-content:space-between; margin-top:12px">
        <span id="gradesCount" class="muted small"></span>
        <div class="row">
          <button class="btn btn-sm" id="gradesPrev">◀ السابق</button>
          <span id="gradesPage" class="muted small"></span>
          <button class="btn btn-sm" id="gradesNext">التالي ▶</button>
        </div>
      </div>
    </div>`;

  const renderRows = (filter = "") => {
    const rows = myGrades.filter(g => {
      if (!filter) return true;
      const st = state.students.find(s => s.id === g.student_id);
      if (!st) return false;
      return arabicIncludes(st.full_name, filter)
        || String(st.tracking_number || "").includes(filter.trim())
        || arabicIncludes(className(st.class_id), filter)
        || arabicIncludes(sectionName(st.section_id), filter)
        || arabicIncludes(subjectName(g.subject_id), filter);
    }).sort((a, b) => b.date.localeCompare(a.date));

    const pageSize = _gradesPagination.pageSize;
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (_gradesPagination.page > pages) _gradesPagination.page = pages;
    const start = (_gradesPagination.page - 1) * pageSize;
    const paged = rows.slice(start, start + pageSize);

    const tbody = $("#gradesTable tbody");
    if (!paged.length) { tbody.innerHTML = `<tr><td colspan="8" class="empty-state">لا نتائج</td></tr>`; }
    else {
      tbody.innerHTML = paged.map(g => {
        const st = state.students.find(s => s.id === g.student_id);
        return `<tr>
          <td>${fmtDate(g.date)}</td>
          <td>${escapeHtml(st?.full_name || "—")}</td>
          <td><span class="badge badge-info">${escapeHtml(st?.tracking_number || "—")}</span></td>
          <td>${escapeHtml(subjectName(g.subject_id))}</td>
          <td>${escapeHtml(g.assessment_type)}</td>
          <td>${g.score}/${g.max_score}</td>
          <td>${escapeHtml(teacherName(g.teacher_id))}</td>
          <td><button class="btn btn-sm btn-danger" data-del="${g.id}">حذف</button></td>
        </tr>`;
      }).join("");
      tbody.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
        const id = b.dataset.del;
        const row = state.grades.find(x => x.id === id);
        await idb.delete("grades", id);
        await enqueue({ entity: "grades", record_id: id, operation_type: "delete", payload: null, school_id: row.school_id });
        await loadAllLocal();
        toast("تم الحذف", "success");
        navigate("grades");
      });
    }
    $("#gradesCount").textContent = `إجمالي: ${total}`;
    $("#gradesPage").textContent = `صفحة ${_gradesPagination.page} من ${pages}`;
    $("#gradesPrev").disabled = _gradesPagination.page <= 1;
    $("#gradesNext").disabled = _gradesPagination.page >= pages;
  };

  $("#gradesSearch").oninput = debounce(e => {
    _gradesPagination.filter = e.target.value;
    _gradesPagination.page = 1;
    renderRows(e.target.value);
  }, 200);
  $("#gradesPrev").onclick = () => { _gradesPagination.page--; renderRows(_gradesPagination.filter); };
  $("#gradesNext").onclick = () => { _gradesPagination.page++; renderRows(_gradesPagination.filter); };
  renderRows("");
  $("#addGradeBtn").onclick = () => openGradeForm();
}

async function openGradeForm() {
  const role = state.session.role;
  const myStudents = role === "admin" ? state.students.filter(s => s.status === "active") : teacherStudents().filter(s => s.status === "active");
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  const mySubjects = role === "admin"
    ? state.subjects
    : state.subjects.filter(s => state.assignments.some(a => a.teacher_id === me?.id && a.subject_id === s.id));

  showModal({
    title: "إضافة درجة",
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>الطالب</label>
          <select id="grStudent">${myStudents.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)} — ${escapeHtml(s.tracking_number)}</option>`).join("")}</select></div>
        <div class="field"><label>المادة</label>
          <select id="grSubject">${mySubjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select></div>
        <div class="field"><label>نوع التقييم</label>
          <select id="grType">
            <option value="اختبار شهري">اختبار شهري</option>
            <option value="اختبار نهائي">اختبار نهائي</option>
            <option value="واجب">واجب</option>
            <option value="مشاركة">مشاركة</option>
            <option value="مشروع">مشروع</option>
          </select></div>
        <div class="field"><label>الدرجة</label><input id="grScore" type="number" step="0.01" /></div>
        <div class="field"><label>الدرجة الكاملة</label><input id="grMax" type="number" step="0.01" value="100" /></div>
        <div class="field"><label>التاريخ</label><input id="grDate" type="date" value="${todayISO()}" /></div>
      </div>`,
    footerHtml: `<button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveGradeBtn">حفظ</button>`,
    onMount: () => {
      $("#saveGradeBtn").onclick = async () => {
        const score = parseFloat($("#grScore").value);
        const max = parseFloat($("#grMax").value);
        if (isNaN(score) || isNaN(max) || max <= 0) { toast("درجة غير صحيحة", "error"); return; }
        if (score > max) { toast("الدرجة أكبر من الدرجة الكاملة", "error"); return; }
        const studentId = $("#grStudent").value;
        const st = state.students.find(s => s.id === studentId);
        const row = {
          id: uuid(),
          school_id: state.session.school_id,
          student_id: studentId,
          subject_id: $("#grSubject").value,
          teacher_id: me?.id || null,
          class_id: st?.class_id || null,
          section_id: st?.section_id || null,
          assessment_type: $("#grType").value,
          score, max_score: max,
          date: $("#grDate").value,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await idb.put("grades", row);
        await enqueue({ entity: "grades", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });
        hideModal();
        await loadAllLocal();
        toast("تم حفظ الدرجة", "success");
        navigate("grades");
      };
    }
  });
}

/* ===== Schedule ===== */
let _scheduleView = "list";

async function renderSchedule(c) {
  const role = state.session.role;
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  const all = role === "admin" ? state.schedules : state.schedules.filter(s => s.teacher_id === me?.id);

  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="scheduleSearch" class="search-input" placeholder="ابحث بالمعلم أو المادة أو الصف أو الفصل أو اليوم" />
        <div class="view-toggle">
          <button class="view-btn ${_scheduleView === "list" ? "active" : ""}" data-view="list">📋 قائمة</button>
          <button class="view-btn ${_scheduleView === "grid" ? "active" : ""}" data-view="grid">🗓️ شبكة</button>
        </div>
        ${role === "admin" ? `
          <button class="btn btn-primary" id="addScheduleBtn">➕ حصة جديدة</button>
          <button class="btn" id="printAllSchedulesBtn">🖨️ طباعة الجداول</button>
        ` : `
          <button class="btn" id="printMyScheduleBtn">🖨️ طباعة جدولي</button>
        `}
        <button class="btn" id="exportScheduleBtn">📥 تصدير Excel</button>
      </div>
      <div id="scheduleContent"></div>
    </div>`;

  let currentFilter = "";

  const filterSchedules = (rows, filter) => {
    if (!filter) return rows;
    return rows.filter(s => {
      return arabicIncludes(teacherName(s.teacher_id), filter)
        || arabicIncludes(subjectName(s.subject_id), filter)
        || arabicIncludes(className(s.class_id), filter)
        || arabicIncludes(sectionName(s.section_id), filter)
        || arabicIncludes(DAYS_AR[s.day_of_week], filter);
    });
  };

  const sortSchedules = (rows) => rows.slice().sort((a, b) =>
    (a.day_of_week - b.day_of_week) || (a.start_time || "").localeCompare(b.start_time || "")
  );

  const renderContent = () => {
    const container = $("#scheduleContent");
    const filtered = filterSchedules(all, currentFilter);
    if (!filtered.length) { container.innerHTML = `<div class="empty-state">لا توجد حصص</div>`; return; }
    if (_scheduleView === "grid") renderGridView(container, filtered, role);
    else renderListView(container, filtered, role);
  };

  const renderListView = (container, rows, role) => {
    const sorted = sortSchedules(rows);
    container.innerHTML = `
      <div class="table-wrap">
        <table class="data" id="scheduleTable">
          <thead><tr>
            <th>اليوم</th><th>الوقت</th><th>المادة</th><th>المعلم</th><th>الصف</th><th>الفصل</th><th></th>
          </tr></thead>
          <tbody>
            ${sorted.map(s => `
              <tr>
                <td>${DAYS_AR[s.day_of_week]}</td>
                <td><strong>${escapeHtml(s.start_time)} — ${escapeHtml(s.end_time)}</strong></td>
                <td>${escapeHtml(subjectName(s.subject_id))}</td>
                <td>${escapeHtml(teacherName(s.teacher_id))}</td>
                <td>${escapeHtml(className(s.class_id))}</td>
                <td>${escapeHtml(sectionName(s.section_id))}</td>
                <td>${role === "admin" ? `<button class="btn btn-sm btn-danger" data-del="${s.id}">×</button>` : ""}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
    container.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      const id = b.dataset.del;
      const row = state.schedules.find(x => x.id === id);
      if (!confirm("هل تريد حذف هذه الحصة؟")) return;
      await idb.delete("schedules", id);
      await enqueue({ entity: "schedules", record_id: id, operation_type: "delete", payload: null, school_id: row.school_id });
      await loadAllLocal();
      toast("تم الحذف", "success");
      navigate("schedule");
    });
  };

  const renderGridView = (container, rows, role) => {
    const timesSet = new Set();
    rows.forEach(s => timesSet.add(`${s.start_time}-${s.end_time}`));
    const times = Array.from(timesSet).sort((a, b) => a.split("-")[0].localeCompare(b.split("-")[0]));
    if (!times.length) { container.innerHTML = `<div class="empty-state">لا حصص</div>`; return; }

    const grid = {};
    for (const t of times) {
      grid[t] = {};
      for (let d = 0; d < 7; d++) grid[t][d] = [];
    }
    rows.forEach(s => {
      const t = `${s.start_time}-${s.end_time}`;
      if (!grid[t]) return;
      grid[t][s.day_of_week].push(s);
    });

    const activeDays = [];
    for (let d = 0; d < 7; d++) if (rows.some(s => s.day_of_week === d)) activeDays.push(d);

    container.innerHTML = `
      <div class="schedule-grid-wrap">
        <table class="schedule-grid">
          <thead>
            <tr>
              <th class="grid-time-col">الوقت</th>
              ${activeDays.map(d => `<th>${DAYS_AR[d]}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${times.map(t => `
              <tr>
                <td class="grid-time-col"><strong>${escapeHtml(t.split("-")[0])}</strong><br><span class="muted small">${escapeHtml(t.split("-")[1])}</span></td>
                ${activeDays.map(d => {
                  const cell = grid[t][d];
                  if (!cell.length) return `<td class="grid-cell empty"></td>`;
                  return `<td class="grid-cell has-class">
                    ${cell.map(s => `
                      <div class="grid-class">
                        <div class="grid-class-subject">${escapeHtml(subjectName(s.subject_id))}</div>
                        ${role === "admin" ? `<div class="grid-class-meta">${escapeHtml(teacherName(s.teacher_id))}</div>` : ""}
                        <div class="grid-class-meta">${escapeHtml(className(s.class_id))} / ${escapeHtml(sectionName(s.section_id))}</div>
                      </div>`).join("")}
                  </td>`;
                }).join("")}
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  };

  $("#scheduleSearch").oninput = debounce(e => {
    currentFilter = e.target.value;
    renderContent();
  }, 200);

  $$(".view-btn").forEach(btn => {
    btn.onclick = () => {
      _scheduleView = btn.dataset.view;
      $$(".view-btn").forEach(b => b.classList.toggle("active", b.dataset.view === _scheduleView));
      renderContent();
    };
  });

  const addBtn = $("#addScheduleBtn");
  if (addBtn) addBtn.onclick = () => openScheduleForm();

  const printAllBtn = $("#printAllSchedulesBtn");
  if (printAllBtn) printAllBtn.onclick = () => openPrintAllSchedules();

  const printMineBtn = $("#printMyScheduleBtn");
  if (printMineBtn) printMineBtn.onclick = () => openPrintSingleSchedule(me?.id);

  $("#exportScheduleBtn").onclick = () => {
    const rows = filterSchedules(all, currentFilter);
    if (!rows.length) { toast("لا بيانات للتصدير", "warning"); return; }
    const sorted = sortSchedules(rows);
    const data = [["اليوم","من","إلى","المادة","المعلم","الصف","الفصل"]];
    sorted.forEach(s => data.push([
      DAYS_AR[s.day_of_week], s.start_time, s.end_time,
      subjectName(s.subject_id), teacherName(s.teacher_id),
      className(s.class_id), sectionName(s.section_id)
    ]));
    const stamp = new Date().toISOString().slice(0, 10);
    const school = (state.school?.name || "school").replace(/[^\w\u0600-\u06FF-]+/g, "_");
    downloadCSV(`${school}-الجدول-${stamp}.csv`, data);
    toast(`تم تصدير ${sorted.length} حصة`, "success");
  };

  renderContent();
}

function checkScheduleConflicts({ teacherId, classId, sectionId, day, start, end, excludeId }) {
  const conflicts = [];
  const overlapping = state.schedules.filter(s => {
    if (excludeId && s.id === excludeId) return false;
    if (s.day_of_week !== day) return false;
    return start < s.end_time && end > s.start_time;
  });
  for (const s of overlapping) {
    if (s.teacher_id === teacherId) {
      conflicts.push(`المعلم مشغول: ${subjectName(s.subject_id)} — ${className(s.class_id)}/${sectionName(s.section_id)} (${s.start_time}-${s.end_time})`);
    }
    if (s.class_id === classId && s.section_id === sectionId) {
      conflicts.push(`الفصل مشغول: ${subjectName(s.subject_id)} مع ${teacherName(s.teacher_id)} (${s.start_time}-${s.end_time})`);
    }
  }
  return conflicts;
}

async function openScheduleForm() {
  if (state.session.role !== "admin") { toast("لا تملك صلاحية", "error"); return; }
  const teachers = state.teachers.filter(t => t.status === "active");
  if (!teachers.length) { toast("لا يوجد معلمون نشطون", "warning"); return; }

  showModal({
    title: "➕ إضافة حصة جديدة",
    bodyHtml: `
      <div class="form-grid">
        <div class="field" style="grid-column:1/-1">
          <label>1. المعلم</label>
          <select id="scTeacher">
            <option value="">— اختر المعلم —</option>
            ${teachers.map(t => `<option value="${t.id}">${escapeHtml(t.full_name)}</option>`).join("")}
          </select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>2. المادة (من مواد هذا المعلم)</label>
          <select id="scSubject" disabled><option value="">— اختر المعلم أولًا —</option></select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>3. الصف (من صفوفه في هذه المادة)</label>
          <select id="scClass" disabled><option value="">— اختر المادة أولًا —</option></select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>4. الفصل</label>
          <select id="scSection" disabled><option value="">— اختر الصف أولًا —</option></select>
        </div>
        <div class="field"><label>5. اليوم</label>
          <select id="scDay">
            ${DAYS_AR.map((d, i) => `<option value="${i}">${d}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>من الساعة</label><input type="time" id="scStart" value="08:00" /></div>
        <div class="field"><label>إلى الساعة</label><input type="time" id="scEnd" value="08:45" /></div>
      </div>
      <div id="scConflict" class="error-msg" hidden></div>
    `,
    footerHtml: `
      <button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveScBtn">حفظ الحصة</button>
    `,
    onMount: () => {
      const tSel = $("#scTeacher");
      const subjSel = $("#scSubject");
      const classSel = $("#scClass");
      const secSel = $("#scSection");
      const conflictEl = $("#scConflict");

      tSel.onchange = () => {
        const tid = tSel.value;
        if (!tid) {
          subjSel.innerHTML = `<option value="">— اختر المعلم أولًا —</option>`; subjSel.disabled = true;
          classSel.innerHTML = `<option value="">— اختر المادة أولًا —</option>`; classSel.disabled = true;
          secSel.innerHTML = `<option value="">— اختر الصف أولًا —</option>`; secSel.disabled = true;
          return;
        }
        const myAssigns = state.assignments.filter(a => a.teacher_id === tid);
        const subjectIds = Array.from(new Set(myAssigns.map(a => a.subject_id)));
        const subjects = state.subjects.filter(s => subjectIds.includes(s.id));
        subjSel.innerHTML = `<option value="">— اختر المادة —</option>` + subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
        subjSel.disabled = false;
        classSel.innerHTML = `<option value="">— اختر المادة أولًا —</option>`; classSel.disabled = true;
        secSel.innerHTML = `<option value="">— اختر الصف أولًا —</option>`; secSel.disabled = true;
      };

      subjSel.onchange = () => {
        const tid = tSel.value, sid = subjSel.value;
        if (!sid) {
          classSel.innerHTML = `<option value="">— اختر المادة أولًا —</option>`; classSel.disabled = true;
          secSel.innerHTML = `<option value="">— اختر الصف أولًا —</option>`; secSel.disabled = true;
          return;
        }
        const myAssigns = state.assignments.filter(a => a.teacher_id === tid && a.subject_id === sid);
        const classIds = Array.from(new Set(myAssigns.map(a => a.class_id)));
        const classes = state.classes.filter(c => classIds.includes(c.id));
        classSel.innerHTML = `<option value="">— اختر الصف —</option>` + classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
        classSel.disabled = false;
        secSel.innerHTML = `<option value="">— اختر الصف أولًا —</option>`; secSel.disabled = true;
      };

      classSel.onchange = () => {
        const tid = tSel.value, sid = subjSel.value, cid = classSel.value;
        if (!cid) { secSel.innerHTML = `<option value="">— اختر الصف أولًا —</option>`; secSel.disabled = true; return; }
        const myAssigns = state.assignments.filter(a => a.teacher_id === tid && a.subject_id === sid && a.class_id === cid);
        const secIds = Array.from(new Set(myAssigns.map(a => a.section_id)));
        const sections = state.sections.filter(s => secIds.includes(s.id));
        secSel.innerHTML = `<option value="">— اختر الفصل —</option>` + sections.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
        secSel.disabled = false;
      };

      $("#saveScBtn").onclick = async () => {
        conflictEl.hidden = true;
        const teacherId = tSel.value;
        const subjectId = subjSel.value;
        const classId = classSel.value;
        const sectionId = secSel.value;
        const day = parseInt($("#scDay").value, 10);
        const start = $("#scStart").value;
        const end = $("#scEnd").value;

        if (!teacherId || !subjectId || !classId || !sectionId) {
          conflictEl.hidden = false; conflictEl.textContent = "أكمل جميع الحقول"; return;
        }
        if (start >= end) {
          conflictEl.hidden = false; conflictEl.textContent = "وقت البداية يجب أن يكون قبل النهاية"; return;
        }

        const validAssign = state.assignments.find(a =>
          a.teacher_id === teacherId && a.subject_id === subjectId && a.class_id === classId && a.section_id === sectionId
        );
        if (!validAssign) {
          conflictEl.hidden = false; conflictEl.textContent = "المعلم غير معيَّن لهذه المادة/الفصل. راجع التعيينات."; return;
        }

        const conflicts = checkScheduleConflicts({ teacherId, classId, sectionId, day, start, end, excludeId: null });
        if (conflicts.length) {
          conflictEl.hidden = false;
          conflictEl.innerHTML = "⚠️ يوجد تعارض:<br>" + conflicts.map(c => "• " + c).join("<br>");
          return;
        }

        const row = {
          id: uuid(),
          school_id: state.session.school_id,
          teacher_id: teacherId, subject_id: subjectId,
          class_id: classId, section_id: sectionId,
          day_of_week: day, start_time: start, end_time: end,
          created_at: new Date().toISOString()
        };
        await idb.put("schedules", row);
        await enqueue({ entity: "schedules", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });
        hideModal();
        await loadAllLocal();
        toast("تم إضافة الحصة", "success");
        navigate("schedule");
      };
    }
  });
}

/* ===== Schedule print ===== */
function printHTMLContent(html, title) {
  const w = window.open("", "_blank");
  w.document.write(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8" />
      <title>${escapeHtml(title)}</title>
      <style>
        body { font-family: "Segoe UI", Tahoma, sans-serif; padding: 20px; color: #000; }
        .print-header { text-align: center; margin-bottom: 16px; }
        .print-school { font-size: 20px; font-weight: 800; color: #0f766e; }
        .print-title { font-size: 15px; font-weight: 700; margin: 4px 0; }
        .print-meta { display: flex; gap: 20px; justify-content: center; font-size: 13px; color: #333; flex-wrap: wrap; margin-top: 4px; }
        table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 10px; }
        th, td { border: 1px solid #999; padding: 5px 7px; text-align: right; }
        th { background: #f0f0f0; }
        .print-footer { display: flex; justify-content: space-between; margin-top: 14px; font-size: 11px; color: #555; }
        @media print { @page { size: A4 portrait; margin: 10mm; } body { padding: 0; } }
      </style>
    </head>
    <body>${html}</body>
    </html>
  `);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 300);
}

function openPrintSingleSchedule(teacherId) {
  if (!teacherId) { toast("اختر معلمًا", "warning"); return; }
  const teacher = state.teachers.find(t => t.id === teacherId);
  const schedules = state.schedules.filter(s => s.teacher_id === teacherId)
    .sort((a, b) => (a.day_of_week - b.day_of_week) || (a.start_time || "").localeCompare(b.start_time || ""));
  if (!schedules.length) { toast("لا حصص لهذا المعلم", "warning"); return; }

  const schoolName = state.school?.name || "المدرسة";
  const today = new Date().toLocaleDateString("ar-EG");
  const html = `
    <div class="print-sheet">
      <div class="print-header">
        <div class="print-school">${escapeHtml(schoolName)}</div>
        <div class="print-title">جدول المعلم</div>
        <div class="print-meta"><span><strong>${escapeHtml(teacher?.full_name || "—")}</strong></span><span>التاريخ: ${today}</span></div>
      </div>
      <table class="print-table" style="width:100%">
        <thead><tr><th>اليوم</th><th>الوقت</th><th>المادة</th><th>الصف</th><th>الفصل</th></tr></thead>
        <tbody>
          ${schedules.map(s => `
            <tr>
              <td>${DAYS_AR[s.day_of_week]}</td>
              <td>${escapeHtml(s.start_time)} - ${escapeHtml(s.end_time)}</td>
              <td>${escapeHtml(subjectName(s.subject_id))}</td>
              <td>${escapeHtml(className(s.class_id))}</td>
              <td>${escapeHtml(sectionName(s.section_id))}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <div class="print-footer">
        <div>تم الإنشاء: ${new Date().toLocaleString("ar-EG")}</div>
        <div>عدد الحصص: ${schedules.length}</div>
      </div>
    </div>`;
  printHTMLContent(html, `جدول ${teacher?.full_name || ""}`);
}

function openPrintAllSchedules() {
  const byTeacher = {};
  for (const s of state.schedules) {
    if (!byTeacher[s.teacher_id]) byTeacher[s.teacher_id] = [];
    byTeacher[s.teacher_id].push(s);
  }
  const teacherIds = Object.keys(byTeacher);
  if (!teacherIds.length) { toast("لا حصص", "warning"); return; }
  const schoolName = state.school?.name || "المدرسة";
  const today = new Date().toLocaleDateString("ar-EG");

  let html = `
    <div class="print-sheet">
      <div class="print-header">
        <div class="print-school">${escapeHtml(schoolName)}</div>
        <div class="print-title">جداول المعلمين الأسبوعية</div>
        <div class="print-meta"><span>التاريخ: ${today}</span></div>
      </div>`;

  for (const tid of teacherIds) {
    const t = state.teachers.find(x => x.id === tid);
    const items = byTeacher[tid].sort((a, b) => (a.day_of_week - b.day_of_week) || (a.start_time || "").localeCompare(b.start_time || ""));
    html += `
      <div style="page-break-after: always; margin-top:20px">
        <h3 style="color:#0f766e; text-align:center; margin:10px 0">${escapeHtml(t?.full_name || "—")}</h3>
        <table class="print-table" style="width:100%">
          <thead><tr><th>اليوم</th><th>الوقت</th><th>المادة</th><th>الصف</th><th>الفصل</th></tr></thead>
          <tbody>
            ${items.map(s => `
              <tr>
                <td>${DAYS_AR[s.day_of_week]}</td>
                <td>${escapeHtml(s.start_time)} - ${escapeHtml(s.end_time)}</td>
                <td>${escapeHtml(subjectName(s.subject_id))}</td>
                <td>${escapeHtml(className(s.class_id))}</td>
                <td>${escapeHtml(sectionName(s.section_id))}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }
  html += `</div>`;
  printHTMLContent(html, "جداول المعلمين");
}

/* ===== Attendance ===== */
let _attendanceFilters = { search: "", from: "", to: "", classId: "", sectionId: "", status: "", page: 1, pageSize: 30 };

async function renderAttendance(c) {
  const role = state.session.role;
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  const myStudents = role === "admin" ? state.students : teacherStudents();

  let allowedSections = state.sections;
  if (role === "teacher") {
    const allowedIds = new Set(state.assignments.filter(a => a.teacher_id === me?.id).map(a => a.section_id));
    allowedSections = state.sections.filter(s => allowedIds.has(s.id));
  }
  const allowedClassIds = new Set(allowedSections.map(s => s.class_id));
  const allowedClasses = state.classes.filter(c => allowedClassIds.has(c.id));

  c.innerHTML = `
    <div class="card">
      <div class="toolbar" style="margin-bottom:8px">
        <input id="attSearch" class="search-input" placeholder="ابحث بالاسم أو رقم المتابعة" />
        <button id="addAttBtn" class="btn btn-primary">➕ تسجيل حضور</button>
      </div>
      <div class="form-grid" style="margin-bottom:12px">
        <div class="field"><label>من تاريخ</label><input type="date" id="attFrom" /></div>
        <div class="field"><label>إلى تاريخ</label><input type="date" id="attTo" /></div>
        <div class="field"><label>الصف</label>
          <select id="attFilterClass"><option value="">كل الصفوف</option>
            ${allowedClasses.map(cl => `<option value="${cl.id}">${escapeHtml(cl.name)}</option>`).join("")}</select></div>
        <div class="field"><label>الفصل</label>
          <select id="attFilterSection"><option value="">كل الفصول</option>
            ${allowedSections.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(className(s.class_id))})</option>`).join("")}</select></div>
        <div class="field"><label>الحالة</label>
          <select id="attFilterStatus">
            <option value="">الكل</option>
            <option value="present">حاضر</option>
            <option value="late">متأخر</option>
            <option value="absent">غائب</option>
          </select></div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <button class="btn btn-sm" id="attClearBtn">مسح الفلاتر</button>
        <button class="btn btn-sm btn-primary" id="attExportBtn">📥 تصدير Excel</button>
        <button class="btn btn-sm" id="attPrintBtn">🖨️ طباعة كشف</button>
        <button class="btn btn-sm" id="attStatsBtn">📊 إحصائيات الطلاب</button>
        <span id="attStats" class="muted small"></span>
      </div>
      <div class="table-wrap">
        <table class="data" id="attTable">
          <thead><tr><th>التاريخ</th><th>الطالب</th><th>رقم المتابعة</th><th>الصف</th><th>الفصل</th><th>الحالة</th><th>المعلم</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="row" style="justify-content:space-between; margin-top:12px">
        <span id="attCount" class="muted small"></span>
        <div class="row">
          <button class="btn btn-sm" id="attPrev">◀ السابق</button>
          <span id="attPage" class="muted small"></span>
          <button class="btn btn-sm" id="attNext">التالي ▶</button>
        </div>
      </div>
    </div>`;

  const readFilters = () => {
    _attendanceFilters.search = $("#attSearch").value.trim();
    _attendanceFilters.from = $("#attFrom").value || "";
    _attendanceFilters.to = $("#attTo").value || "";
    _attendanceFilters.classId = $("#attFilterClass").value || "";
    _attendanceFilters.sectionId = $("#attFilterSection").value || "";
    _attendanceFilters.status = $("#attFilterStatus").value || "";
  };

  const renderRows = () => {
    readFilters();
    const f = _attendanceFilters;
    const myStudentIds = new Set(myStudents.map(s => s.id));
    const rows = state.attendance.filter(a => {
      if (!myStudentIds.has(a.student_id)) return false;
      if (f.status && a.status !== f.status) return false;
      if (f.from && a.date < f.from) return false;
      if (f.to && a.date > f.to) return false;
      const st = state.students.find(s => s.id === a.student_id);
      if (!st) return false;
      if (f.classId && st.class_id !== f.classId) return false;
      if (f.sectionId && st.section_id !== f.sectionId) return false;
      if (f.search) {
        if (!arabicIncludes(st.full_name, f.search) && !String(st.tracking_number || "").includes(f.search.trim())) return false;
      }
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));

    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / f.pageSize));
    if (f.page > pages) f.page = pages;
    const start = (f.page - 1) * f.pageSize;
    const paged = rows.slice(start, start + f.pageSize);

    const totalPresent = rows.filter(a => a.status === "present").length;
    const totalLate = rows.filter(a => a.status === "late").length;
    const totalAbsent = rows.filter(a => a.status === "absent").length;
    $("#attStats").innerHTML =
      `<span class="badge badge-success">حاضر: ${totalPresent}</span> ` +
      `<span class="badge badge-warning">متأخر: ${totalLate}</span> ` +
      `<span class="badge badge-danger">غائب: ${totalAbsent}</span>`;

    const tbody = $("#attTable tbody");
    if (!paged.length) { tbody.innerHTML = `<tr><td colspan="7" class="empty-state">لا نتائج</td></tr>`; }
    else {
      tbody.innerHTML = paged.map(a => {
        const st = state.students.find(s => s.id === a.student_id);
        const cls = a.status === "present" ? "badge-success" : a.status === "late" ? "badge-warning" : "badge-danger";
        const label = a.status === "present" ? "حاضر" : a.status === "late" ? "متأخر" : "غائب";
        return `<tr>
          <td>${fmtDate(a.date)}</td>
          <td>${escapeHtml(st?.full_name || "—")}</td>
          <td><span class="badge badge-info">${escapeHtml(st?.tracking_number || "—")}</span></td>
          <td>${escapeHtml(className(st?.class_id))}</td>
          <td>${escapeHtml(sectionName(st?.section_id))}</td>
          <td><span class="badge ${cls}">${label}</span></td>
          <td class="muted small">${escapeHtml(teacherName(a.teacher_id))}</td>
        </tr>`;
      }).join("");
    }

    $("#attCount").textContent = `إجمالي: ${total}`;
    $("#attPage").textContent = `صفحة ${f.page} من ${pages}`;
    $("#attPrev").disabled = f.page <= 1;
    $("#attNext").disabled = f.page >= pages;
  };

  const debouncedRender = debounce(() => { _attendanceFilters.page = 1; renderRows(); }, 220);
  $("#attSearch").oninput = debouncedRender;
  $("#attFrom").onchange = () => { _attendanceFilters.page = 1; renderRows(); };
  $("#attTo").onchange = () => { _attendanceFilters.page = 1; renderRows(); };
  $("#attFilterClass").onchange = () => { _attendanceFilters.page = 1; renderRows(); };
  $("#attFilterSection").onchange = () => { _attendanceFilters.page = 1; renderRows(); };
  $("#attFilterStatus").onchange = () => { _attendanceFilters.page = 1; renderRows(); };
  $("#attClearBtn").onclick = () => {
    $("#attSearch").value = ""; $("#attFrom").value = ""; $("#attTo").value = "";
    $("#attFilterClass").value = ""; $("#attFilterSection").value = ""; $("#attFilterStatus").value = "";
    _attendanceFilters.page = 1;
    renderRows();
  };
  $("#attPrev").onclick = () => { _attendanceFilters.page--; renderRows(); };
  $("#attNext").onclick = () => { _attendanceFilters.page++; renderRows(); };

  $("#attExportBtn").onclick = () => {
    readFilters();
    const f = _attendanceFilters;
    const myStudentIds = new Set(myStudents.map(s => s.id));
    const rows = state.attendance.filter(a => {
      if (!myStudentIds.has(a.student_id)) return false;
      if (f.status && a.status !== f.status) return false;
      if (f.from && a.date < f.from) return false;
      if (f.to && a.date > f.to) return false;
      const st = state.students.find(s => s.id === a.student_id);
      if (!st) return false;
      if (f.classId && st.class_id !== f.classId) return false;
      if (f.sectionId && st.section_id !== f.sectionId) return false;
      if (f.search) {
        if (!arabicIncludes(st.full_name, f.search) && !String(st.tracking_number || "").includes(f.search.trim())) return false;
      }
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));

    if (!rows.length) { toast("لا توجد بيانات للتصدير", "warning"); return; }

    const headers = ["التاريخ","الطالب","رقم المتابعة","الصف","الفصل","الحالة","المعلم"];
    const data = [headers];
    rows.forEach(a => {
      const st = state.students.find(s => s.id === a.student_id);
      const status = a.status === "present" ? "حاضر" : a.status === "late" ? "متأخر" : "غائب";
      data.push([a.date, st?.full_name || "", st?.tracking_number || "", className(st?.class_id), sectionName(st?.section_id), status, teacherName(a.teacher_id)]);
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(`attendance-${stamp}.csv`, data);
    toast(`تم تصدير ${rows.length} سجل`, "success");
  };

  $("#attStatsBtn").onclick = () => openAttendanceStats(myStudents, allowedClasses, allowedSections);
  $("#attPrintBtn").onclick = () => openAttendancePrintDialog(myStudents, allowedClasses, allowedSections);

  renderRows();
  $("#addAttBtn").onclick = () => openAttendanceForm();
}

async function openAttendanceForm() {
  const role = state.session.role;
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);

  let allowedSections = state.sections;
  if (role === "teacher") {
    const allowedIds = new Set(state.assignments.filter(a => a.teacher_id === me?.id).map(a => a.section_id));
    allowedSections = state.sections.filter(s => allowedIds.has(s.id));
  }
  const allowedClassIds = new Set(allowedSections.map(s => s.class_id));
  const allowedClasses = state.classes.filter(c => allowedClassIds.has(c.id));

  showModal({
    title: "تسجيل الحضور",
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>التاريخ</label><input type="date" id="attDate" value="${todayISO()}" /></div>
        <div class="field"><label>الصف</label>
          <select id="attClass">
            <option value="">— اختر الصف —</option>
            ${allowedClasses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
          </select></div>
        <div class="field"><label>الفصل</label>
          <select id="attSection" disabled><option value="">— اختر الصف أولًا —</option></select></div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn btn-primary" id="loadStudentsBtn" disabled>عرض الطلاب</button>
        <button class="btn" id="markAllPresentBtn" disabled>تعليم الكل حاضر</button>
        <span class="muted small" id="attHint">اختر الصف والفصل لعرض الطلاب</span>
      </div>
      <div id="attStudentsArea" style="margin-top:14px"></div>
    `,
    footerHtml: `
      <button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveAttBtn" disabled>حفظ الحضور</button>
    `,
    onMount: () => {
      const classSel = $("#attClass");
      const secSel = $("#attSection");
      const loadBtn = $("#loadStudentsBtn");
      const markAllBtn = $("#markAllPresentBtn");
      const saveBtn = $("#saveAttBtn");
      const hint = $("#attHint");
      const area = $("#attStudentsArea");
      let currentStudents = [];

      classSel.onchange = () => {
        const cid = classSel.value;
        if (!cid) {
          secSel.innerHTML = `<option value="">— اختر الصف أولًا —</option>`; secSel.disabled = true;
          loadBtn.disabled = true; markAllBtn.disabled = true; saveBtn.disabled = true;
          area.innerHTML = ""; hint.textContent = "اختر الصف والفصل لعرض الطلاب";
          return;
        }
        const secsForClass = allowedSections.filter(s => s.class_id === cid);
        secSel.innerHTML = `<option value="">— اختر الفصل —</option>` + secsForClass.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
        secSel.disabled = false;
        loadBtn.disabled = true; markAllBtn.disabled = true; saveBtn.disabled = true;
        area.innerHTML = ""; hint.textContent = "اختر الفصل ثم اضغط عرض الطلاب";
      };

      secSel.onchange = () => { loadBtn.disabled = !secSel.value; };

      loadBtn.onclick = () => {
        const cid = classSel.value, sid = secSel.value;
        if (!cid || !sid) return;
        if (role === "teacher" && !allowedSections.some(s => s.id === sid)) { toast("لا تملك صلاحية", "error"); return; }
        const date = $("#attDate").value;
        currentStudents = state.students
          .filter(s => s.status === "active" && s.class_id === cid && s.section_id === sid)
          .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "ar"));
        if (!currentStudents.length) {
          area.innerHTML = `<div class="empty-state">لا يوجد طلاب في هذا الفصل</div>`;
          saveBtn.disabled = true; markAllBtn.disabled = true;
          hint.textContent = "لا يوجد طلاب";
          return;
        }
        const existing = {};
        state.attendance.filter(a => a.date === date && currentStudents.some(s => s.id === a.student_id))
          .forEach(a => { existing[a.student_id] = a.status; });
        area.innerHTML = `
          <div class="muted small" style="margin-bottom:8px">${currentStudents.length} طالب — ${escapeHtml(className(cid))} / ${escapeHtml(sectionName(sid))}</div>
          <div class="table-wrap" style="max-height:420px; overflow:auto">
            <table class="data">
              <thead><tr><th>#</th><th>الطالب</th><th>رقم المتابعة</th><th>الحالة</th></tr></thead>
              <tbody>
                ${currentStudents.map((s, idx) => {
                  const cur = existing[s.id] || "present";
                  return `<tr>
                    <td>${idx + 1}</td>
                    <td>${escapeHtml(s.full_name)}</td>
                    <td><span class="badge badge-info">${escapeHtml(s.tracking_number)}</span></td>
                    <td><div class="att-buttons" data-sid="${s.id}">
                      <button type="button" class="att-btn ${cur === "present" ? "active present" : ""}" data-status="present">✅ حاضر</button>
                      <button type="button" class="att-btn ${cur === "late" ? "active late" : ""}" data-status="late">🕐 متأخر</button>
                      <button type="button" class="att-btn ${cur === "absent" ? "active absent" : ""}" data-status="absent">❌ غائب</button>
                    </div></td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>`;
        area.querySelectorAll(".att-buttons").forEach(group => {
          group.querySelectorAll(".att-btn").forEach(btn => {
            btn.onclick = () => {
              group.querySelectorAll(".att-btn").forEach(b => b.classList.remove("active", "present", "late", "absent"));
              btn.classList.add("active", btn.dataset.status);
            };
          });
        });
        markAllBtn.disabled = false; saveBtn.disabled = false;
        hint.textContent = `${currentStudents.length} طالب جاهزون للتسجيل`;
      };

      markAllBtn.onclick = () => {
        area.querySelectorAll(".att-buttons").forEach(group => {
          group.querySelectorAll(".att-btn").forEach(b => b.classList.remove("active", "present", "late", "absent"));
          const btn = group.querySelector(`[data-status="present"]`);
          if (btn) btn.classList.add("active", "present");
        });
        toast("تم تعليم الجميع كحاضرين", "info");
      };

      saveBtn.onclick = async () => {
        const date = $("#attDate").value;
        if (!date) { toast("التاريخ مطلوب", "error"); return; }
        if (!currentStudents.length) { toast("لا يوجد طلاب للحفظ", "error"); return; }

        const records = [];
        area.querySelectorAll(".att-buttons").forEach(group => {
          const studentId = group.dataset.sid;
          const active = group.querySelector(".att-btn.active");
          const status = active ? active.dataset.status : "present";
          const existing = state.attendance.find(a => a.student_id === studentId && a.date === date);
          const row = {
            id: existing?.id || uuid(),
            school_id: state.session.school_id,
            student_id: studentId,
            teacher_id: me?.id || null,
            date,
            status,
            created_at: existing?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          records.push({ row, isNew: !existing });
        });

        for (const { row, isNew } of records) {
          await idb.put("attendance", row);
          await enqueue({
            entity: "attendance", record_id: row.id,
            operation_type: isNew ? "insert" : "update",
            payload: row, school_id: row.school_id
          });
        }

        // Push للغائبين
        const absentRecords = records.filter(r => r.row.status === "absent");
        for (const r of absentRecords.slice(0, 10)) {
          const st = state.students.find(s => s.id === r.row.student_id);
          try {
            await sendPushToStudent(
              r.row.student_id,
              "⚠️ غياب اليوم",
              `${st?.full_name || "الطالب"} — ${fmtDate(r.row.date)}`
            );
          } catch (e) { console.warn(e); }
        }

        hideModal();
        await loadAllLocal();
        toast(`تم حفظ حضور ${records.length} طالب`, "success");
        navigate("attendance");
      };
    }
  });
}

/* ===== Attendance stats ===== */
function openAttendanceStats(myStudents, allowedClasses, allowedSections) {
  showModal({
    title: "إحصائيات الحضور لكل طالب",
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>من تاريخ</label><input type="date" id="statFrom" /></div>
        <div class="field"><label>إلى تاريخ</label><input type="date" id="statTo" /></div>
        <div class="field"><label>الصف</label>
          <select id="statClass"><option value="">كل الصفوف</option>
            ${allowedClasses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select></div>
        <div class="field"><label>الفصل</label>
          <select id="statSection"><option value="">كل الفصول</option>
            ${allowedSections.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(className(s.class_id))})</option>`).join("")}</select></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-sm" id="statApplyBtn">تحديث</button>
        <button class="btn btn-sm btn-primary" id="statExportBtn">📥 تصدير Excel</button>
      </div>
      <div id="statResults" style="margin-top:14px"></div>
    `,
    footerHtml: `<button class="btn" data-close>إغلاق</button>`,
    onMount: () => {
      const runStats = () => {
        const from = $("#statFrom").value || "";
        const to = $("#statTo").value || "";
        const classId = $("#statClass").value || "";
        const sectionId = $("#statSection").value || "";

        const filteredStudents = myStudents.filter(s => {
          if (classId && s.class_id !== classId) return false;
          if (sectionId && s.section_id !== sectionId) return false;
          return true;
        });

        const results = filteredStudents.map(st => {
          const recs = state.attendance.filter(a => {
            if (a.student_id !== st.id) return false;
            if (from && a.date < from) return false;
            if (to && a.date > to) return false;
            return true;
          });
          const present = recs.filter(a => a.status === "present").length;
          const late = recs.filter(a => a.status === "late").length;
          const absent = recs.filter(a => a.status === "absent").length;
          const total = recs.length;
          const attended = present + late;
          const pct = total > 0 ? Math.round((attended / total) * 100) : 0;
          return { student: st, present, late, absent, total, pct };
        }).sort((a, b) => a.pct - b.pct);

        const container = $("#statResults");
        if (!results.length) { container.innerHTML = `<div class="empty-state">لا يوجد طلاب</div>`; return; }

        const globalPresent = results.reduce((s, r) => s + r.present, 0);
        const globalLate = results.reduce((s, r) => s + r.late, 0);
        const globalAbsent = results.reduce((s, r) => s + r.absent, 0);
        const globalTotal = globalPresent + globalLate + globalAbsent;
        const globalPct = globalTotal > 0 ? Math.round(((globalPresent + globalLate) / globalTotal) * 100) : 0;

        container.innerHTML = `
          <div class="stats-grid" style="margin-bottom:12px">
            <div class="stat-card"><div class="label">الطلاب</div><div class="value">${results.length}</div></div>
            <div class="stat-card"><div class="label">إجمالي السجلات</div><div class="value">${globalTotal}</div></div>
            <div class="stat-card"><div class="label">حاضر</div><div class="value" style="color:var(--success)">${globalPresent}</div></div>
            <div class="stat-card"><div class="label">متأخر</div><div class="value" style="color:var(--warning)">${globalLate}</div></div>
            <div class="stat-card"><div class="label">غائب</div><div class="value" style="color:var(--danger)">${globalAbsent}</div></div>
            <div class="stat-card"><div class="label">نسبة الحضور</div><div class="value">${globalPct}%</div></div>
          </div>
          <div class="table-wrap" style="max-height:400px; overflow:auto">
            <table class="data">
              <thead><tr><th>#</th><th>الطالب</th><th>رقم المتابعة</th><th>الصف</th><th>الفصل</th><th>حاضر</th><th>متأخر</th><th>غائب</th><th>الإجمالي</th><th>النسبة</th></tr></thead>
              <tbody>
                ${results.map((r, i) => {
                  const pctClass = r.pct >= 90 ? "badge-success" : r.pct >= 75 ? "badge-info" : r.pct >= 60 ? "badge-warning" : "badge-danger";
                  return `<tr>
                    <td>${i + 1}</td>
                    <td>${escapeHtml(r.student.full_name)}</td>
                    <td><span class="badge badge-info">${escapeHtml(r.student.tracking_number)}</span></td>
                    <td>${escapeHtml(className(r.student.class_id))}</td>
                    <td>${escapeHtml(sectionName(r.student.section_id))}</td>
                    <td style="color:var(--success);font-weight:700">${r.present}</td>
                    <td style="color:var(--warning);font-weight:700">${r.late}</td>
                    <td style="color:var(--danger);font-weight:700">${r.absent}</td>
                    <td>${r.total}</td>
                    <td><span class="badge ${pctClass}">${r.pct}%</span></td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
        `;

        $("#statExportBtn").onclick = () => {
          const headers = ["#","الطالب","رقم المتابعة","الصف","الفصل","حاضر","متأخر","غائب","الإجمالي","النسبة %"];
          const data = [headers];
          results.forEach((r, i) => data.push([i + 1, r.student.full_name, r.student.tracking_number, className(r.student.class_id), sectionName(r.student.section_id), r.present, r.late, r.absent, r.total, r.pct]));
          data.push([]);
          data.push(["الإجمالي", "", "", "", "", globalPresent, globalLate, globalAbsent, globalTotal, globalPct]);
          const stamp = new Date().toISOString().slice(0, 10);
          downloadCSV(`attendance-stats-${stamp}.csv`, data);
          toast("تم التصدير", "success");
        };
      };

      $("#statApplyBtn").onclick = runStats;
      $("#statFrom").onchange = runStats;
      $("#statTo").onchange = runStats;
      $("#statClass").onchange = runStats;
      $("#statSection").onchange = runStats;
      runStats();
    }
  });
}

/* ===== Attendance print ===== */
function openAttendancePrintDialog(myStudents, allowedClasses, allowedSections) {
  showModal({
    title: "طباعة كشف حضور شهري",
    bodyHtml: `
      <p class="muted small">اختر الصف والفصل والشهر.</p>
      <div class="form-grid">
        <div class="field"><label>الصف</label>
          <select id="printClass"><option value="">— اختر الصف —</option>
            ${allowedClasses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select></div>
        <div class="field"><label>الفصل</label>
          <select id="printSection" disabled><option value="">— اختر الصف أولًا —</option></select></div>
        <div class="field"><label>الشهر</label>
          <input type="month" id="printMonth" value="${new Date().toISOString().slice(0, 7)}" /></div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn btn-primary" id="generatePrintBtn">إنشاء الكشف</button>
        <button class="btn" id="printNowBtn" disabled>🖨️ طباعة</button>
      </div>
      <div id="printArea" style="margin-top:14px"></div>
    `,
    footerHtml: `<button class="btn" data-close>إغلاق</button>`,
    onMount: () => {
      const classSel = $("#printClass");
      const secSel = $("#printSection");
      const printBtn = $("#printNowBtn");
      const area = $("#printArea");

      classSel.onchange = () => {
        const cid = classSel.value;
        if (!cid) { secSel.innerHTML = `<option value="">— اختر الصف أولًا —</option>`; secSel.disabled = true; printBtn.disabled = true; return; }
        const secs = allowedSections.filter(s => s.class_id === cid);
        secSel.innerHTML = `<option value="">— اختر الفصل —</option>` + secs.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
        secSel.disabled = false; printBtn.disabled = true;
      };
      secSel.onchange = () => { printBtn.disabled = !secSel.value; };

      $("#generatePrintBtn").onclick = () => {
        const cid = classSel.value, sid = secSel.value, month = $("#printMonth").value;
        if (!cid || !sid || !month) { toast("اختر الصف والفصل والشهر", "error"); return; }

        const [year, mon] = month.split("-").map(Number);
        const daysInMonth = new Date(year, mon, 0).getDate();
        const days = [];
        for (let d = 1; d <= daysInMonth; d++) days.push(`${year}-${String(mon).padStart(2,"0")}-${String(d).padStart(2,"0")}`);

        const students = state.students.filter(s => s.status === "active" && s.class_id === cid && s.section_id === sid)
          .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "ar"));
        if (!students.length) { toast("لا يوجد طلاب", "warning"); return; }

        const monthLabel = new Date(year, mon - 1, 1).toLocaleDateString("ar-EG", { year: "numeric", month: "long" });
        const schoolName = state.school?.name || "المدرسة";

        area.innerHTML = `
          <div class="print-sheet" id="printSheet">
            <div class="print-header">
              <div class="print-school">${escapeHtml(schoolName)}</div>
              <div class="print-title">كشف الحضور الشهري</div>
              <div class="print-meta">
                <span>الصف: ${escapeHtml(className(cid))}</span>
                <span>الفصل: ${escapeHtml(sectionName(sid))}</span>
                <span>الشهر: ${monthLabel}</span>
              </div>
            </div>
            <div class="table-wrap" style="overflow-x:auto">
              <table class="data print-table">
                <thead>
                  <tr>
                    <th>#</th><th style="min-width:160px">الطالب</th><th>رقم المتابعة</th>
                    ${days.map(d => `<th style="text-align:center">${Number(d.slice(-2))}</th>`).join("")}
                    <th>حاضر</th><th>غائب</th><th>النسبة</th>
                  </tr>
                </thead>
                <tbody>
                  ${students.map((st, i) => {
                    const recs = state.attendance.filter(a => a.student_id === st.id && days.includes(a.date));
                    const byDate = {};
                    recs.forEach(r => { byDate[r.date] = r.status; });
                    const presentCount = recs.filter(r => r.status === "present").length;
                    const lateCount = recs.filter(r => r.status === "late").length;
                    const absentCount = recs.filter(r => r.status === "absent").length;
                    const total = presentCount + lateCount + absentCount;
                    const pct = total > 0 ? Math.round(((presentCount + lateCount) / total) * 100) : 0;
                    return `<tr>
                      <td>${i + 1}</td>
                      <td>${escapeHtml(st.full_name)}</td>
                      <td>${escapeHtml(st.tracking_number)}</td>
                      ${days.map(d => {
                        const s = byDate[d];
                        const ch = s === "present" ? "✓" : s === "late" ? "ت" : s === "absent" ? "✗" : "";
                        const cls = s === "present" ? "p-present" : s === "late" ? "p-late" : s === "absent" ? "p-absent" : "";
                        return `<td class="p-cell ${cls}" style="text-align:center">${ch}</td>`;
                      }).join("")}
                      <td style="text-align:center;font-weight:700">${presentCount + lateCount}</td>
                      <td style="text-align:center;font-weight:700;color:#dc2626">${absentCount}</td>
                      <td style="text-align:center;font-weight:700">${pct}%</td>
                    </tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
            <div class="print-footer">
              <div>المفتاح: ✓ حاضر | ت متأخر | ✗ غائب</div>
              <div>تم الإنشاء: ${new Date().toLocaleString("ar-EG")}</div>
            </div>
          </div>`;
        printBtn.disabled = false;
      };

      printBtn.onclick = () => {
        const content = $("#printSheet")?.outerHTML;
        if (!content) return;
        const w = window.open("", "_blank");
        w.document.write(`
          <!DOCTYPE html>
          <html lang="ar" dir="rtl">
          <head>
            <meta charset="UTF-8" />
            <title>كشف الحضور</title>
            <style>
              body { font-family: "Segoe UI", Tahoma, sans-serif; padding: 20px; }
              .print-header { text-align: center; margin-bottom: 14px; }
              .print-school { font-size: 20px; font-weight: 800; color: #0f766e; }
              .print-title { font-size: 16px; font-weight: 700; margin: 4px 0; }
              .print-meta { display: flex; gap: 20px; justify-content: center; font-size: 13px; color: #333; }
              table { border-collapse: collapse; width: 100%; font-size: 11px; }
              th, td { border: 1px solid #999; padding: 3px 5px; text-align: right; }
              th { background: #f0f0f0; }
              .p-cell { padding: 2px; }
              .p-present { color: green; font-weight: 700; }
              .p-late { color: #d97706; font-weight: 700; }
              .p-absent { color: #dc2626; font-weight: 700; }
              .print-footer { display: flex; justify-content: space-between; margin-top: 14px; font-size: 11px; color: #555; }
              @media print { @page { size: A4 landscape; margin: 10mm; } body { padding: 0; } }
            </style>
          </head>
          <body>${content}</body>
          </html>
        `);
        w.document.close();
        setTimeout(() => { w.focus(); w.print(); }, 300);
      };
    }
  });
}

/* ===== Homework ===== */
async function renderHomework(c) {
  const role = state.session.role;
  const myStudents = role === "admin" ? state.students.filter(s => s.status === "active") : teacherStudents().filter(s => s.status === "active");
  const myHw = state.homework.filter(h => myStudents.some(s => s.id === h.student_id));

  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="hwSearch" class="search-input" placeholder="ابحث بالطالب أو رقم المتابعة أو المادة أو التاريخ" />
        <button id="addHwBtn" class="btn btn-primary">➕ تسجيل واجب</button>
      </div>
      <div class="table-wrap">
        <table class="data" id="hwTable">
          <thead><tr><th>التاريخ</th><th>الطالب</th><th>رقم المتابعة</th><th>المادة</th><th>الواجب</th><th>الكراسة</th><th>ملاحظات</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  const renderRows = (filter = "") => {
    const rows = myHw.filter(h => {
      if (!filter) return true;
      const st = state.students.find(s => s.id === h.student_id);
      if (!st) return false;
      return arabicIncludes(st.full_name, filter)
        || String(st.tracking_number || "").includes(filter.trim())
        || arabicIncludes(subjectName(h.subject_id), filter)
        || (h.date || "").includes(filter);
    }).sort((a, b) => b.date.localeCompare(a.date));
    const tbody = $("#hwTable tbody");
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" class="empty-state">لا نتائج</td></tr>`; return; }
    tbody.innerHTML = rows.map(h => {
      const st = state.students.find(s => s.id === h.student_id);
      return `<tr>
        <td>${fmtDate(h.date)}</td>
        <td>${escapeHtml(st?.full_name || "—")}</td>
        <td><span class="badge badge-info">${escapeHtml(st?.tracking_number || "—")}</span></td>
        <td>${escapeHtml(subjectName(h.subject_id))}</td>
        <td>${hwLabel(h.homework_status)}</td>
        <td>${hwLabel(h.notebook_status)}</td>
        <td>${escapeHtml(h.notes || "")}</td>
      </tr>`;
    }).join("");
  };

  $("#hwSearch").oninput = debounce(e => renderRows(e.target.value), 200);
  renderRows("");
  $("#addHwBtn").onclick = () => openHomeworkForm(myStudents);
}

async function openHomeworkForm(myStudents) {
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  const mySubjects = state.session.role === "admin"
    ? state.subjects
    : state.subjects.filter(s => state.assignments.some(a => a.teacher_id === me?.id && a.subject_id === s.id));

  showModal({
    title: "تسجيل واجب",
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>الطالب</label>
          <select id="hwStudent">${myStudents.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)} — ${escapeHtml(s.tracking_number)}</option>`).join("")}</select></div>
        <div class="field"><label>المادة</label>
          <select id="hwSubject">${mySubjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select></div>
        <div class="field"><label>التاريخ</label><input type="date" id="hwDate" value="${todayISO()}" /></div>
        <div class="field"><label>حالة الواجب</label>
          <select id="hwStatus">
            <option value="completed">مكتمل</option>
            <option value="incomplete">غير مكتمل</option>
            <option value="not_submitted">لم يسلم</option>
          </select></div>
        <div class="field"><label>حالة الكراسة</label>
          <select id="hwNotebook">
            <option value="completed">مكتمل</option>
            <option value="incomplete">غير مكتمل</option>
            <option value="not_submitted">لم يسلم</option>
          </select></div>
        <div class="field" style="grid-column:1/-1"><label>ملاحظات</label><textarea id="hwNotes"></textarea></div>
      </div>`,
    footerHtml: `<button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveHwBtn">حفظ</button>`,
    onMount: () => {
      $("#saveHwBtn").onclick = async () => {
        const row = {
          id: uuid(),
          school_id: state.session.school_id,
          student_id: $("#hwStudent").value,
          subject_id: $("#hwSubject").value,
          teacher_id: me?.id || null,
          date: $("#hwDate").value,
          homework_status: $("#hwStatus").value,
          notebook_status: $("#hwNotebook").value,
          notes: $("#hwNotes").value.trim() || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await idb.put("homework", row);
        await enqueue({ entity: "homework", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });
        hideModal();
        await loadAllLocal();
        toast("تم الحفظ", "success");
        navigate("homework");
      };
    }
  });
}

/* ===== Behavior ===== */
async function renderBehavior(c) {
  const role = state.session.role;
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  const myStudents = role === "admin" ? state.students.filter(s => s.status === "active") : teacherStudents().filter(s => s.status === "active");
  const myBh = state.behavior.filter(b => myStudents.some(s => s.id === b.student_id));

  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="bhSearch" class="search-input" placeholder="ابحث بالطالب أو رقم المتابعة أو الملاحظة أو التاريخ" />
        <button id="addBhBtn" class="btn btn-primary">➕ ملاحظة سلوك</button>
      </div>
      <div class="table-wrap">
        <table class="data" id="bhTable">
          <thead><tr><th>التاريخ</th><th>الطالب</th><th>رقم المتابعة</th><th>النوع</th><th>الملاحظة</th><th>المعلم</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  const renderRows = (filter = "") => {
    const rows = myBh.filter(b => {
      if (!filter) return true;
      const st = state.students.find(s => s.id === b.student_id);
      if (!st) return false;
      return arabicIncludes(st.full_name, filter)
        || String(st.tracking_number || "").includes(filter.trim())
        || arabicIncludes(b.note, filter)
        || (b.date || "").includes(filter);
    }).sort((a, b) => b.date.localeCompare(a.date));
    const tbody = $("#bhTable tbody");
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" class="empty-state">لا نتائج</td></tr>`; return; }
    tbody.innerHTML = rows.map(b => {
      const st = state.students.find(s => s.id === b.student_id);
      const canEdit = role === "admin" || (me && b.teacher_id === me.id);
      return `<tr>
        <td>${fmtDate(b.date)}</td>
        <td>${escapeHtml(st?.full_name || "—")}</td>
        <td><span class="badge badge-info">${escapeHtml(st?.tracking_number || "—")}</span></td>
        <td>${bhLabel(b.note_type)}</td>
        <td>${escapeHtml(b.note)}</td>
        <td class="muted small">${escapeHtml(teacherName(b.teacher_id))}</td>
        <td>${canEdit ? `
          <button class="btn btn-sm" data-edit="${b.id}">✎</button>
          <button class="btn btn-sm btn-danger" data-del="${b.id}">×</button>
        ` : ""}</td>
      </tr>`;
    }).join("");
    tbody.querySelectorAll("[data-del]").forEach(btn => btn.onclick = async () => {
      const id = btn.dataset.del;
      if (!confirm("هل تريد حذف هذه الملاحظة؟")) return;
      const row = state.behavior.find(x => x.id === id);
      await idb.delete("behavior_notes", id);
      await enqueue({ entity: "behavior_notes", record_id: id, operation_type: "delete", payload: null, school_id: row.school_id });
      await loadAllLocal();
      toast("تم الحذف", "success");
      navigate("behavior");
    });
    tbody.querySelectorAll("[data-edit]").forEach(btn => btn.onclick = () => {
      const id = btn.dataset.edit;
      const row = state.behavior.find(x => x.id === id);
      if (row) openBehaviorEditForm(row);
    });
  };

  $("#bhSearch").oninput = debounce(e => renderRows(e.target.value), 200);
  renderRows("");
  $("#addBhBtn").onclick = () => openBehaviorForm(myStudents);
}

function openBehaviorEditForm(existing) {
  showModal({
    title: "تعديل ملاحظة سلوك",
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>التاريخ</label><input type="date" id="bhEditDate" value="${existing.date || todayISO()}" /></div>
        <div class="field"><label>النوع</label>
          <select id="bhEditType">
            <option value="positive" ${existing.note_type === "positive" ? "selected" : ""}>ملاحظة إيجابية</option>
            <option value="warning" ${existing.note_type === "warning" ? "selected" : ""}>تنبيه سلوكي</option>
            <option value="note" ${existing.note_type === "note" ? "selected" : ""}>ملاحظة عامة</option>
          </select></div>
        <div class="field" style="grid-column:1/-1"><label>الملاحظة</label><textarea id="bhEditNote">${escapeHtml(existing.note || "")}</textarea></div>
      </div>`,
    footerHtml: `<button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveBhEditBtn">حفظ التعديلات</button>`,
    onMount: () => {
      $("#saveBhEditBtn").onclick = async () => {
        const note = $("#bhEditNote").value.trim();
        if (!note) { toast("الملاحظة مطلوبة", "error"); return; }
        const row = {
          ...existing,
          date: $("#bhEditDate").value,
          note_type: $("#bhEditType").value,
          note,
          updated_at: new Date().toISOString()
        };
        await idb.put("behavior_notes", row);
        await enqueue({ entity: "behavior_notes", record_id: row.id, operation_type: "update", payload: row, school_id: row.school_id });
        hideModal();
        await loadAllLocal();
        toast("تم التعديل", "success");
        navigate("behavior");
      };
    }
  });
}

async function openBehaviorForm(myStudents) {
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  showModal({
    title: "ملاحظة سلوك",
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>الطالب</label>
          <select id="bhStudent">${myStudents.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)} — ${escapeHtml(s.tracking_number)}</option>`).join("")}</select></div>
        <div class="field"><label>التاريخ</label><input type="date" id="bhDate" value="${todayISO()}" /></div>
        <div class="field"><label>النوع</label>
          <select id="bhType">
            <option value="positive">ملاحظة إيجابية</option>
            <option value="warning">تنبيه سلوكي</option>
            <option value="note">ملاحظة عامة</option>
          </select></div>
        <div class="field" style="grid-column:1/-1"><label>الملاحظة</label><textarea id="bhNote"></textarea></div>
      </div>`,
    footerHtml: `<button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveBhBtn">حفظ</button>`,
    onMount: () => {
      $("#saveBhBtn").onclick = async () => {
        const note = $("#bhNote").value.trim();
        if (!note) { toast("الملاحظة مطلوبة", "error"); return; }
        const row = {
          id: uuid(),
          school_id: state.session.school_id,
          student_id: $("#bhStudent").value,
          teacher_id: me?.id || null,
          date: $("#bhDate").value,
          note_type: $("#bhType").value,
          note,
          created_at: new Date().toISOString()
        };
        await idb.put("behavior_notes", row);
        await enqueue({ entity: "behavior_notes", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });

        if (row.note_type === "warning") {
          const st = state.students.find(s => s.id === row.student_id);
          try {
            await sendPushToStudent(
              row.student_id,
              "⚠️ تنبيه سلوكي",
              `${st?.full_name || "الطالب"} — ${note.substring(0, 80)}`
            );
          } catch (e) { console.warn(e); }
        }

        hideModal();
        await loadAllLocal();
        toast("تم الحفظ", "success");
        navigate("behavior");
      };
    }
  });
}

/* ===== Announcements ===== */
async function renderAnnouncements(c) {
  const role = state.session.role;
  const list = role === "admin" ? state.announcements : state.announcements.filter(a => a.audience === "teachers" || a.audience === "all");

  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="anSearch" class="search-input" placeholder="ابحث في العنوان أو المحتوى أو التاريخ" />
        ${role === "admin" ? `<button class="btn btn-primary" id="addAnBtn">➕ إعلان جديد</button>` : ``}
      </div>
      <div id="anList"></div>
    </div>`;

  const renderRows = (filter = "") => {
    const rows = list.filter(a => {
      if (!filter) return true;
      return arabicIncludes(a.title, filter) || arabicIncludes(a.content, filter) || (a.date || "").includes(filter);
    }).sort((a, b) => b.date.localeCompare(a.date));
    const container = $("#anList");
    if (!rows.length) { container.innerHTML = `<div class="empty-state">لا نتائج</div>`; return; }
    container.innerHTML = rows.map(a => `
      <div class="list-item">
        <div class="list-item-title">${escapeHtml(a.title)}</div>
        <div class="muted small">${fmtDate(a.date)} — ${a.audience === "teachers" ? "للمعلمين" : a.audience === "parents" ? "لأولياء الأمور" : "للجميع"}</div>
        <div>${escapeHtml(a.content)}</div>
        ${role === "admin" ? `<button class="btn btn-sm btn-danger" data-del="${a.id}" style="margin-top:6px">حذف</button>` : ""}
      </div>`).join("");
    container.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      const id = b.dataset.del;
      const row = state.announcements.find(x => x.id === id);
      await idb.delete("announcements", id);
      await enqueue({ entity: "announcements", record_id: id, operation_type: "delete", payload: null, school_id: row.school_id });
      await loadAllLocal();
      navigate("announcements");
    });
  };

  $("#anSearch").oninput = debounce(e => renderRows(e.target.value), 200);
  renderRows("");
  if (role === "admin") $("#addAnBtn").onclick = () => openAnnouncementForm();
}

async function openAnnouncementForm() {
  showModal({
    title: "إعلان جديد",
    bodyHtml: `
      <div class="form-grid">
        <div class="field" style="grid-column:1/-1"><label>العنوان</label><input id="anTitle" /></div>
        <div class="field" style="grid-column:1/-1"><label>المحتوى</label><textarea id="anContent"></textarea></div>
        <div class="field"><label>التاريخ</label><input type="date" id="anDate" value="${todayISO()}" /></div>
        <div class="field"><label>الفئة</label>
          <select id="anAudience">
            <option value="all">الجميع</option>
            <option value="teachers">المعلمون</option>
            <option value="parents">أولياء الأمور</option>
          </select></div>
      </div>`,
    footerHtml: `<button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="saveAnBtn">حفظ</button>`,
    onMount: () => {
      $("#saveAnBtn").onclick = async () => {
        const title = $("#anTitle").value.trim();
        const content = $("#anContent").value.trim();
        if (!title || !content) { toast("العنوان والمحتوى مطلوبان", "error"); return; }
        const row = {
          id: uuid(),
          school_id: state.session.school_id,
          title, content,
          date: $("#anDate").value,
          audience: $("#anAudience").value,
          created_at: new Date().toISOString()
        };
        await idb.put("announcements", row);
        await enqueue({ entity: "announcements", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });

        if (row.audience === "parents" || row.audience === "all") {
          try {
            const client = getClient();
            const { data: { session } } = await client.auth.getSession();
            if (session) {
              await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
                body: JSON.stringify({
                  audience: "school_all",
                  title: "📢 " + title,
                  body: content.substring(0, 100),
                  url: "/?page=parent"
                })
              });
            }
          } catch (e) { console.warn("broadcast push failed", e); }
        }

        hideModal();
        await loadAllLocal();
        toast("تم النشر", "success");
        navigate("announcements");
      };
    }
  });
}

/* ===== Parent Notes (المتبقي من الرسوم) ===== */
async function renderParentNotes(c) {
  const role = state.session.role;
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  const myStudents = role === "admin" ? state.students.filter(s => s.status === "active") : teacherStudents().filter(s => s.status === "active");

  const myNotes = state.parentNotes.filter(n => myStudents.some(s => s.id === n.student_id));

  let allowedSubjects;
  if (role === "admin") allowedSubjects = state.subjects;
  else {
    const mySubjectIds = new Set(state.assignments.filter(a => a.teacher_id === me?.id).map(a => a.subject_id));
    allowedSubjects = state.subjects.filter(s => mySubjectIds.has(s.id));
  }

  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="pnSearch" class="search-input" placeholder="ابحث بالطالب أو رقم المتابعة" />
        <select id="pnFilterSubject" class="search-input" style="max-width:200px">
          <option value="">كل المواد</option>
          <option value="_general">عام (بدون مادة)</option>
          ${allowedSubjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}
        </select>
        <button id="addPnBtn" class="btn btn-primary">➕ إضافة تنبيه</button>
      </div>
      <div class="muted small" style="margin-bottom:10px">
        💰 تنبيه لكل طالب على حدة. يمكن ربطه بمادة محددة أو تركه عامًا.
      </div>
      <div class="table-wrap">
        <table class="data" id="pnTable">
          <thead><tr>
            <th>التاريخ</th><th>الطالب</th><th>رقم المتابعة</th><th>الصف / الفصل</th>
            <th>المادة</th><th>العنوان</th><th>المبلغ</th><th>الكاتب</th><th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="row" style="justify-content:space-between; margin-top:12px">
        <span id="pnCount" class="muted small"></span>
      </div>
    </div>`;

  const renderRows = () => {
    const q = ($("#pnSearch").value || "").trim();
    const subjectFilter = $("#pnFilterSubject").value || "";

    const rows = myNotes.filter(n => {
      if (subjectFilter === "_general" && n.subject_id) return false;
      if (subjectFilter && subjectFilter !== "_general" && n.subject_id !== subjectFilter) return false;
      if (q) {
        const st = state.students.find(s => s.id === n.student_id);
        if (!st) return false;
        return arabicIncludes(st.full_name, q) || String(st.tracking_number || "").includes(q);
      }
      return true;
    }).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    const tbody = $("#pnTable tbody");
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="9" class="empty-state">لا نتائج</td></tr>`; }
    else {
      tbody.innerHTML = rows.map(n => {
        const st = state.students.find(s => s.id === n.student_id);
        const canEdit = role === "admin" || (me && n.teacher_id === me.id);
        const amountTxt = (n.amount !== null && n.amount !== undefined && n.amount !== "")
          ? `<strong style="color:var(--danger)">${Number(n.amount).toLocaleString("ar-EG")} ${escapeHtml(n.currency || "جنيه")}</strong>`
          : "—";
        const subjectTxt = n.subject_id
          ? `<span class="badge badge-info">${escapeHtml(subjectName(n.subject_id))}</span>`
          : `<span class="badge badge-muted">عام</span>`;
        return `<tr>
          <td>${fmtDate(n.date)}</td>
          <td>${escapeHtml(st?.full_name || "—")}</td>
          <td><span class="badge badge-info">${escapeHtml(st?.tracking_number || "—")}</span></td>
          <td class="muted small">${escapeHtml(className(st?.class_id))} / ${escapeHtml(sectionName(st?.section_id))}</td>
          <td>${subjectTxt}</td>
          <td>${escapeHtml(n.title || "المتبقي من الرسوم")}</td>
          <td>${amountTxt}</td>
          <td class="muted small">${escapeHtml(teacherName(n.teacher_id) || "المدير")}</td>
          <td>${canEdit ? `
            <button class="btn btn-sm" data-edit="${n.id}">✎</button>
            <button class="btn btn-sm btn-danger" data-del="${n.id}">×</button>
          ` : ""}</td>
        </tr>`;
      }).join("");
      tbody.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
        const row = state.parentNotes.find(x => x.id === b.dataset.edit);
        if (row) openParentNoteForm(row, myStudents);
      });
      tbody.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
        if (!confirm("هل تريد حذف هذا التنبيه؟")) return;
        const id = b.dataset.del;
        const row = state.parentNotes.find(x => x.id === id);
        if (!row) return;
        await idb.delete("parent_notes", id);
        await enqueue({ entity: "parent_notes", record_id: id, operation_type: "delete", payload: null, school_id: row.school_id });
        await loadAllLocal();
        toast("تم الحذف", "success");
        navigate("parent_notes");
      });
    }
    $("#pnCount").textContent = `إجمالي: ${rows.length}`;
  };

  $("#pnSearch").oninput = debounce(renderRows, 200);
  $("#pnFilterSubject").onchange = renderRows;
  renderRows();
  $("#addPnBtn").onclick = () => openParentNoteForm(null, myStudents);
}

function openParentNoteForm(existing = null, presetStudents = null) {
  const role = state.session.role;
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  const isEdit = !!existing;
  const allowedStudents = presetStudents || (role === "admin" ? state.students.filter(s => s.status === "active") : teacherStudents().filter(s => s.status === "active"));

  if (!allowedStudents.length) { toast("لا يوجد طلاب متاحون", "warning"); return; }

  let allowedSections;
  if (role === "admin") allowedSections = state.sections;
  else {
    const myAssigns = state.assignments.filter(a => a.teacher_id === me?.id);
    const sectionIds = new Set(myAssigns.map(a => a.section_id));
    allowedSections = state.sections.filter(s => sectionIds.has(s.id));
  }
  const allowedClassIds = new Set(allowedSections.map(s => s.class_id));
  const allowedClasses = state.classes.filter(c => allowedClassIds.has(c.id));

  let allowedSubjects;
  if (role === "admin") allowedSubjects = state.subjects;
  else {
    const mySubjectIds = new Set(state.assignments.filter(a => a.teacher_id === me?.id).map(a => a.subject_id));
    allowedSubjects = state.subjects.filter(s => mySubjectIds.has(s.id));
  }

  if (isEdit) { openEditParentNote(existing, allowedSubjects); return; }

  showModal({
    title: "➕ إضافة تنبيه جديد",
    bodyHtml: `
      <div class="pn-wizard">
        <div class="pn-step" data-step="1">
          <div class="pn-step-header"><span class="pn-step-num">1</span><strong>اختر الصف</strong></div>
          <div class="pn-choices" id="pnClasses">
            ${allowedClasses.length
              ? allowedClasses.map(c => `<button type="button" class="pn-choice" data-class="${c.id}">${escapeHtml(c.name)}</button>`).join("")
              : `<div class="empty-state">لا صفوف متاحة</div>`}
          </div>
        </div>
        <div class="pn-step hidden" data-step="2">
          <div class="pn-step-header"><span class="pn-step-num">2</span><strong>اختر الفصل</strong><span class="pn-selected muted small" id="pnSelectedClass"></span></div>
          <div class="pn-choices" id="pnSections"></div>
        </div>
        <div class="pn-step hidden" data-step="3">
          <div class="pn-step-header"><span class="pn-step-num">3</span><strong>اختر الطالب</strong><span class="pn-selected muted small" id="pnSelectedSection"></span></div>
          <input type="text" class="search-input pn-student-search" id="pnStudentSearch" placeholder="ابحث بالاسم أو رقم المتابعة" />
          <div class="pn-choices pn-students-list" id="pnStudents"></div>
        </div>
        <div class="pn-step hidden" data-step="4">
          <div class="pn-step-header"><span class="pn-step-num">4</span><strong>التفاصيل</strong><span class="pn-selected muted small" id="pnSelectedStudent"></span></div>
          <div class="form-grid">
            <div class="field"><label>التاريخ</label><input type="date" id="pnDate" value="${todayISO()}" /></div>
            <div class="field"><label>المادة (اختياري)</label>
              <select id="pnSubject"><option value="">— عام (بدون مادة) —</option>
                ${allowedSubjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select></div>
            <div class="field"><label>العنوان</label><input id="pnTitle" value="المتبقي من الرسوم" /></div>
            <div class="field"><label>المبلغ (اختياري)</label><input id="pnAmount" type="number" step="0.01" min="0" placeholder="مثال: 5000" /></div>
            <div class="field"><label>العملة</label>
              <select id="pnCurrency">
                <option value="جنيه" selected>جنيه</option>
                <option value="دولار">دولار</option>
                <option value="ريال">ريال</option>
                <option value="درهم">درهم</option>
              </select></div>
            <div class="field" style="grid-column:1/-1"><label>ملاحظة إضافية (اختياري)</label><textarea id="pnBody" placeholder="مثال: القسط الثاني — آخر موعد 30 سبتمبر"></textarea></div>
          </div>
          <div class="pn-summary" id="pnSummary"></div>
        </div>
      </div>
    `,
    footerHtml: `
      <button class="btn" data-close>إلغاء</button>
      <button class="btn" id="pnBackBtn" disabled>◀ السابق</button>
      <button class="btn btn-primary" id="pnNextBtn" disabled>التالي ▶</button>
      <button class="btn btn-primary hidden" id="pnSaveBtn">💾 حفظ</button>
    `,
    onMount: () => {
      const wizard = { step: 1, classId: null, sectionId: null, studentId: null };

      const updateButtons = () => {
        const back = $("#pnBackBtn"), next = $("#pnNextBtn"), save = $("#pnSaveBtn");
        back.disabled = wizard.step <= 1;
        back.classList.toggle("hidden", wizard.step === 4);
        next.classList.toggle("hidden", wizard.step === 4);
        save.classList.toggle("hidden", wizard.step !== 4);
        if (wizard.step === 1) next.disabled = !wizard.classId;
        else if (wizard.step === 2) next.disabled = !wizard.sectionId;
        else if (wizard.step === 3) next.disabled = !wizard.studentId;
      };

      const showStep = (n) => {
        $$(".pn-step").forEach(el => el.classList.toggle("hidden", Number(el.dataset.step) !== n));
        wizard.step = n;
        updateButtons();
      };

      const renderStudentChoices = (students) => {
        const el = $("#pnStudents");
        if (!students.length) { el.innerHTML = `<div class="empty-state">لا طلاب</div>`; return; }
        el.innerHTML = students.map(s => `
          <button type="button" class="pn-choice pn-student-choice" data-student="${s.id}">
            <span>${escapeHtml(s.full_name)}</span>
            <span class="badge badge-info">${escapeHtml(s.tracking_number)}</span>
          </button>`).join("");
        el.querySelectorAll(".pn-choice").forEach(btn => {
          btn.onclick = () => {
            wizard.studentId = btn.dataset.student;
            el.querySelectorAll(".pn-choice").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            const st = state.students.find(s => s.id === wizard.studentId);
            $("#pnSelectedStudent").textContent = "— " + (st?.full_name || "");
            const cls = state.classes.find(c => c.id === wizard.classId);
            const sec = state.sections.find(s => s.id === wizard.sectionId);
            $("#pnSummary").innerHTML = `
              <div style="background:var(--primary-light); padding:10px 12px; border-radius:8px; margin-top:10px">
                <strong>الملخص:</strong> ${escapeHtml(cls?.name || "")} / ${escapeHtml(sec?.name || "")} — ${escapeHtml(st?.full_name || "")}
                <span class="badge badge-info">${escapeHtml(st?.tracking_number || "")}</span>
              </div>`;
            updateButtons();
          };
        });
      };

      $$("#pnClasses .pn-choice").forEach(btn => {
        btn.onclick = () => {
          wizard.classId = btn.dataset.class;
          wizard.sectionId = null; wizard.studentId = null;
          $$("#pnClasses .pn-choice").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          $("#pnSelectedClass").textContent = "— " + btn.textContent.trim();

          const secs = allowedSections.filter(s => s.class_id === wizard.classId);
          const secsEl = $("#pnSections");
          secsEl.innerHTML = secs.length
            ? secs.map(s => `<button type="button" class="pn-choice" data-section="${s.id}">${escapeHtml(s.name)}</button>`).join("")
            : `<div class="empty-state">لا فصول</div>`;
          secsEl.querySelectorAll(".pn-choice").forEach(sBtn => {
            sBtn.onclick = () => {
              wizard.sectionId = sBtn.dataset.section;
              wizard.studentId = null;
              secsEl.querySelectorAll(".pn-choice").forEach(b => b.classList.remove("selected"));
              sBtn.classList.add("selected");
              $("#pnSelectedSection").textContent = "— " + sBtn.textContent.trim();
              const students = allowedStudents.filter(s => s.class_id === wizard.classId && s.section_id === wizard.sectionId)
                .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "ar"));
              renderStudentChoices(students);
              updateButtons();
            };
          });
          showStep(2);
        };
      });

      $("#pnStudentSearch").oninput = debounce((e) => {
        const q = e.target.value.trim();
        let students = allowedStudents.filter(s => s.class_id === wizard.classId && s.section_id === wizard.sectionId);
        if (q) students = students.filter(s => arabicIncludes(s.full_name, q) || String(s.tracking_number || "").includes(q));
        students.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "ar"));
        renderStudentChoices(students);
      }, 200);

      $("#pnBackBtn").onclick = () => { if (wizard.step > 1) showStep(wizard.step - 1); };
      $("#pnNextBtn").onclick = () => { if (wizard.step < 4) showStep(wizard.step + 1); };

      $("#pnSaveBtn").onclick = async () => {
        const studentId = wizard.studentId;
        const subjectId = $("#pnSubject").value || null;
        const amountRaw = $("#pnAmount").value.trim();
        const amount = amountRaw === "" ? null : Number(amountRaw);
        if (amount !== null && (isNaN(amount) || amount < 0)) { toast("المبلغ غير صحيح", "error"); return; }
        const body = $("#pnBody").value.trim();
        if (!body && amount === null) { toast("يجب إدخال مبلغ أو ملاحظة على الأقل", "error"); return; }

        const row = {
          id: uuid(),
          school_id: state.session.school_id,
          student_id: studentId,
          teacher_id: me?.id || null,
          subject_id: subjectId,
          title: $("#pnTitle").value.trim() || "المتبقي من الرسوم",
          body: body || null,
          amount,
          currency: $("#pnCurrency").value,
          category: "remaining",
          date: $("#pnDate").value || todayISO(),
          status: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await idb.put("parent_notes", row);
        await enqueue({ entity: "parent_notes", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });

        const st = state.students.find(s => s.id === studentId);
        const pushBody = amount !== null ? `المتبقي: ${Number(amount).toLocaleString("ar-EG")} ${row.currency}` : (body || "لديك تنبيه جديد");
        try {
          await sendPushToStudent(studentId, "💰 المتبقي من الرسوم", `${st?.full_name || ""}: ${pushBody}`, "/?page=parent");
        } catch (e) { console.warn("push failed", e); }

        hideModal();
        await loadAllLocal();
        toast("تمت الإضافة بنجاح", "success");
        navigate("parent_notes");
      };

      updateButtons();
    }
  });
}

function openEditParentNote(existing, allowedSubjects) {
  const me = state.teachers.find(t => t.profile_id === state.session.user_id);
  showModal({
    title: "✎ تعديل التنبيه",
    bodyHtml: `
      <div class="form-grid">
        <div class="field" style="grid-column:1/-1"><label>الطالب</label>
          <input value="${escapeHtml(state.students.find(s => s.id === existing.student_id)?.full_name || "")}" disabled /></div>
        <div class="field"><label>التاريخ</label><input type="date" id="pnDate" value="${existing?.date || todayISO()}" /></div>
        <div class="field"><label>المادة (اختياري)</label>
          <select id="pnSubject"><option value="">— عام —</option>
            ${allowedSubjects.map(s => `<option value="${s.id}" ${existing.subject_id === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}</select></div>
        <div class="field"><label>العنوان</label><input id="pnTitle" value="${escapeHtml(existing?.title || "المتبقي من الرسوم")}" /></div>
        <div class="field"><label>المبلغ (اختياري)</label><input id="pnAmount" type="number" step="0.01" min="0" value="${existing?.amount ?? ""}" /></div>
        <div class="field"><label>العملة</label>
          <select id="pnCurrency">
            <option value="جنيه" ${existing?.currency === "جنيه" || !existing?.currency ? "selected" : ""}>جنيه</option>
            <option value="دولار" ${existing?.currency === "دولار" ? "selected" : ""}>دولار</option>
            <option value="ريال" ${existing?.currency === "ريال" ? "selected" : ""}>ريال</option>
            <option value="درهم" ${existing?.currency === "درهم" ? "selected" : ""}>درهم</option>
          </select></div>
        <div class="field" style="grid-column:1/-1"><label>ملاحظة إضافية</label><textarea id="pnBody">${escapeHtml(existing?.body || "")}</textarea></div>
      </div>
    `,
    footerHtml: `<button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="savePnBtn">حفظ التعديلات</button>`,
    onMount: () => {
      $("#savePnBtn").onclick = async () => {
        const amountRaw = $("#pnAmount").value.trim();
        const amount = amountRaw === "" ? null : Number(amountRaw);
        if (amount !== null && (isNaN(amount) || amount < 0)) { toast("المبلغ غير صحيح", "error"); return; }
        const row = {
          ...existing,
          subject_id: $("#pnSubject").value || null,
          title: $("#pnTitle").value.trim() || "المتبقي من الرسوم",
          body: $("#pnBody").value.trim() || null,
          amount,
          currency: $("#pnCurrency").value,
          date: $("#pnDate").value || todayISO(),
          updated_at: new Date().toISOString()
        };
        await idb.put("parent_notes", row);
        await enqueue({ entity: "parent_notes", record_id: row.id, operation_type: "update", payload: row, school_id: row.school_id });
        hideModal();
        await loadAllLocal();
        toast("تم التعديل", "success");
        navigate("parent_notes");
      };
    }
  });
}

/* ===== Reports ===== */
async function renderReports(c) {
  const role = state.session.role;
  const myStudents = role === "admin" ? state.students : teacherStudents();

  c.innerHTML = `
    <div class="card">
      <h3 class="card-title">التقارير والإحصائيات</h3>
      <div class="form-grid" style="margin-bottom:12px">
        <div class="field"><label>من تاريخ</label><input type="date" id="repFrom" /></div>
        <div class="field"><label>إلى تاريخ</label><input type="date" id="repTo" /></div>
        <div class="field"><label>الصف</label>
          <select id="repClass"><option value="">كل الصفوف</option>
            ${state.classes.map(cl => `<option value="${cl.id}">${escapeHtml(cl.name)}</option>`).join("")}</select></div>
        <div class="field"><label>الفصل</label>
          <select id="repSection"><option value="">كل الفصول</option>
            ${state.sections.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(className(s.class_id))})</option>`).join("")}</select></div>
        <div class="field"><label>بحث بالطالب</label><input id="reportsSearch" placeholder="اسم أو رقم متابعة" /></div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <button class="btn" id="repClearBtn">مسح الفلاتر</button>
        <button class="btn btn-primary" id="exportExcelBtn">📥 تصدير Excel</button>
      </div>
      <div id="reportSummary"></div>
    </div>`;

  const getFilters = () => ({
    from: $("#repFrom").value || null,
    to: $("#repTo").value || null,
    classId: $("#repClass").value || null,
    sectionId: $("#repSection").value || null,
    search: ($("#reportsSearch").value || "").trim()
  });

  const inDateRange = (dateStr, from, to) => {
    if (!dateStr) return false;
    if (from && dateStr < from) return false;
    if (to && dateStr > to) return false;
    return true;
  };

  const buildSummary = () => {
    const filters = getFilters();
    const students = myStudents.filter(s => {
      if (filters.classId && s.class_id !== filters.classId) return false;
      if (filters.sectionId && s.section_id !== filters.sectionId) return false;
      if (filters.search) {
        if (!arabicIncludes(s.full_name, filters.search) && !String(s.tracking_number || "").includes(filters.search)) return false;
      }
      return true;
    });
    const ids = new Set(students.map(s => s.id));

    const dateFilter = (x) => {
      if (!filters.from && !filters.to) return true;
      return inDateRange(x.date, filters.from, filters.to);
    };

    const att = state.attendance.filter(a => ids.has(a.student_id)).filter(dateFilter);
    const grd = state.grades.filter(g => ids.has(g.student_id)).filter(dateFilter);
    const hw = state.homework.filter(h => ids.has(h.student_id)).filter(dateFilter);
    const bh = state.behavior.filter(b => ids.has(b.student_id)).filter(dateFilter);

    const present = att.filter(a => a.status === "present").length;
    const absent = att.filter(a => a.status === "absent").length;
    const late = att.filter(a => a.status === "late").length;
    const avg = grd.length ? (grd.reduce((acc, g) => acc + (g.score / g.max_score) * 100, 0) / grd.length).toFixed(1) : "—";
    const hwCompleted = hw.filter(h => h.homework_status === "completed").length;

    const filterDesc = [];
    if (filters.from) filterDesc.push(`من ${fmtDate(filters.from)}`);
    if (filters.to) filterDesc.push(`إلى ${fmtDate(filters.to)}`);
    if (filters.classId) filterDesc.push(className(filters.classId));
    if (filters.sectionId) filterDesc.push(sectionName(filters.sectionId));
    if (filters.search) filterDesc.push(`بحث: "${escapeHtml(filters.search)}"`);

    $("#reportSummary").innerHTML = `
      <div class="muted small" style="margin-bottom:10px">
        ${filterDesc.length ? `الفلاتر: ${filterDesc.join(" — ")}` : "بدون فلاتر (كل البيانات)"}
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="label">الطلاب</div><div class="value">${students.length}</div></div>
        <div class="stat-card"><div class="label">الحضور</div><div class="value">${present}</div></div>
        <div class="stat-card"><div class="label">الغياب</div><div class="value">${absent}</div></div>
        <div class="stat-card"><div class="label">التأخر</div><div class="value">${late}</div></div>
        <div class="stat-card"><div class="label">متوسط الدرجات</div><div class="value">${avg}%</div></div>
        <div class="stat-card"><div class="label">واجبات مكتملة</div><div class="value">${hwCompleted}</div></div>
        <div class="stat-card"><div class="label">ملاحظات سلوك</div><div class="value">${bh.length}</div></div>
      </div>`;
  };

  const debouncedBuild = debounce(buildSummary, 200);
  $("#repFrom").onchange = buildSummary;
  $("#repTo").onchange = buildSummary;
  $("#repClass").onchange = buildSummary;
  $("#repSection").onchange = buildSummary;
  $("#reportsSearch").oninput = debouncedBuild;
  $("#repClearBtn").onclick = () => {
    $("#repFrom").value = ""; $("#repTo").value = "";
    $("#repClass").value = ""; $("#repSection").value = ""; $("#reportsSearch").value = "";
    buildSummary();
  };

  buildSummary();

  $("#exportExcelBtn").onclick = () => {
    const filters = getFilters();
    const students = myStudents.filter(s => {
      if (filters.classId && s.class_id !== filters.classId) return false;
      if (filters.sectionId && s.section_id !== filters.sectionId) return false;
      if (filters.search) {
        if (!arabicIncludes(s.full_name, filters.search) && !String(s.tracking_number || "").includes(filters.search)) return false;
      }
      return true;
    });
    exportExcel(students, filters);
  };
}

/* ===== CSV export ===== */
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}
function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportExcel(myStudents, filters = {}) {
  try {
    const ids = new Set(myStudents.map(s => s.id));
    const inRange = (d) => {
      if (!d) return false;
      if (filters.from && d < filters.from) return false;
      if (filters.to && d > filters.to) return false;
      return true;
    };
    const dateOK = (x) => {
      if (!filters.from && !filters.to) return true;
      return inRange(x.date);
    };

    const studentsRows = [["الاسم","رقم المتابعة","الصف","الفصل","ولي الأمر","حالة"]];
    myStudents.forEach(s => studentsRows.push([s.full_name, s.tracking_number, className(s.class_id), sectionName(s.section_id), s.parent_name || "", s.status]));

    const gradesRows = [["التاريخ","الطالب","رقم المتابعة","المادة","النوع","الدرجة","الدرجة الكاملة"]];
    state.grades.filter(g => ids.has(g.student_id) && dateOK(g)).forEach(g => {
      const st = state.students.find(s => s.id === g.student_id);
      gradesRows.push([g.date, st?.full_name || "", st?.tracking_number || "", subjectName(g.subject_id), g.assessment_type, g.score, g.max_score]);
    });

    const attRows = [["التاريخ","الطالب","رقم المتابعة","الحالة"]];
    state.attendance.filter(a => ids.has(a.student_id) && dateOK(a)).forEach(a => {
      const st = state.students.find(s => s.id === a.student_id);
      attRows.push([a.date, st?.full_name || "", st?.tracking_number || "", a.status]);
    });

    const hwRows = [["التاريخ","الطالب","المادة","الواجب","الكراسة","ملاحظات"]];
    state.homework.filter(h => ids.has(h.student_id) && dateOK(h)).forEach(h => {
      const st = state.students.find(s => s.id === h.student_id);
      hwRows.push([h.date, st?.full_name || "", subjectName(h.subject_id), hwLabel(h.homework_status), hwLabel(h.notebook_status), h.notes || ""]);
    });

    const bhRows = [["التاريخ","الطالب","النوع","الملاحظة"]];
    state.behavior.filter(b => ids.has(b.student_id) && dateOK(b)).forEach(b => {
      const st = state.students.find(s => s.id === b.student_id);
      bhRows.push([b.date, st?.full_name || "", bhLabel(b.note_type), b.note]);
    });

    const stamp = new Date().toISOString().slice(0,10);
    downloadCSV(`students-${stamp}.csv`, studentsRows);
    downloadCSV(`grades-${stamp}.csv`, gradesRows);
    downloadCSV(`attendance-${stamp}.csv`, attRows);
    downloadCSV(`homework-${stamp}.csv`, hwRows);
    downloadCSV(`behavior-${stamp}.csv`, bhRows);
    toast("تم تصدير الملفات", "success");
  } catch (e) {
    console.error(e);
    toast("فشل التصدير: " + e.message, "error");
  }
}

/* ===== Full backup export ===== */
async function exportFullBackupToCSV() {
  const schoolId = state.session.school_id;
  const school = await idb.get("schools", schoolId) || {};

  const data = {
    school: [school],
    classes: state.classes.filter(x => x.school_id === schoolId),
    sections: state.sections.filter(x => x.school_id === schoolId),
    subjects: state.subjects.filter(x => x.school_id === schoolId),
    teachers: state.teachers.filter(x => x.school_id === schoolId),
    students: state.students.filter(x => x.school_id === schoolId),
    teacher_assignments: state.assignments.filter(x => x.school_id === schoolId),
    schedules: state.schedules.filter(x => x.school_id === schoolId),
    grades: state.grades.filter(x => x.school_id === schoolId),
    attendance: state.attendance.filter(x => x.school_id === schoolId),
    homework: state.homework.filter(x => x.school_id === schoolId),
    behavior_notes: state.behavior.filter(x => x.school_id === schoolId),
    announcements: state.announcements.filter(x => x.school_id === schoolId)
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const schoolSafe = (school.name || "school").replace(/[^\w\u0600-\u06FF-]+/g, "_");
  const progress = [];
  const pushProgress = (msg) => { progress.push(msg); console.log("[Export]", msg); };

  {
    const rows = [
      ["الحقل", "القيمة"],
      ["اسم المدرسة", school.name || ""],
      ["العنوان", school.address || ""],
      ["الهاتف", school.phone || ""],
      ["البريد الإلكتروني", school.email || ""],
      ["السنة الدراسية", school.academic_year || ""],
      ["رابط الشعار", school.logo_url || ""],
      ["تاريخ الإنشاء", school.created_at || ""],
      ["آخر تحديث", school.updated_at || ""]
    ];
    downloadCSV(`${schoolSafe}-01-معلومات-المدرسة-${stamp}.csv`, rows);
    pushProgress("معلومات المدرسة");
    await sleep(350);
  }

  {
    const rows = [["#", "اسم الصف", "تاريخ الإنشاء"]];
    data.classes.forEach((c, i) => rows.push([i + 1, c.name || "", c.created_at || ""]));
    downloadCSV(`${schoolSafe}-02-الصفوف-${stamp}.csv`, rows);
    pushProgress("الصفوف");
    await sleep(350);
  }

  {
    const rows = [["#", "الفصل", "الصف", "تاريخ الإنشاء"]];
    data.sections.forEach((s, i) => rows.push([i + 1, s.name || "", className(s.class_id), s.created_at || ""]));
    downloadCSV(`${schoolSafe}-03-الفصول-${stamp}.csv`, rows);
    pushProgress("الفصول");
    await sleep(350);
  }

  {
    const rows = [["#", "اسم المادة", "تاريخ الإنشاء"]];
    data.subjects.forEach((s, i) => rows.push([i + 1, s.name || "", s.created_at || ""]));
    downloadCSV(`${schoolSafe}-04-المواد-${stamp}.csv`, rows);
    pushProgress("المواد");
    await sleep(350);
  }

  {
    const rows = [["#", "الاسم", "اسم المستخدم", "البريد", "الحالة", "التعيينات", "تاريخ الإنشاء"]];
    data.teachers.forEach((t, i) => {
      const assigns = data.teacher_assignments
        .filter(a => a.teacher_id === t.id)
        .map(a => `${subjectName(a.subject_id)} - ${className(a.class_id)}/${sectionName(a.section_id)}`).join(" | ");
      rows.push([i + 1, t.full_name || "", t.username || "", t.email || "", t.status === "active" ? "نشط" : "معطّل", assigns, t.created_at || ""]);
    });
    downloadCSV(`${schoolSafe}-05-المعلمون-${stamp}.csv`, rows);
    pushProgress("المعلمون");
    await sleep(350);
  }

  {
    const rows = [["#","الاسم","رقم المتابعة","الجنس","تاريخ الميلاد","الصف","الفصل","السنة الدراسية","هاتف الطالب","اسم ولي الأمر","هاتف ولي الأمر","الحالة","تاريخ الإنشاء"]];
    data.students.forEach((s, i) => rows.push([
      i + 1, s.full_name || "", s.tracking_number || "", s.gender === "female" ? "أنثى" : "ذكر", s.birth_date || "",
      className(s.class_id), sectionName(s.section_id), s.academic_year || "", s.phone || "",
      s.parent_name || "", s.parent_phone || "", s.status === "active" ? "نشط" : "مؤرشف", s.created_at || ""
    ]));
    downloadCSV(`${schoolSafe}-06-الطلاب-${stamp}.csv`, rows);
    pushProgress("الطلاب");
    await sleep(350);
  }

  {
    const rows = [["#","المعلم","المادة","الصف","الفصل","تاريخ الإنشاء"]];
    data.teacher_assignments.forEach((a, i) => rows.push([i + 1, teacherName(a.teacher_id), subjectName(a.subject_id), className(a.class_id), sectionName(a.section_id), a.created_at || ""]));
    downloadCSV(`${schoolSafe}-07-التعيينات-${stamp}.csv`, rows);
    pushProgress("التعيينات");
    await sleep(350);
  }

  {
    const rows = [["#","اليوم","من","إلى","المادة","المعلم","الصف","الفصل"]];
    const sorted = data.schedules.slice().sort((a, b) => (a.day_of_week - b.day_of_week) || (a.start_time || "").localeCompare(b.start_time || ""));
    sorted.forEach((s, i) => rows.push([i + 1, DAYS_AR[s.day_of_week] || "", s.start_time || "", s.end_time || "", subjectName(s.subject_id), teacherName(s.teacher_id), className(s.class_id), sectionName(s.section_id)]));
    downloadCSV(`${schoolSafe}-08-الجدول-الأسبوعي-${stamp}.csv`, rows);
    pushProgress("الجدول");
    await sleep(350);
  }

  {
    const rows = [["#","التاريخ","الطالب","رقم المتابعة","الصف","الفصل","المادة","نوع التقييم","الدرجة","الدرجة الكاملة","النسبة %","المعلم"]];
    const sorted = data.grades.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    sorted.forEach((g, i) => {
      const st = data.students.find(s => s.id === g.student_id);
      const pct = g.max_score > 0 ? ((g.score / g.max_score) * 100).toFixed(1) : "";
      rows.push([i + 1, g.date || "", st?.full_name || "", st?.tracking_number || "", className(st?.class_id), sectionName(st?.section_id), subjectName(g.subject_id), g.assessment_type || "", g.score, g.max_score, pct, teacherName(g.teacher_id)]);
    });
    downloadCSV(`${schoolSafe}-09-الدرجات-${stamp}.csv`, rows);
    pushProgress("الدرجات");
    await sleep(350);
  }

  {
    const rows = [["#","التاريخ","الطالب","رقم المتابعة","الصف","الفصل","الحالة","المعلم"]];
    const sorted = data.attendance.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    sorted.forEach((a, i) => {
      const st = data.students.find(s => s.id === a.student_id);
      const status = a.status === "present" ? "حاضر" : a.status === "late" ? "متأخر" : "غائب";
      rows.push([i + 1, a.date || "", st?.full_name || "", st?.tracking_number || "", className(st?.class_id), sectionName(st?.section_id), status, teacherName(a.teacher_id)]);
    });
    downloadCSV(`${schoolSafe}-10-الحضور-${stamp}.csv`, rows);
    pushProgress("الحضور");
    await sleep(350);
  }

  {
    const rows = [["#","التاريخ","الطالب","رقم المتابعة","المادة","حالة الواجب","حالة الكراسة","ملاحظات المعلم","المعلم"]];
    const sorted = data.homework.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    sorted.forEach((h, i) => {
      const st = data.students.find(s => s.id === h.student_id);
      rows.push([i + 1, h.date || "", st?.full_name || "", st?.tracking_number || "", subjectName(h.subject_id), hwLabel(h.homework_status), hwLabel(h.notebook_status), h.notes || "", teacherName(h.teacher_id)]);
    });
    downloadCSV(`${schoolSafe}-11-الواجبات-${stamp}.csv`, rows);
    pushProgress("الواجبات");
    await sleep(350);
  }

  {
    const rows = [["#","التاريخ","الطالب","رقم المتابعة","النوع","الملاحظة","المعلم"]];
    const sorted = data.behavior_notes.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    sorted.forEach((b, i) => {
      const st = data.students.find(s => s.id === b.student_id);
      rows.push([i + 1, b.date || "", st?.full_name || "", st?.tracking_number || "", bhLabel(b.note_type), b.note || "", teacherName(b.teacher_id)]);
    });
    downloadCSV(`${schoolSafe}-12-السلوك-${stamp}.csv`, rows);
    pushProgress("السلوك");
    await sleep(350);
  }

  {
    const rows = [["#","التاريخ","العنوان","المحتوى","الفئة المستهدفة"]];
    const sorted = data.announcements.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    sorted.forEach((a, i) => {
      const audience = a.audience === "teachers" ? "المعلمون" : a.audience === "parents" ? "أولياء الأمور" : "الجميع";
      rows.push([i + 1, a.date || "", a.title || "", a.content || "", audience]);
    });
    downloadCSV(`${schoolSafe}-13-الإعلانات-${stamp}.csv`, rows);
    pushProgress("الإعلانات");
    await sleep(350);
  }

  {
    const notes = state.parentNotes.filter(n => n.school_id === schoolId);
    const rows = [["#","التاريخ","الطالب","رقم المتابعة","الصف","الفصل","المادة","العنوان","المبلغ","العملة","ملاحظة إضافية","الكاتب"]];
    const sorted = notes.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    sorted.forEach((n, i) => {
      const st = state.students.find(s => s.id === n.student_id);
      rows.push([
        i + 1, n.date || "", st?.full_name || "", st?.tracking_number || "",
        className(st?.class_id), sectionName(st?.section_id),
        n.subject_id ? subjectName(n.subject_id) : "عام",
        n.title || "المتبقي من الرسوم",
        (n.amount !== null && n.amount !== undefined) ? n.amount : "",
        n.currency || "", n.body || "", teacherName(n.teacher_id) || "المدير"
      ]);
    });
    downloadCSV(`${schoolSafe}-14-المتبقي-من-الرسوم-${stamp}.csv`, rows);
    pushProgress("المتبقي من الرسوم");
    await sleep(350);
  }

  return {
    fileCount: 14,
    schoolName: school.name || "",
    stamp,
    files: progress,
    counts: {
      students: data.students.length,
      teachers: data.teachers.length,
      classes: data.classes.length,
      sections: data.sections.length,
      subjects: data.subjects.length,
      assignments: data.teacher_assignments.length,
      schedules: data.schedules.length,
      grades: data.grades.length,
      attendance: data.attendance.length,
      homework: data.homework.length,
      behavior: data.behavior_notes.length,
      announcements: data.announcements.length
    }
  };
}

/* ===== Files ===== */
async function renderFiles(c) {
  const isAdmin = state.session.role === "admin";

  c.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="filesSearch" class="search-input" placeholder="ابحث باسم الملف أو النوع أو الفئة" />
        ${isAdmin ? `
          <select id="filesCategoryFilter" class="search-input" style="max-width:200px">
            <option value="">كل الفئات</option>
            <option value="documents">مستندات</option>
            <option value="exams">اختبارات</option>
            <option value="reports">تقارير</option>
            <option value="other">أخرى</option>
          </select>
          <button class="btn btn-primary" id="uploadFileBtn">⬆ رفع ملف</button>
        ` : ``}
      </div>
      <div id="filesList" class="row" style="gap:10px; flex-wrap:wrap"></div>
      <div id="filesStatus" class="muted small" style="margin-top:10px"></div>
    </div>`;

  let allFiles = [];
  const status = $("#filesStatus");

  const loadFiles = async () => {
    if (!isOnline()) {
      const local = await idb.getAll("school_files");
      allFiles = local.filter(f => f.school_id === state.session.school_id);
      status.textContent = "أنت بدون اتصال. يتم عرض الملفات المخزنة محليًا.";
      renderList();
      return;
    }
    try {
      status.textContent = "جارٍ تحميل الملفات...";
      const cats = ["documents", "exams", "reports", "other"];
      const collected = [];
      for (const cat of cats) {
        try {
          const items = await storageListFiles(state.session.school_id, cat);
          for (const it of items) {
            if (it.name === ".emptyFolderPlaceholder") continue;
            collected.push({
              id: `${cat}/${it.name}`,
              school_id: state.session.school_id,
              category: cat,
              filename: it.name,
              path: `${state.session.school_id}/${cat}/${it.name}`,
              size: it.metadata?.size || 0,
              content_type: it.metadata?.mimetype || "",
              created_at: it.created_at || new Date().toISOString()
            });
          }
        } catch (e) { console.warn(cat, e); }
      }
      allFiles = collected;
      await idb.bulkPut("school_files", allFiles);
      status.textContent = "";
      renderList();
    } catch (e) {
      console.error(e);
      status.textContent = "فشل التحميل، يتم العرض من الذاكرة المحلية";
      const local = await idb.getAll("school_files");
      allFiles = local.filter(f => f.school_id === state.session.school_id);
      renderList();
    }
  };

  const renderList = (filter = "") => {
    const catFilter = $("#filesCategoryFilter")?.value || "";
    const rows = allFiles.filter(x => {
      if (catFilter && x.category !== catFilter) return false;
      if (!filter) return true;
      return arabicIncludes(x.filename, filter)
        || arabicIncludes(x.category, filter)
        || arabicIncludes(x.content_type, filter);
    });
    const el = $("#filesList");
    if (!rows.length) { el.innerHTML = `<div class="empty-state">لا ملفات</div>`; return; }
    el.innerHTML = rows.map(f => `
      <div class="list-item" style="min-width:200px; max-width:300px; flex:1">
        <div class="list-item-title">${escapeHtml(f.filename)}</div>
        <div class="muted small">${escapeHtml(f.category)} — ${(f.size / 1024).toFixed(1)} KB</div>
        <div class="row" style="margin-top:6px">
          <button class="btn btn-sm" data-dl="${encodeURIComponent(f.path)}">تنزيل</button>
          ${isAdmin ? `<button class="btn btn-sm btn-danger" data-rm="${encodeURIComponent(f.path)}">حذف</button>` : ``}
        </div>
      </div>`).join("");
    el.querySelectorAll("[data-dl]").forEach(b => b.onclick = async () => {
      try {
        const path = decodeURIComponent(b.dataset.dl);
        const url = await storageGetSignedUrl(path, 3600);
        window.open(url, "_blank");
      } catch (e) { toast("فشل التنزيل: " + e.message, "error"); }
    });
    el.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => {
      if (!confirm("هل تريد حذف هذا الملف؟")) return;
      try {
        const path = decodeURIComponent(b.dataset.rm);
        await storageDeleteFile(path);
        toast("تم الحذف", "success");
        await loadFiles();
      } catch (e) { toast("فشل الحذف: " + e.message, "error"); }
    });
  };

  $("#filesSearch").oninput = debounce(e => renderList(e.target.value), 200);
  if ($("#filesCategoryFilter")) $("#filesCategoryFilter").onchange = () => renderList($("#filesSearch").value);
  if (isAdmin) $("#uploadFileBtn").onclick = () => openUploadFileModal(loadFiles);
  await loadFiles();
}

function openUploadFileModal(onDone) {
  showModal({
    title: "رفع ملف جديد",
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label>الفئة</label>
          <select id="upCategory">
            <option value="documents">مستندات</option>
            <option value="exams">اختبارات</option>
            <option value="reports">تقارير</option>
            <option value="other">أخرى</option>
          </select></div>
        <div class="field" style="grid-column:1/-1"><label>الملف</label><input type="file" id="upFile" /></div>
      </div>
      <div id="upError" class="error-msg" hidden></div>
    `,
    footerHtml: `
      <button class="btn" data-close>إلغاء</button>
      <button class="btn btn-primary" id="upBtn">رفع</button>
    `,
    onMount: () => {
      $("#upBtn").onclick = async () => {
        const f = $("#upFile").files[0];
        const cat = $("#upCategory").value;
        const err = $("#upError");
        err.hidden = true;
        if (!f) { err.hidden = false; err.textContent = "اختر ملفًا"; return; }
        if (!isOnline()) { err.hidden = false; err.textContent = "يتطلب الاتصال بالإنترنت"; return; }
        if (f.size > 20 * 1024 * 1024) { err.hidden = false; err.textContent = "الحد الأقصى 20MB"; return; }
        try {
          await storageUploadFile(state.session.school_id, cat, f, f.name, f.type);
          hideModal();
          toast("تم رفع الملف", "success");
          if (onDone) await onDone();
        } catch (e) {
          err.hidden = false;
          err.textContent = e.message;
        }
      };
    }
  });
}

/* ===== Settings ===== */
async function renderSettings(c) {
  if (state.session.role !== "admin") {
    c.innerHTML = `<div class="card"><div class="error-msg">لا تملك صلاحية الوصول</div></div>`;
    return;
  }
  const sc = state.school || {};
  c.innerHTML = `
    <div class="card">
      <h3 class="card-title">إعدادات المدرسة</h3>
      <div class="form-grid">
        <div class="field"><label>اسم المدرسة</label><input id="setName" value="${escapeHtml(sc.name || "")}" /></div>
        <div class="field"><label>العنوان</label><input id="setAddress" value="${escapeHtml(sc.address || "")}" /></div>
        <div class="field"><label>الهاتف</label><input id="setPhone" value="${escapeHtml(sc.phone || "")}" /></div>
        <div class="field"><label>البريد الإلكتروني</label><input id="setEmail" value="${escapeHtml(sc.email || "")}" /></div>
        <div class="field"><label>السنة الدراسية</label><input id="setYear" value="${escapeHtml(sc.academic_year || "")}" /></div>
        <div class="field" style="grid-column:1/-1">
          <label>شعار المدرسة</label>
          <div class="row">
            <input type="file" id="setLogoFile" accept="image/*" />
            <button class="btn btn-sm" id="uploadLogoBtn">📤 رفع الشعار</button>
            ${sc.logo_url ? `<button class="btn btn-sm btn-danger" id="removeLogoBtn">🗑️ حذف الشعار</button>` : ``}
            ${sc.logo_url ? `<img src="${escapeHtml(sc.logo_url)}" style="width:48px;height:48px;border-radius:8px;object-fit:cover" />` : ``}
          </div>
          <input type="hidden" id="setLogo" value="${escapeHtml(sc.logo_url || "")}" />
        </div>
      </div>
      <button class="btn btn-primary" id="saveSchoolBtn" style="margin-top:12px">حفظ الإعدادات</button>
    </div>

    <div class="card">
      <h3 class="card-title">الصفوف والفصول والمواد</h3>
      <div class="row" style="gap:20px; flex-wrap:wrap">
        <div style="min-width:220px">
          <h4>الصفوف</h4>
          <div id="classList"></div>
          <div class="row" style="margin-top:8px">
            <input id="newClass" placeholder="اسم الصف" />
            <button class="btn btn-sm btn-primary" id="addClassBtn">إضافة</button>
          </div>
        </div>
        <div style="min-width:220px">
          <h4>الفصول</h4>
          <div id="sectionList"></div>
          <div class="row" style="margin-top:8px">
            <select id="secClass"></select>
            <input id="newSection" placeholder="اسم الفصل" />
            <button class="btn btn-sm btn-primary" id="addSectionBtn">إضافة</button>
          </div>
        </div>
        <div style="min-width:220px">
          <h4>المواد</h4>
          <div id="subjectList"></div>
          <div class="row" style="margin-top:8px">
            <input id="newSubject" placeholder="اسم المادة" />
            <button class="btn btn-sm btn-primary" id="addSubjectBtn">إضافة</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">النسخ الاحتياطي والاستعادة والتصدير</h3>
      <p class="muted small">احفظ نسخة كاملة من بيانات مدرستك بضغطة واحدة.</p>
      <div class="row" style="margin-bottom:10px">
        <button class="btn btn-primary" id="backupBtn">💾 نسخة احتياطية كاملة (JSON)</button>
        <button class="btn btn-primary" id="fullExcelBtn">📥 تصدير كل البيانات (Excel)</button>
        <button class="btn" id="restoreBtn">📂 استعادة نسخة احتياطية (JSON)</button>
      </div>
      <div style="background:var(--primary-light); padding:10px 12px; border-radius:8px; font-size:13px; line-height:1.7">
        <strong>📄 نسخة JSON</strong> — نسخة كاملة قابلة للاستعادة داخل النظام.<br>
        <strong>📊 نسخة Excel</strong> — 14 ملف CSV (يفتح في Excel مباشرة)، لكل جدول ملف منفصل.
      </div>
      <input type="file" id="restoreFile" accept="application/json" hidden />
    </div>

    <div class="card" style="border:1px solid #fecaca">
      <h3 class="card-title" style="color:var(--danger)">منطقة الخطر — حذف جميع بيانات المدرسة</h3>
      <p class="muted small">هذا الإجراء يحذف كل بيانات مدرستك الأكاديمية وحسابات المعلمين. يبقى حسابك وحساب المدرسة.</p>
      <button class="btn btn-danger" id="deleteSchoolDataBtn">حذف جميع البيانات</button>
    </div>
  `;

  const renderClassList = () => {
    $("#classList").innerHTML = state.classes.map(cl => `
      <div class="row" style="justify-content:space-between">
        <span>${escapeHtml(cl.name)}</span>
        <button class="btn btn-sm btn-danger" data-delclass="${cl.id}">×</button>
      </div>`).join("") || `<div class="muted small">لا صفوف</div>`;
    $$("#classList [data-delclass]").forEach(b => b.onclick = async () => {
      const id = b.dataset.delclass;
      await idb.delete("classes", id);
      await enqueue({ entity: "classes", record_id: id, operation_type: "delete", payload: null, school_id: state.session.school_id });
      await loadAllLocal();
      navigate("settings");
    });
    $("#secClass").innerHTML = state.classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  };
  const renderSectionList = () => {
    $("#sectionList").innerHTML = state.sections.map(s => `
      <div class="row" style="justify-content:space-between">
        <span>${escapeHtml(s.name)} (${escapeHtml(className(s.class_id))})</span>
        <button class="btn btn-sm btn-danger" data-delsection="${s.id}">×</button>
      </div>`).join("") || `<div class="muted small">لا فصول</div>`;
    $$("#sectionList [data-delsection]").forEach(b => b.onclick = async () => {
      const id = b.dataset.delsection;
      await idb.delete("sections", id);
      await enqueue({ entity: "sections", record_id: id, operation_type: "delete", payload: null, school_id: state.session.school_id });
      await loadAllLocal();
      navigate("settings");
    });
  };
  const renderSubjectList = () => {
    $("#subjectList").innerHTML = state.subjects.map(s => `
      <div class="row" style="justify-content:space-between">
        <span>${escapeHtml(s.name)}</span>
        <button class="btn btn-sm btn-danger" data-delsubject="${s.id}">×</button>
      </div>`).join("") || `<div class="muted small">لا مواد</div>`;
    $$("#subjectList [data-delsubject]").forEach(b => b.onclick = async () => {
      const id = b.dataset.delsubject;
      await idb.delete("subjects", id);
      await enqueue({ entity: "subjects", record_id: id, operation_type: "delete", payload: null, school_id: state.session.school_id });
      await loadAllLocal();
      navigate("settings");
    });
  };
  renderClassList(); renderSectionList(); renderSubjectList();

  $("#uploadLogoBtn").onclick = async () => {
    try {
      const f = $("#setLogoFile").files[0];
      if (!f) { toast("اختر صورة أولاً", "error"); return; }
      if (!isOnline()) { toast("رفع الشعار يتطلب الاتصال", "error"); return; }
      if (f.size > 5 * 1024 * 1024) { toast("حجم الصورة كبير جدًا", "error"); return; }
      toast("جارٍ رفع الشعار...", "info");
      const path = await storageUploadFile(state.session.school_id, "logos", f, f.name, f.type);
      if (state.school?.logo_path && state.school.logo_path !== path) {
        try { await storageDeleteFile(state.school.logo_path); } catch (e) { console.warn(e); }
      }
      const url = await storageGetSignedUrl(path, 60 * 60 * 24 * 365);
      const updated = { ...(state.school || { id: state.session.school_id }), logo_url: url, logo_path: path, updated_at: new Date().toISOString() };
      await idb.put("schools", updated);
      await enqueue({ entity: "schools", record_id: updated.id, operation_type: "update", payload: updated, school_id: updated.id });
      state.school = updated;
      applySchoolBranding();
      toast("تم رفع الشعار", "success");
      navigate("settings");
    } catch (e) {
      console.error(e);
      toast("فشل الرفع: " + e.message, "error");
    }
  };

  const removeBtn = $("#removeLogoBtn");
  if (removeBtn) {
    removeBtn.onclick = async () => {
      if (!confirm("هل تريد حذف الشعار؟")) return;
      try {
        if (state.school?.logo_path) {
          try { await storageDeleteFile(state.school.logo_path); } catch (e) { console.warn(e); }
        }
        const updated = { ...(state.school || { id: state.session.school_id }), logo_url: null, logo_path: null, updated_at: new Date().toISOString() };
        await idb.put("schools", updated);
        await enqueue({ entity: "schools", record_id: updated.id, operation_type: "update", payload: updated, school_id: updated.id });
        state.school = updated;
        applySchoolBranding();
        toast("تم حذف الشعار", "success");
        navigate("settings");
      } catch (e) { toast("فشل الحذف: " + e.message, "error"); }
    };
  }

  $("#saveSchoolBtn").onclick = async () => {
    const row = {
      id: state.session.school_id,
      name: $("#setName").value.trim() || "المدرسة",
      address: $("#setAddress").value.trim() || null,
      phone: $("#setPhone").value.trim() || null,
      email: $("#setEmail").value.trim() || null,
      academic_year: $("#setYear").value.trim() || null,
      logo_url: $("#setLogo").value.trim() || null,
      logo_path: state.school?.logo_path || null,
      created_at: state.school?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await idb.put("schools", row);
    await enqueue({ entity: "schools", record_id: row.id, operation_type: "update", payload: row, school_id: row.id });
    state.school = row;
    applySchoolBranding();
    toast("تم الحفظ", "success");
  };

  $("#addClassBtn").onclick = async () => {
    const name = $("#newClass").value.trim();
    if (!name) return;
    if (state.classes.find(c => c.name === name)) { toast("الصف موجود", "error"); return; }
    const row = { id: uuid(), school_id: state.session.school_id, name, created_at: new Date().toISOString() };
    await idb.put("classes", row);
    await enqueue({ entity: "classes", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });
    await loadAllLocal();
    navigate("settings");
  };
  $("#addSectionBtn").onclick = async () => {
    const name = $("#newSection").value.trim();
    const classId = $("#secClass").value;
    if (!name || !classId) return;
    const row = { id: uuid(), school_id: state.session.school_id, class_id: classId, name, created_at: new Date().toISOString() };
    await idb.put("sections", row);
    await enqueue({ entity: "sections", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });
    await loadAllLocal();
    navigate("settings");
  };
  $("#addSubjectBtn").onclick = async () => {
    const name = $("#newSubject").value.trim();
    if (!name) return;
    if (state.subjects.find(s => s.name === name)) { toast("المادة موجودة", "error"); return; }
    const row = { id: uuid(), school_id: state.session.school_id, name, created_at: new Date().toISOString() };
    await idb.put("subjects", row);
    await enqueue({ entity: "subjects", record_id: row.id, operation_type: "insert", payload: row, school_id: row.school_id });
    await loadAllLocal();
    navigate("settings");
  };

  $("#backupBtn").onclick = async () => {
    try { await createBackup(); toast("تم إنشاء النسخة الاحتياطية", "success"); }
    catch (e) { toast("فشل النسخ: " + e.message, "error"); }
  };
  $("#restoreBtn").onclick = () => $("#restoreFile").click();
  $("#restoreFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await restoreBackup(f);
      toast("تمت الاستعادة", "success");
      await loadAllLocal();
      await loadSchool();
      navigate("dashboard");
    } catch (err) {
      console.error(err);
      toast("فشل الاستعادة: " + err.message, "error");
    }
    e.target.value = "";
  };

  $("#fullExcelBtn").onclick = async () => {
    const counts = {
      students: state.students.filter(s => s.school_id === state.session.school_id).length,
      teachers: state.teachers.filter(t => t.school_id === state.session.school_id).length,
      grades: state.grades.filter(g => g.school_id === state.session.school_id).length,
      attendance: state.attendance.filter(a => a.school_id === state.session.school_id).length
    };

    const confirmed = confirm(
      "سيتم تنزيل 14 ملف CSV (Excel) تحتوي على كامل بيانات مدرستك:\n\n" +
      `- الطلاب: ${counts.students}\n` +
      `- المعلمون: ${counts.teachers}\n` +
      `- الدرجات: ${counts.grades}\n` +
      `- الحضور: ${counts.attendance}\n` +
      "- الجداول، الواجبات، السلوك، الإعلانات، الصفوف، الفصول، المواد، المتبقي من الرسوم\n\n" +
      "قد يستغرق التصدير 10-20 ثانية.\n\n" +
      "هل تريد المتابعة؟"
    );
    if (!confirmed) return;

    const btn = $("#fullExcelBtn");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳ جارٍ التصدير...";

    const progressToast = document.createElement("div");
    progressToast.className = "toast toast-info";
    progressToast.textContent = "جارٍ تجهيز الملفات...";
    $("#toastContainer").appendChild(progressToast);

    try {
      const result = await exportFullBackupToCSV();
      progressToast.textContent = `✅ تم تصدير ${result.fileCount} ملف بنجاح`;
      progressToast.className = "toast toast-success";
      setTimeout(() => progressToast.remove(), 5000);
      toast(`تم التصدير — ${result.counts.students} طالب، ${result.counts.grades} درجة`, "success", 7000);
    } catch (e) {
      console.error(e);
      progressToast.textContent = "❌ فشل التصدير";
      progressToast.className = "toast toast-error";
      setTimeout(() => progressToast.remove(), 5000);
      toast("فشل التصدير: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };

  $("#deleteSchoolDataBtn").onclick = () => openDeleteSchoolDataDialog();
}

/* ===== Account ===== */
async function renderAccount(c) {
  const s = state.session;
  c.innerHTML = `
    <div class="card">
      <h3 class="card-title">حسابي</h3>
      <p><strong>الاسم:</strong> ${escapeHtml(s.full_name || "")}</p>
      <p><strong>البريد:</strong> ${escapeHtml(s.email || "")}</p>
      <p><strong>الدور:</strong> ${s.role === "admin" ? "مدير" : "معلم"}</p>
      <h4>تغيير كلمة المرور</h4>
      <div class="form-grid">
        <div class="field"><label>كلمة المرور الجديدة</label><input type="password" id="newPwd" /></div>
        <div class="field"><label>تأكيد كلمة المرور</label><input type="password" id="newPwd2" /></div>
      </div>
      <button class="btn btn-primary" id="changePwdBtn" style="margin-top:12px">تغيير كلمة المرور</button>
    </div>`;
  $("#changePwdBtn").onclick = async () => {
    const p1 = $("#newPwd").value;
    const p2 = $("#newPwd2").value;
    if (!p1 || p1.length < 6) { toast("كلمة المرور يجب أن تكون 6 أحرف على الأقل", "error"); return; }
    if (p1 !== p2) { toast("كلمتا المرور غير متطابقتين", "error"); return; }
    try { await changePassword(p1); toast("تم تغيير كلمة المرور", "success"); }
    catch (e) { toast("فشل التغيير: " + e.message, "error"); }
  };
}

/* ===== Forced password change ===== */
async function showForcedPasswordChange() {
  $("#navMenu").innerHTML = "";
  $("#pageTitle").textContent = "تغيير كلمة المرور إجباري";
  const c = $("#pageContent");
  c.innerHTML = `
    <div class="card" style="max-width:500px; margin:40px auto">
      <h3 class="card-title">مرحبًا ${escapeHtml(state.session.full_name || "")}</h3>
      <p class="muted">يجب تغيير كلمة المرور قبل استخدام النظام.</p>
      <div class="form-grid">
        <div class="field"><label>كلمة المرور الجديدة</label><input type="password" id="forcedPwd1" /></div>
        <div class="field"><label>تأكيد كلمة المرور</label><input type="password" id="forcedPwd2" /></div>
      </div>
      <button class="btn btn-primary btn-block" id="forcedPwdBtn" style="margin-top:14px">تغيير كلمة المرور والمتابعة</button>
      <div id="forcedPwdError" class="error-msg" hidden></div>
      <button class="btn btn-ghost btn-block" id="forcedLogoutBtn" style="margin-top:10px">تسجيل الخروج</button>
    </div>
  `;
  $("#forcedPwdBtn").onclick = async () => {
    const p1 = $("#forcedPwd1").value;
    const p2 = $("#forcedPwd2").value;
    const err = $("#forcedPwdError");
    err.hidden = true;
    if (!p1 || p1.length < 6) { err.hidden = false; err.textContent = "كلمة المرور 6 أحرف على الأقل"; return; }
    if (p1 !== p2) { err.hidden = false; err.textContent = "كلمتا المرور غير متطابقتين"; return; }
    try {
      await changePassword(p1);
      state.session.must_change_password = false;
      toast("تم تغيير كلمة المرور", "success");
      buildMenu();
      await navigate("dashboard");
    } catch (e) {
      err.hidden = false;
      err.textContent = "فشل التغيير: " + e.message;
    }
  };
  $("#forcedLogoutBtn").onclick = async () => { await logout(); location.reload(); };
}

/* ===== Backup / Restore ===== */
async function createBackup() {
  const schoolId = state.session.school_id;
  const school = await idb.get("schools", schoolId) || {};
  const storesToDump = [
    "students","teachers","classes","sections","subjects","teacher_assignments",
    "schedules","attendance","grades","homework","behavior_notes","announcements","parent_notes"
  ];
  const data = {};
  for (const name of storesToDump) {
    const all = await idb.getAll(name);
    data[name] = all.filter(x => x.school_id === schoolId);
  }
  const backup = { version: 1, created_at: new Date().toISOString(), school, data };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const safeName = (school.name || "school").replace(/[^\w\u0600-\u06FF-]+/g, "_");
  const filename = `${safeName}-backup-${stamp}.json`;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

async function validateBackup(obj) {
  if (!obj || typeof obj !== "object") throw new Error("ملف غير صالح");
  if (obj.version !== 1) throw new Error("إصدار النسخة غير مدعوم");
  if (!obj.school || !obj.school.id) throw new Error("بيانات المدرسة ناقصة");
  if (!obj.data || typeof obj.data !== "object") throw new Error("بيانات الجداول ناقصة");
  const required = ["students","teachers","classes","sections","subjects","schedules","attendance","grades","homework","behavior_notes","announcements"];
  for (const k of required) {
    if (!Array.isArray(obj.data[k])) throw new Error(`جدول ${k} ناقص أو تالف`);
  }
  return true;
}

async function restoreBackup(file) {
  const text = await file.text();
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error("الملف ليس JSON صالحًا"); }
  await validateBackup(obj);
  const ok = confirm(`سيتم إدخال بيانات النسخة الاحتياطية.\nاسم المدرسة: ${obj.school.name || ""}\nالتاريخ: ${obj.created_at}\n\nهل تريد المتابعة؟`);
  if (!ok) return;
  const schoolId = state.session.school_id;
  await idb.put("schools", { ...obj.school, id: schoolId });
  await enqueue({ entity: "schools", record_id: schoolId, operation_type: "update", payload: { ...obj.school, id: schoolId }, school_id: schoolId });
  const tables = ["students","teachers","classes","sections","subjects","teacher_assignments",
    "schedules","attendance","grades","homework","behavior_notes","announcements","parent_notes"];
  for (const t of tables) {
    const rows = obj.data[t] || [];
    for (const raw of rows) {
      const r = { ...raw, school_id: schoolId };
      await idb.put(t, r);
      await enqueue({ entity: t, record_id: r.id, operation_type: "insert", payload: r, school_id: schoolId });
    }
  }
  return true;
}

/* ===== Delete school data ===== */
async function openDeleteSchoolDataDialog() {
  showModal({
    title: "⚠️ حذف جميع بيانات المدرسة",
    bodyHtml: `
      <div class="error-msg" style="font-size:14px">
        <strong>هذا الإجراء خطير جدًا!</strong> سيتم حذف كل البيانات الأكاديمية وحسابات المعلمين من مدرستك.
        <br><br>
        <strong>ما سيُحذف:</strong>
        <ul>
          <li>كل الطلاب وبياناتهم ودرجاتهم وحضورهم وسلوكهم</li>
          <li>كل المعلمين وحسابات دخولهم</li>
          <li>كل الصفوف والفصول والمواد والجداول</li>
          <li>كل الإعلانات وتنبيهات الرسوم</li>
          <li>كل الملفات المرفوعة</li>
        </ul>
        <strong>ما سيبقى:</strong>
        <ul>
          <li>بيانات المدرسة (الاسم، الشعار، السنة الدراسية)</li>
          <li>حسابك كمدير</li>
        </ul>
        <strong>لا يمكن التراجع بعد التنفيذ.</strong>
      </div>
      <p style="margin-top:12px">اكتب العبارة التالية بالضبط للتأكيد:</p>
      <p style="text-align:center"><strong>DELETE SCHOOL DATA</strong></p>
      <input id="delConfirm" style="width:100%" autocomplete="off" />
      <label style="display:flex;gap:8px;margin-top:10px;align-items:center">
        <input type="checkbox" id="delBackup" checked /> إنشاء نسخة احتياطية قبل الحذف (موصى به بشدة)
      </label>
      <label style="display:flex;gap:8px;margin-top:8px;align-items:center">
        <input type="checkbox" id="delTeachersConfirm" /> أؤكد أنني أريد حذف حسابات دخول المعلمين أيضًا
      </label>
    `,
    footerHtml: `<button class="btn" data-close>إلغاء</button>
      <button class="btn btn-danger" id="confirmDeleteBtn">تنفيذ الحذف</button>`,
    onMount: () => {
      $("#confirmDeleteBtn").onclick = async () => {
        const txt = $("#delConfirm").value.trim();
        const backup = $("#delBackup").checked;
        const delTeachers = $("#delTeachersConfirm").checked;
        if (txt !== "DELETE SCHOOL DATA") { toast("نص التأكيد غير صحيح", "error"); return; }
        if (!delTeachers) { toast("يجب تحديد مربع حذف حسابات المعلمين للمتابعة", "error"); return; }
        if (!confirm("تأكيد نهائي: لا يمكن التراجع. هل أنت متأكد؟")) return;
        if (!isOnline()) { toast("عملية الحذف تتطلب الاتصال بالإنترنت", "error"); return; }

        try {
          if (backup) {
            toast("جارٍ إنشاء نسخة احتياطية...", "info");
            await createBackup();
            await new Promise(r => setTimeout(r, 800));
          }
          toast("جارٍ الحذف...", "info");
          const res = await callDeleteSchoolData(txt, delTeachers);

          const schoolId = state.session.school_id;
          const storesToClean = [
            "students","teachers","classes","sections","subjects","teacher_assignments",
            "schedules","attendance","grades","homework","behavior_notes","announcements",
            "school_files","parent_cache","parent_notes"
          ];
          for (const name of storesToClean) await idb.clear(name);
          await idb.clear("sync_queue");
          await idb.clear("profiles");
          await idb.put("profiles", {
            id: state.session.user_id,
            school_id: schoolId,
            role: "admin",
            full_name: state.session.full_name || "المدير",
            must_change_password: false
          });

          hideModal();
          toast(`تم الحذف. بقي حسابك وحساب المدرسة. عدد المعلمين المحذوفين: ${res.deleted_teachers_auth || 0}`, "success", 6000);
          await loadAllLocal();
          await loadSchool();
          navigate("dashboard");
        } catch (e) {
          console.error(e);
          toast("فشل الحذف: " + e.message, "error", 6000);
        }
      };
    }
  });
}

/* ===== Parent Portal ===== */
function showParentScreen() {
  $("#loginScreen").hidden = true;
  $("#parentScreen").hidden = false;
  $("#app").hidden = true;
  // ضمان إخفاء عناصر اللوحة
  const sidebar = $("#sidebar");
  if (sidebar) sidebar.style.display = "none";
  const topbar = $(".topbar");
  if (topbar) topbar.style.display = "none";
  const main = $(".main");
  if (main) main.style.display = "none";
}
function showLoginScreen() {
  $("#loginScreen").hidden = false;
  $("#parentScreen").hidden = true;
  $("#app").hidden = true;
  // ضمان إخفاء أي عناصر من اللوحة
  const sidebar = $("#sidebar");
  if (sidebar) sidebar.style.display = "none";
  const topbar = $(".topbar");
  if (topbar) topbar.style.display = "none";
  const main = $(".main");
  if (main) main.style.display = "none";
}
function showApp() {
  $("#loginScreen").hidden = true;
  $("#parentScreen").hidden = true;
  $("#app").hidden = false;
  // إعادة إظهار عناصر اللوحة
  const sidebar = $("#sidebar");
  if (sidebar) sidebar.style.display = "";
  const topbar = $(".topbar");
  if (topbar) topbar.style.display = "";
  const main = $(".main");
  if (main) main.style.display = "";
}

async function saveParentCache(trackingNumber, name, data) {
  const cacheKey = `${trackingNumber}_${name.toLowerCase().trim()}`;
  const entry = {
    cache_key: cacheKey,
    school_id: data.student.school_id,
    student_id: data.student.id,
    data,
    updated_at: new Date().toISOString()
  };
  await idb.put("parent_cache", entry);
}

async function getParentCache(trackingNumber, name) {
  const cacheKey = `${trackingNumber}_${name.toLowerCase().trim()}`;
  return idb.get("parent_cache", cacheKey);
}

function buildParentNotifications(parentSession) {
  const notifications = [];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const threshold7days = now - 7 * DAY;
  const threshold3days = now - 3 * DAY;

  const recentAbsences = (parentSession.attendance || []).filter(a => a.status === "absent" && new Date(a.date).getTime() >= threshold7days);
  recentAbsences.forEach(a => {
    notifications.push({
      id: `att_${a.id || a.date}`, type: "absent", icon: "⚠️", severity: "danger",
      title: "غياب", message: `غاب الطالب بتاريخ ${fmtDate(a.date)}`, date: a.date, ref_id: a.id || a.date
    });
  });

  const recentBehavior = (parentSession.behavior || []).filter(b => b.note_type === "warning" && new Date(b.date).getTime() >= threshold7days);
  recentBehavior.forEach(b => {
    notifications.push({
      id: `bh_${b.id}`, type: "behavior", icon: "⚠️", severity: "warning",
      title: "تنبيه سلوكي", message: b.note, date: b.date, ref_id: b.id
    });
  });

  const recentHw = (parentSession.homework || []).filter(h => (h.homework_status === "incomplete" || h.homework_status === "not_submitted") && new Date(h.date).getTime() >= threshold7days);
  recentHw.forEach(h => {
    notifications.push({
      id: `hw_${h.id}`, type: "homework", icon: "📝", severity: "warning",
      title: "واجب غير مكتمل", message: `${subjectName(h.subject_id)} — ${hwLabel(h.homework_status)}`, date: h.date, ref_id: h.id
    });
  });

  const recentGrades = (parentSession.grades || []).filter(g => new Date(g.date).getTime() >= threshold3days);
  recentGrades.forEach(g => {
    const pct = g.max_score > 0 ? Math.round((g.score / g.max_score) * 100) : 0;
    const severity = pct < 50 ? "danger" : pct < 70 ? "warning" : "info";
    notifications.push({
      id: `gr_${g.id}`, type: "grade", icon: "📊", severity,
      title: "درجة جديدة", message: `${subjectName(g.subject_id)} — ${g.assessment_type}: ${g.score}/${g.max_score} (${pct}%)`, date: g.date, ref_id: g.id
    });
  });

  const recentAn = (parentSession.announcements || []).filter(a => new Date(a.date).getTime() >= threshold3days);
  recentAn.forEach(a => {
    notifications.push({
      id: `an_${a.id}`, type: "announcement", icon: "📢", severity: "info",
      title: a.title, message: a.content, date: a.date, ref_id: a.id
    });
  });

  // إنذارات أكاديمية
  try {
    const studentAlerts = computeStudentAlertsForParent(parentSession);
    studentAlerts.forEach(a => {
      notifications.push({
        id: `alert_${a.type}_${a.ref_id}_${a.date || ""}`, type: "alert", icon: a.icon, severity: a.severity,
        title: a.title, message: a.message, date: a.date || todayISO(), ref_id: a.ref_id
      });
    });
  } catch (e) { console.warn("alert build error", e); }

  // المتبقي من الرسوم
  const notes = parentSession.notes || [];
  notes.forEach(n => {
    const amountTxt = (n.amount !== null && n.amount !== undefined && n.amount !== "")
      ? `${Number(n.amount).toLocaleString("ar-EG")} ${n.currency || "جنيه"}` : null;
    const subjectTxt = n.subject_id ? ` [${subjectName(n.subject_id)}]` : "";
    const msg = amountTxt
      ? `المتبقي: ${amountTxt}${subjectTxt}${n.body ? ` — ${n.body}` : ""}`
      : (n.body ? `${n.body}${subjectTxt}` : "تنبيه من المدرسة");
    notifications.push({
      id: `note_${n.id}`, type: "note", icon: "💰", severity: "danger",
      title: (n.title || "المتبقي من الرسوم") + (n.subject_id ? ` — ${subjectName(n.subject_id)}` : ""),
      message: msg, date: n.date, ref_id: n.id
    });
  });

  notifications.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return notifications;
}

function computeStudentAlertsForParent(parentSession) {
  const st = parentSession.student;
  if (!st) return [];
  const att = parentSession.attendance || [];
  const grd = parentSession.grades || [];
  const hw = parentSession.homework || [];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const attCutoff = now - 30 * DAY;
  const alerts = [];

  const recentAbs = att.filter(a => a.status === "absent" && new Date(a.date).getTime() >= attCutoff);
  if (recentAbs.length >= 3) {
    alerts.push({
      type: "attendance_repeated", severity: recentAbs.length >= 5 ? "danger" : "warning",
      icon: "🚨", title: "غياب متكرر", message: `${recentAbs.length} غيابات خلال آخر 30 يوم`,
      date: recentAbs[0]?.date || null, ref_id: st.id
    });
  }

  const sortedAsc = att.slice().sort((a, b) => a.date.localeCompare(b.date));
  let maxConsec = 0, cur = 0;
  for (const a of sortedAsc) {
    if (a.status === "absent") { cur++; maxConsec = Math.max(maxConsec, cur); } else cur = 0;
  }
  if (maxConsec >= 2) {
    alerts.push({
      type: "attendance_consecutive", severity: "danger", icon: "⚠️",
      title: "غياب متتالي", message: `${maxConsec} أيام غياب متتالية`,
      date: sortedAsc[sortedAsc.length - 1]?.date || null, ref_id: st.id
    });
  }

  const lowGrades = grd.filter(g => g.max_score > 0 && (g.score / g.max_score) * 100 < 50);
  if (lowGrades.length >= 2) {
    alerts.push({
      type: "grade_low", severity: "warning", icon: "📉",
      title: "درجات منخفضة", message: `${lowGrades.length} تقييمات بأقل من 50%`,
      date: lowGrades[0]?.date || null, ref_id: st.id
    });
  }

  const notSub = hw.filter(h => h.homework_status === "not_submitted" && new Date(h.date).getTime() >= attCutoff);
  if (notSub.length >= 3) {
    alerts.push({
      type: "homework_repeated", severity: "warning", icon: "📝",
      title: "واجبات لم تُسلَّم", message: `${notSub.length} واجبات لم يتم تسليمها`,
      date: notSub[0]?.date || null, ref_id: st.id
    });
  }

  return alerts;
}

function notifTypeLabel(t) {
  return t === "absent" ? "غياب"
    : t === "behavior" ? "سلوك"
    : t === "homework" ? "واجب"
    : t === "grade" ? "درجة"
    : t === "announcement" ? "إعلان"
    : t === "alert" ? "إنذار"
    : t === "note" ? "المتبقي من الرسوم"
    : "تنبيه";
}

async function getReadNotifications(studentId) {
  const key = `notif_read_${studentId}`;
  return (await metaStore.get(key)) || [];
}

async function markNotificationsRead(studentId, notificationIds) {
  const key = `notif_read_${studentId}`;
  const current = await getReadNotifications(studentId);
  const merged = Array.from(new Set([...current, ...notificationIds]));
  const trimmed = merged.length > 500 ? merged.slice(-500) : merged;
  await metaStore.set(key, trimmed);
  return trimmed;
}

async function markAllParentNotificationsRead(studentId, notifications) {
  const ids = notifications.map(n => n.id);
  return markNotificationsRead(studentId, ids);
}

async function renderParentDashboard() {
  const ps = await getParentSession();
  if (!ps) { showParentScreen(); return; }
  showApp();
  $("#navMenu").innerHTML = "";
  $("#sidebarSchoolName").textContent = state.school?.name || "المدرسة";
  $("#sidebarUserRole").textContent = "ولي أمر — " + (ps.student?.full_name || "");
  $("#pageTitle").textContent = "متابعة الطالب";

  if (isOnline()) {
    try {
      const fresh = await parentLookup(ps.student.tracking_number, ps.student.full_name);
      if (fresh && fresh.ok) {
        ps.attendance = fresh.attendance;
        ps.grades = fresh.grades;
        ps.homework = fresh.homework;
        ps.behavior = fresh.behavior;
        ps.announcements = fresh.announcements;
        ps.notes = fresh.notes || [];
        await setParentSession(ps);
        await saveParentCache(ps.student.tracking_number, ps.student.full_name, fresh);
      }
    } catch (e) { console.warn("Parent refresh failed, using cache", e); }
  }

  const c = $("#pageContent");
  const s = ps.student;
  const att = ps.attendance || [];
  const grd = ps.grades || [];
  const hw = ps.homework || [];
  const bh = ps.behavior || [];
  const an = ps.announcements || [];

  const allNotifs = buildParentNotifications(ps);
  const readIds = await getReadNotifications(s.id);
  const unreadNotifs = allNotifs.filter(n => !readIds.includes(n.id));

  const offlineNote = !isOnline()
    ? `<div class="error-msg" style="background:#fef3c7;color:#92400e">أنت تستعرض بيانات محفوظة مسبقًا. سيتم تحديثها عند عودة الإنترنت.</div>`
    : "";

  const notifBanner = unreadNotifs.length > 0
    ? `<div class="notification-banner" id="notifBanner">
        <div class="row" style="gap:12px; align-items:center">
          <span style="font-size:22px">🔔</span>
          <div style="flex:1">
            <strong>لديك ${unreadNotifs.length} تنبيه جديد</strong>
            <div class="muted small">اضغط لعرض التفاصيل</div>
          </div>
          <button class="btn btn-sm" id="showNotifsBtn">عرض</button>
        </div>
      </div>`
    : "";

  const notifSection = allNotifs.length
    ? `<div class="card" id="notifSection" ${unreadNotifs.length ? "" : 'style="display:none"'}>
        <div class="row" style="justify-content:space-between; margin-bottom:12px">
          <h3 class="card-title" style="margin:0">🔔 التنبيهات (${allNotifs.length})</h3>
          <button class="btn btn-sm" id="markAllReadBtn">تعليم الكل كمقروء</button>
        </div>
        <div id="notifList">
          ${allNotifs.map(n => {
            const isRead = readIds.includes(n.id);
            const severityClass = n.severity === "danger" ? "badge-danger" : n.severity === "warning" ? "badge-warning" : "badge-info";
            return `<div class="notif-item ${isRead ? "read" : "unread"}">
              <div class="row" style="gap:10px; align-items:flex-start">
                <span style="font-size:20px">${n.icon}</span>
                <div style="flex:1; min-width:0">
                  <div class="row" style="gap:8px; align-items:center">
                    <strong>${escapeHtml(n.title)}</strong>
                    <span class="badge ${severityClass}">${notifTypeLabel(n.type)}</span>
                    ${!isRead ? `<span class="badge badge-success">جديد</span>` : ""}
                  </div>
                  <div style="margin-top:4px">${escapeHtml(n.message)}</div>
                  <div class="muted small" style="margin-top:4px">${fmtDate(n.date)}</div>
                </div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`
    : "";

  c.innerHTML = `
    ${offlineNote}
    ${notifBanner}
    ${notifSection}

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3 class="card-title" style="margin:0">بيانات الطالب</h3>
        <div class="row">
          <button class="btn btn-sm" id="refreshParentBtn">🔄 تحديث</button>
          <button class="btn btn-sm" id="pushToggleBtn">🔔 تفعيل الإشعارات</button>
        </div>
      </div>
      <p><strong>الاسم:</strong> ${escapeHtml(s.full_name)}</p>
      <p><strong>رقم المتابعة:</strong> <span class="badge badge-info">${escapeHtml(s.tracking_number)}</span></p>
      <p><strong>الصف:</strong> ${escapeHtml(className(s.class_id))} — <strong>الفصل:</strong> ${escapeHtml(sectionName(s.section_id))}</p>
    </div>

    <div class="card" style="border-right:4px solid var(--danger)">
      <h3 class="card-title" style="color:var(--danger)">💰 المتبقي من الرسوم</h3>
      ${(ps.notes && ps.notes.length)
        ? ps.notes.map(n => {
          const amountTxt = (n.amount !== null && n.amount !== undefined && n.amount !== "")
            ? `${Number(n.amount).toLocaleString("ar-EG")} ${escapeHtml(n.currency || "جنيه")}` : null;
          const subjectTxt = n.subject_id ? `<span class="badge badge-info">${escapeHtml(subjectName(n.subject_id))}</span>` : "";
          return `<div class="list-item" style="border-right:4px solid var(--danger); background:#fef2f2">
            <div class="row" style="justify-content:space-between; align-items:center">
              <div class="list-item-title" style="margin:0">${escapeHtml(n.title || "المتبقي من الرسوم")}</div>
              ${subjectTxt}
            </div>
            <div class="muted small">${fmtDate(n.date)}</div>
            ${amountTxt ? `<div style="font-size:22px; font-weight:800; color:var(--danger); margin:8px 0">${amountTxt}</div>` : ""}
            ${n.body ? `<div>${escapeHtml(n.body)}</div>` : ""}
          </div>`;
        }).join("")
        : `<div class="empty-state">لا توجد تنبيهات حالية ✅</div>`}
    </div>

    <div class="card">
      <h3 class="card-title">الحضور والغياب</h3>
      ${att.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>التاريخ</th><th>الحالة</th></tr></thead><tbody>
        ${att.map(a => `<tr><td>${fmtDate(a.date)}</td><td>${a.status === "present" ? "حاضر" : a.status === "late" ? "متأخر" : "غائب"}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty-state">لا يوجد سجل</div>`}
    </div>

    <div class="card">
      <h3 class="card-title">كشف الدرجات</h3>
      ${buildGradesReportHTML(grd)}
    </div>

    <div class="card">
      <h3 class="card-title">الواجبات والكراسة</h3>
      ${hw.length ? hw.map(h => `
        <div class="list-item">
          <div class="list-item-title">${escapeHtml(subjectName(h.subject_id))} — ${fmtDate(h.date)}</div>
          <div>الواجب: <span class="badge badge-info">${hwLabel(h.homework_status)}</span> | الكراسة: <span class="badge badge-info">${hwLabel(h.notebook_status)}</span></div>
          ${h.notes ? `<div class="muted small">${escapeHtml(h.notes)}</div>` : ""}
        </div>`).join("") : `<div class="empty-state">لا توجد واجبات</div>`}
    </div>

    <div class="card">
      <h3 class="card-title">السلوك</h3>
      ${bh.length ? bh.map(b => `
        <div class="list-item">
          <div class="list-item-title">${fmtDate(b.date)} — ${bhLabel(b.note_type)}</div>
          <div>${escapeHtml(b.note)}</div>
        </div>`).join("") : `<div class="empty-state">لا ملاحظات</div>`}
    </div>

    <div class="card">
      <h3 class="card-title">الإعلانات</h3>
      ${an.length ? an.map(a => `
        <div class="list-item">
          <div class="list-item-title">${escapeHtml(a.title)}</div>
          <div class="muted small">${fmtDate(a.date)}</div>
          <div>${escapeHtml(a.content)}</div>
        </div>`).join("") : `<div class="empty-state">لا توجد إعلانات</div>`}
    </div>

    <div class="card">
      <button class="btn btn-danger btn-block" id="parentLogoutBtn">تسجيل الخروج</button>
    </div>
  `;

  const showBtn = $("#showNotifsBtn");
  if (showBtn) showBtn.onclick = () => {
    const sec = $("#notifSection");
    if (sec) { sec.style.display = "block"; sec.scrollIntoView({ behavior: "smooth", block: "start" }); }
  };

  const markBtn = $("#markAllReadBtn");
  if (markBtn) markBtn.onclick = async () => {
    await markAllParentNotificationsRead(s.id, allNotifs);
    toast("تم تعليم كل التنبيهات كمقروءة", "success");
    renderParentDashboard();
  };

  $("#refreshParentBtn").onclick = async () => {
    if (!isOnline()) { toast("لا يوجد اتصال بالإنترنت", "warning"); return; }
    toast("جارٍ التحديث...", "info");
    try {
      const fresh = await parentLookup(s.tracking_number, s.full_name);
      if (fresh && fresh.ok) {
        await setParentSession({
          student: fresh.student, attendance: fresh.attendance, grades: fresh.grades,
          homework: fresh.homework, behavior: fresh.behavior, announcements: fresh.announcements, notes: fresh.notes || []
        });
        await saveParentCache(s.tracking_number, s.full_name, fresh);
        toast("تم التحديث", "success");
        renderParentDashboard();
      }
    } catch (e) { toast("فشل التحديث: " + e.message, "error"); }
  };

  // Push
  const pushBtn = $("#pushToggleBtn");
  if (pushBtn) {
    const updatePushBtn = async () => {
      const supported = await isPushSupported();
      if (!supported) { pushBtn.disabled = true; pushBtn.textContent = "الإشعارات غير مدعومة"; return; }
      const enabled = await isPushEnabled();
      const permission = await getPushPermissionState();
      if (permission === "denied") { pushBtn.disabled = true; pushBtn.textContent = "الإشعارات مرفوضة"; return; }
      pushBtn.textContent = enabled ? "🔕 إلغاء الإشعارات" : "🔔 تفعيل الإشعارات";
      pushBtn.classList.toggle("btn-danger", enabled);
      pushBtn.classList.toggle("btn-primary", !enabled);
    };
    await updatePushBtn();
    pushBtn.onclick = async () => {
      try {
        const enabled = await isPushEnabled();
        if (enabled) {
          if (!confirm("هل تريد إلغاء الإشعارات؟")) return;
          await unsubscribeFromPush();
          toast("تم إلغاء الإشعارات", "success");
        } else {
          await subscribeToPush(ps);
          toast("تم تفعيل الإشعارات", "success");
        }
        await updatePushBtn();
      } catch (e) { toast("فشل: " + e.message, "error"); }
    };
  }

  $("#parentLogoutBtn").onclick = async () => { await clearParentSession(); location.reload(); };
}

/* ===== Push Notifications ===== */
const VAPID_PUBLIC_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjdHl1aGl1ZXpub2d3dmduZWZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyMjMxMDksImV4cCI6MjEwNTc5OTEwOX0.sQnZ27A0CJaWELg81Xge8icbGJCexu9mNQ--_FTHWcw";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
async function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
async function getPushPermissionState() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}
async function subscribeToPush(parentSession) {
  if (!(await isPushSupported())) throw new Error("المتصفح لا يدعم الإشعارات");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("لم يتم منح الإذن");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
  }
  const subJson = sub.toJSON();
  const client = getClient();
  const { data, error } = await client.rpc("register_push_subscription", {
    p_tracking: parentSession.student.tracking_number,
    p_name: parentSession.student.full_name,
    p_endpoint: subJson.endpoint,
    p_p256dh: subJson.keys.p256dh,
    p_auth: subJson.keys.auth,
    p_user_agent: navigator.userAgent
  });
  if (error) throw error;
  if (!data || !data.ok) throw new Error(data?.error || "فشل التسجيل");
  await metaStore.set("push_subscribed", true);
  await metaStore.set("push_subscribed_student", parentSession.student.id);
  return sub;
}
async function unsubscribeFromPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch (e) { console.warn(e); }
  await metaStore.set("push_subscribed", false);
}
async function isPushEnabled() {
  const flag = await metaStore.get("push_subscribed");
  if (!flag) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch { return false; }
}
async function sendPushToStudent(studentId, title, body, url = null) {
  if (!isOnline()) return;
  try {
    const client = getClient();
    const { data: { session } } = await client.auth.getSession();
    if (!session) return;
    await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({ student_id: studentId, title, body, url: url || "/?page=parent" })
    });
  } catch (e) { console.warn("push send failed", e); }
}

/* ===== Sidebar ===== */
function openSidebar() { $("#sidebar").classList.add("open"); $("#overlay").hidden = false; }
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#overlay").hidden = true; }

/* ===== Net Indicator ===== */
async function updateNetIndicator() {
  const online = isOnline();
  const el = $("#netIndicatorTop");
  const side = $("#netIndicator");
  const banner = $("#offlineBanner");

  let pending = 0;
  try {
    const all = await idb.getAll("sync_queue");
    pending = all.filter(o => o.sync_status === "pending" || o.sync_status === "retry").length;
  } catch (_) {}

  const pendingText = pending > 0 ? ` (${pending} في الانتظار)` : "";

  el.className = "net-pill " + (online ? "online" : "offline");
  el.textContent = online
    ? (pending > 0 ? `🟠 ${pending} في الانتظار` : "🟢 متصل")
    : `🔴 بدون اتصال${pendingText}`;

  side.classList.toggle("offline", !online);
  side.querySelector(".net-text").textContent = online
    ? (pending > 0 ? `متصل — ${pending} معلّقة` : "متصل")
    : "بدون اتصال";

  banner.hidden = online;
  if (!online) {
    banner.textContent = pending > 0
      ? `🔴 أنت تعمل بدون اتصال. ${pending} عملية في الانتظار وسيتم مزامنتها عند عودة الإنترنت.`
      : `🔴 أنت تعمل الآن بدون اتصال. سيتم مزامنة التغييرات عند عودة الإنترنت.`;
  }
}

/* ===== Bootstrap ===== */
async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW error", e));
  }

  window.addEventListener("online", () => updateNetIndicator());
  window.addEventListener("offline", () => updateNetIndicator());
  updateNetIndicator();
  setInterval(updateNetIndicator, 10000);

  on("status", (s) => {
    if (s.syncing) {
      const el = $("#netIndicatorTop");
      el.className = "net-pill syncing";
      el.textContent = "🟠 تتم المزامنة";
    } else updateNetIndicator();
  });
  on("data", () => {
    loadAllLocal().then(() => { if (state.session) renderPage(state.currentPage); });
  });

  startWatchers(async () => state.session?.school_id || null);

  // Theme
  const savedTheme = await getSavedTheme();
  await applyTheme(savedTheme);
  const themeBtn = $("#themeToggle");
  if (themeBtn) themeBtn.onclick = () => toggleTheme();
  const loginThemeBtn = $("#loginThemeToggle");
  if (loginThemeBtn) loginThemeBtn.onclick = (e) => { e.preventDefault(); toggleTheme(); };

  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("#loginError").hidden = true;
    try {
      const email = $("#loginEmail").value.trim();
      const pwd = $("#loginPassword").value;
      const s = await login(email, pwd);
      state.session = s;
      await loadSchool();
      await loadAllLocal();
      if (isOnline() && s.school_id) refreshFromCloud(s.school_id);
      startIdleWatcher();

      if (s.must_change_password) {
        showApp();
        buildMenu();
        await showForcedPasswordChange();
        return;
      }
      showApp();
      buildMenu();
      await navigate("dashboard");
    } catch (err) {
      $("#loginError").hidden = false;
      $("#loginError").textContent = err.message;
    }
  };

  $("#parentForm").onsubmit = async (e) => {
    e.preventDefault();
    $("#parentError").hidden = true;
    try {
      const name = $("#parentStudentName").value.trim();
      const tracking = $("#parentTracking").value.trim();
      if (!name || !tracking) throw new Error("املأ جميع الحقول");

      if (isOnline()) {
        const res = await parentLookup(tracking, name);
        if (!res || !res.ok) throw new Error("لم يتم العثور على الطالب، تحقق من البيانات");
        await setParentSession({
          student: res.student, attendance: res.attendance, grades: res.grades,
          homework: res.homework, behavior: res.behavior, announcements: res.announcements, notes: res.notes || []
        });
        await saveParentCache(tracking, name, res);
        const school = await idb.get("schools", res.student.school_id);
        if (school) { state.school = school; applySchoolBranding(); }
      } else {
        const cached = await getParentCache(tracking, name);
        if (!cached) throw new Error("لا اتصال، ولا توجد بيانات محفوظة");
        await setParentSession({
          student: cached.data.student, attendance: cached.data.attendance, grades: cached.data.grades,
          homework: cached.data.homework, behavior: cached.data.behavior,
          announcements: cached.data.announcements, notes: cached.data.notes || []
        });
      }

      await loadAllLocal();
      startIdleWatcher();
      renderParentDashboard();
    } catch (err) {
      $("#parentError").hidden = false;
      $("#parentError").textContent = err.message;
    }
  };

  $("#backToLogin").onclick = (e) => {
    e.preventDefault();
    showLoginScreen();
    history.replaceState(null, "", location.pathname);
  };

  $("#logoutBtn").onclick = async () => {
    stopIdleWatcher();
    await logout();
    state.session = null;
    location.reload();
  };

  $("#menuToggle").onclick = () => {
    const s = $("#sidebar");
    if (s.classList.contains("open")) closeSidebar(); else openSidebar();
  };
  $("#overlay").onclick = closeSidebar;

  const params = new URLSearchParams(location.search);
  if (params.get("page") === "parent") {
    showParentScreen();
    return;
  }

  const s = await getSession();
  if (s) {
    state.session = s;
    await loadSchool();
    await loadAllLocal();
    if (isOnline() && s.school_id) refreshFromCloud(s.school_id);
    startIdleWatcher();

    if (s.must_change_password) {
      showApp();
      buildMenu();
      await showForcedPasswordChange();
      return;
    }
    showApp();
    buildMenu();
    await navigate("dashboard");
  } else {
    showLoginScreen();
  }
}

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise", e.reason);
});