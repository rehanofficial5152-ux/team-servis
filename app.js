const SECRET_CODE = "SERVIS2026";
const host = ["firestore", "googleapis", "com"].join(".");
const BASE_URL = "https://" + host + "/v1/projects/team-servis/databases/(default)/documents";
let me = JSON.parse(localStorage.getItem("ts_user") || "null");
let savedContacts = JSON.parse(localStorage.getItem("ts_contacts") || "{}");
let mutedChats = JSON.parse(localStorage.getItem("ts_muted") || "{}");
let chatPreviews = JSON.parse(localStorage.getItem("ts_previews") || "{}");
let matchedContacts = [], loadedGroupsCache = [], userProfiles = {};
let activeChatId = null, activePeerPhone = "", activeChatTitle = "", activeGroupMembers = "", isGroupChat = false;
let chatTimer = null, typingTimer = null, lastMsgHash = "", replyToText = "", chatSearchFilter = "";
let pc = null, localStream = null, activeCallDocId = null, incomingCallData = null, callPollTimer = null, ringInterval = null;
let mediaRecorder = null, audioChunks = [], lastNotifiedMsgId = "", tempDpData = "", tempStatusImg = "";
let selectedMsgObj = null, forwardPayload = null, deferredInstallPrompt = null, currentTabIdx = 0;

// Block Pull-to-Refresh strictly when scrollTop === 0
let lastTouchY = 0;
document.addEventListener("touchstart", function(e) {
  if (e.touches.length === 1) lastTouchY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener("touchmove", function(e) {
  const currentY = e.touches[0].clientY;
  const dy = currentY - lastTouchY;
  lastTouchY = currentY;
  if (dy > 0) {
    let el = e.target;
    let canScrollUp = false;
    while (el && el !== document.body) {
      if (el.scrollTop > 0) { canScrollUp = true; break; }
      el = el.parentElement;
    }
    if (!canScrollUp && e.cancelable) e.preventDefault();
  }
}, { passive: false });

function askNotifPermissionSafe() {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(function() {});
    }
  } catch (e) {}
}

function saveSwStateToDB(phone, contacts) {
  try {
    const req = indexedDB.open("TeamServisDB", 1);
    req.onupgradeneeded = function(ev) { ev.target.result.createObjectStore("state"); };
    req.onsuccess = function(ev) {
      const db = ev.target.result;
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put({ phone: phone, contacts: contacts }, "user_info");
    };
  } catch (e) {}
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js?v=50").then(function(reg) {
    reg.update();
    if (me) {
      saveSwStateToDB(me.phone, savedContacts);
      if (reg.active) reg.active.postMessage({ type: "SET_USER", phone: me.phone, contacts: savedContacts });
    }
  }).catch(function() {});
}

window.addEventListener("beforeinstallprompt", function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  const b = document.getElementById("install-banner");
  if (b) b.style.display = "flex";
});
const instBtn = document.getElementById("install-app-btn");
if (instBtn) {
  instBtn.onclick = async function() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById("install-banner").style.display = "none";
  };
}

function normPhone(p) {
  let s = (p || "").replace(/\D/g, "");
  if (s.indexOf("92") === 0 && s.length === 12) s = "0" + s.slice(2);
  return s;
}
function fmtTime(ts) {
  if (!ts) return "";
  return new Date(Number(ts)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function playTone(freq, dur) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = freq; osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); setTimeout(function() { osc.stop(); ctx.close(); }, dur);
  } catch (e) {}
}
function startRinging() {
  stopRinging();
  playTone(540, 450);
  if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  ringInterval = setInterval(function() { playTone(540, 450); if (navigator.vibrate) navigator.vibrate([400, 200, 400]); }, 1800);
}
function stopRinging() {
  if (ringInterval) { clearInterval(ringInterval); ringInterval = null; }
  if (navigator.vibrate) navigator.vibrate(0);
}
function notifyUser(title, body, chatId) {
  if (chatId && mutedChats[chatId]) return;
  playTone(880, 180);
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.ready.then(function(reg) {
          reg.showNotification(title, { body: body, vibrate: [300, 150, 300], tag: chatId || "ts_alert" });
        }).catch(function() { new Notification(title, { body: body }); });
      } else {
        new Notification(title, { body: body });
      }
    }
  } catch (e) {}
}

async function getRoomCryptoKey(roomId) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey("raw", enc.encode("TeamServis_E2E_" + roomId + "_" + SECRET_CODE), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: enc.encode("RehanNasir_Salt"), iterations: 10000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptText(plainText, roomId) {
  if (!plainText) return "";
  const key = await getRoomCryptoKey(roomId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plainText));
  const comb = new Uint8Array(iv.length + buf.byteLength);
  comb.set(iv, 0); comb.set(new Uint8Array(buf), iv.length);
  let bin = ""; for (let i = 0; i < comb.length; i++) bin += String.fromCharCode(comb[i]);
  return "E2E:" + btoa(bin);
}
async function decryptText(cipherStr, roomId) {
  if (!cipherStr || cipherStr.indexOf("E2E:") !== 0) return cipherStr || "";
  try {
    const raw = atob(cipherStr.slice(4)), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const key = await getRoomCryptoKey(roomId);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return new TextDecoder().decode(plainBuf);
  } catch (e) { return "[Encrypted]"; }
}

function pushNavState(stateName) {
  try { history.pushState({ nav: stateName }, "", ""); } catch (e) {}
}
window.addEventListener("popstate", function() {
  const openModals = document.querySelectorAll(".modal.active, .status-viewer.active, .action-sheet-bg.active");
  if (openModals.length > 0) {
    openModals.forEach(function(m) { m.classList.remove("active"); });
    pushNavState("screen");
    return;
  }
  const dots = document.getElementById("chat-dots-menu");
  if (dots && dots.classList.contains("active")) {
    dots.classList.remove("active");
    pushNavState("chat");
    return;
  }
  if (document.getElementById("chat-screen").classList.contains("active")) {
    goBackHome();
    pushNavState("home");
  }
});

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(function(s) { s.classList.remove("active"); });
  document.getElementById(id).classList.add("active");
}
function goBackHome() {
  activeChatId = null;
  if (chatTimer) clearInterval(chatTimer);
  document.getElementById("chat-dots-menu").classList.remove("active");
  document.getElementById("emoji-bar").classList.remove("active");
  showScreen("home-screen");
  loadChatsAndGroups();
}

const tabIds = ["chats-view", "status-view", "calls-view"];
function switchHomeTab(idx) {
  if (idx < 0) idx = 0;
  if (idx > 2) idx = 2;
  currentTabIdx = idx;
  document.querySelectorAll(".wa-tab").forEach(function(t, i) {
    t.classList.toggle("active", i === idx);
  });
  tabIds.forEach(function(id, i) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", i === idx);
  });
  if (idx === 1) loadStatuses();
  if (idx === 2) loadCalls();
}

document.querySelectorAll(".wa-tab").forEach(function(tab) {
  tab.onclick = function() {
    switchHomeTab(Number(tab.getAttribute("data-index")));
  };
});

let touchStartX = 0, touchStartY = 0;
const swipeArea = document.getElementById("tabs-swipe-area");
if (swipeArea) {
  swipeArea.addEventListener("touchstart", function(e) {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
  }, { passive: true });
  swipeArea.addEventListener("touchend", function(e) {
    const dx = e.changedTouches[0].screenX - touchStartX;
    const dy = e.changedTouches[0].screenY - touchStartY;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0 && currentTabIdx < 2) switchHomeTab(currentTabIdx + 1);
      else if (dx > 0 && currentTabIdx > 0) switchHomeTab(currentTabIdx - 1);
    }
  }, { passive: true });
}

function renderMyMiniDp() {
  const box = document.getElementById("open-profile-btn");
  if (me && me.dp) { box.innerHTML = ""; const im = document.createElement("img"); im.src = me.dp; box.appendChild(im); }
  else if (me) { box.innerText = me.name.charAt(0).toUpperCase(); }
}

document.getElementById("login-btn").onclick = async function() {
  const name = document.getElementById("user-name").value.trim();
  const phone = normPhone(document.getElementById("phone-number").value);
  const about = document.getElementById("user-about").value.trim() || "Available";
  const code = document.getElementById("team-code").value.trim().toUpperCase();
  const status = document.getElementById("status-msg");
  status.innerText = "";

  if (!name || phone.length < 10) { status.innerText = "Naam aur sahi mobile number likhein!"; return; }
  if (code !== SECRET_CODE) { status.innerText = "Ghalat Team Secret Code!"; return; }

  askNotifPermissionSafe();
  const btn = document.getElementById("login-btn");
  btn.disabled = true; btn.innerText = "Securing...";

  try {
    const res = await fetch(BASE_URL + "/users/" + encodeURIComponent(phone), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          name: { stringValue: name },
          phone: { stringValue: phone },
          about: { stringValue: about },
          lastSeen: { integerValue: String(Date.now()) },
          typingTo: { stringValue: "" }
        }
      })
    });
    if (!res.ok) throw new Error("Server Error: " + res.status);
    me = { name: name, phone: phone, about: about, dp: "" };
    localStorage.setItem("ts_user", JSON.stringify(me));
    btn.disabled = false; btn.innerText = "Agree & Continue";
    startApp();
  } catch (e) {
    status.innerText = "Internet / Server Error: " + e.message;
    btn.disabled = false; btn.innerText = "Agree & Continue";
  }
};

document.getElementById("open-profile-btn").onclick = function() {
  document.getElementById("edit-profile-name").value = me.name;
  document.getElementById("edit-profile-about").value = me.about || "Available";
  tempDpData = me.dp || "";
  const prev = document.getElementById("profile-dp-preview");
  if (tempDpData) { prev.innerHTML = ""; const im = document.createElement("img"); im.src = tempDpData; im.style.width = "100%"; im.style.height = "100%"; im.style.objectFit = "cover"; prev.appendChild(im); }
  else { prev.innerText = me.name.charAt(0).toUpperCase(); }
  document.getElementById("profile-modal").classList.add("active"); pushNavState("profile");
};
document.getElementById("close-profile-modal").onclick = function() { document.getElementById("profile-modal").classList.remove("active"); };
document.getElementById("change-dp-btn").onclick = function() { document.getElementById("dp-picker").click(); };
document.getElementById("dp-picker").onchange = function(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = function(ev) {
    const img = new Image(); img.onload = function() {
      const c = document.createElement("canvas"); c.width = 200; c.height = 200;
      c.getContext("2d").drawImage(img, 0, 0, 200, 200);
      tempDpData = c.toDataURL("image/jpeg", 0.7);
      const prev = document.getElementById("profile-dp-preview"); prev.innerHTML = "";
      const im = document.createElement("img"); im.src = tempDpData; im.style.width = "100%"; im.style.height = "100%"; im.style.objectFit = "cover"; prev.appendChild(im);
    }; img.src = ev.target.result;
  }; r.readAsDataURL(f);
};
document.getElementById("save-profile-submit").onclick = async function() {
  const n = document.getElementById("edit-profile-name").value.trim() || me.name;
  const ab = document.getElementById("edit-profile-about").value.trim() || "Available";
  me.name = n; me.about = ab; me.dp = tempDpData;
  localStorage.setItem("ts_user", JSON.stringify(me)); renderMyMiniDp();
  await fetch(BASE_URL + "/users/" + encodeURIComponent(me.phone), {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { name: { stringValue: n }, phone: { stringValue: me.phone }, about: { stringValue: ab }, dp: { stringValue: tempDpData }, lastSeen: { integerValue: String(Date.now()) } } })
  });
  document.getElementById("profile-modal").classList.remove("active"); loadChatsAndGroups();
};

function sendHeartbeat(typingTarget) {
  if (!me) return;
  const fields = { lastSeen: { integerValue: String(Date.now()) } };
  let mask = "updateMask.fieldPaths=lastSeen";
  if (typeof typingTarget === "string") {
    fields.typingTo = { stringValue: typingTarget };
    mask += "&updateMask.fieldPaths=typingTo";
  }
  fetch(BASE_URL + "/users/" + encodeURIComponent(me.phone) + "?" + mask, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fields })
  }).catch(function() {});
}

function syncSwUser() {
  if (!me) return;
  saveSwStateToDB(me.phone, savedContacts);
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "SET_USER", phone: me.phone, contacts: savedContacts });
  }
}

function startApp() {
  askNotifPermissionSafe();
  syncSwUser();
  renderMyMiniDp(); showScreen("home-screen"); pushNavState("home"); loadChatsAndGroups(); sendHeartbeat("");
  setInterval(function() { sendHeartbeat(); }, 12000);
  setInterval(checkIncomingCalls, 2000);
  setInterval(backgroundRoomPoll, 4500);
}

document.getElementById("refresh-btn").onclick = function() { loadChatsAndGroups(); loadStatuses(); loadCalls(); };
document.getElementById("logout-btn").onclick = function() { localStorage.removeItem("ts_user"); me = null; if (chatTimer) clearInterval(chatTimer); showScreen("login-screen"); };

async function triggerPhonebook() {
  if ("contacts" in navigator && "ContactsManager" in window) {
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      if (picked && picked.length > 0) {
        let count = 0;
        picked.forEach(function(item) {
          const cName = (item.name && item.name[0]) ? item.name[0].trim() : "Member";
          if (item.tel && item.tel.length > 0) {
            item.tel.forEach(function(rawTel) {
              const p = normPhone(rawTel);
              if (p.length >= 10 && p !== me.phone) { savedContacts[p] = cName; count++; }
            });
          }
        });
        localStorage.setItem("ts_contacts", JSON.stringify(savedContacts));
        syncSwUser();
        document.getElementById("contact-modal").classList.remove("active");
        loadChatsAndGroups();
        alert(count + " contacts synced!");
        return true;
      }
    } catch (e) {}
  }
  return false;
}
function openContactModal() {
  document.getElementById("new-contact-name").value = "";
  document.getElementById("new-contact-phone").value = "";
  document.getElementById("contact-modal").classList.add("active");
  pushNavState("contact");
}
document.getElementById("pick-phonebook-btn").onclick = async function() {
  const ok = await triggerPhonebook();
  if (!ok) alert("Aap ka browser direct contacts picker support nahi karta. Neeche 'Import Contacts File (.vcf)' ya manual number use karein.");
};
document.getElementById("import-vcf-btn").onclick = function() { document.getElementById("vcf-picker").click(); };
document.getElementById("vcf-picker").onchange = function(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = function(ev) {
    const lines = ev.target.result.split(/\r?\n/);
    let curName = "Member", added = 0;
    lines.forEach(function(line) {
      if (line.indexOf("FN:") === 0) curName = line.slice(3).trim();
      if (line.indexOf("TEL") === 0) {
        const raw = line.split(":")[1];
        const p = normPhone(raw);
        if (p.length >= 10 && p !== me.phone) { savedContacts[p] = curName; added++; }
      }
    });
    localStorage.setItem("ts_contacts", JSON.stringify(savedContacts));
    syncSwUser();
    document.getElementById("contact-modal").classList.remove("active");
    loadChatsAndGroups();
    alert(added + " contacts imported from VCF!");
  };
  r.readAsText(f);
};
document.getElementById("add-contact-btn").onclick = openContactModal;
document.getElementById("fab-contact-btn").onclick = openContactModal;
document.getElementById("close-contact-modal").onclick = function() { document.getElementById("contact-modal").classList.remove("active"); };
document.getElementById("save-contact-submit").onclick = function() {
  const cName = document.getElementById("new-contact-name").value.trim(), cPhone = normPhone(document.getElementById("new-contact-phone").value);
  if (!cName || cPhone.length < 10) return alert("Sahi naam aur number likhein!");
  savedContacts[cPhone] = cName;
  localStorage.setItem("ts_contacts", JSON.stringify(savedContacts));
  syncSwUser();
  document.getElementById("contact-modal").classList.remove("active");
  loadChatsAndGroups();
};
document.getElementById("search-contact-input").oninput = function() { renderChatList(this.value.trim().toLowerCase()); };

async function loadChatsAndGroups() {
  try {
    const [uR, gR] = await Promise.all([fetch(BASE_URL + "/users"), fetch(BASE_URL + "/groups")]);
    const uD = await uR.json(), gD = await gR.json();
    loadedGroupsCache = [];
    (gD.documents || []).forEach(function(g) {
      const f = g.fields; if (!f || !f.members) return;
      const m = f.members.stringValue || ""; if (m.indexOf(me.phone) === -1) return;
      loadedGroupsCache.push({ id: g.name.split("/").pop(), name: f.name.stringValue, members: m });
    });
    matchedContacts = []; userProfiles = {};
    (uD.documents || []).forEach(function(u) {
      const f = u.fields; if (!f) return;
      const uP = normPhone(f.phone.stringValue);
      const ls = f.lastSeen ? Number(f.lastSeen.integerValue) : 0;
      const tTo = f.typingTo ? f.typingTo.stringValue : "";
      const st = (Date.now() - ls) < 30000 ? "Online" : (ls ? "Last seen " + fmtTime(ls) : "Offline");
      userProfiles[uP] = { name: f.name ? f.name.stringValue : uP, about: f.about ? f.about.stringValue : "Available", dp: f.dp ? f.dp.stringValue : "", status: st, typingTo: tTo };
      if (uP !== me.phone && savedContacts[uP]) matchedContacts.push({ name: savedContacts[uP], phone: uP });
    });
    if (activeChatId && !isGroupChat && userProfiles[activePeerPhone]) {
      const pInfo = userProfiles[activePeerPhone];
      document.getElementById("chat-subtitle").innerText = pInfo.typingTo === me.phone ? "typing..." : pInfo.status;
    }
    renderChatList(document.getElementById("search-contact-input").value.trim().toLowerCase());
  } catch (e) {}
}

async function backgroundRoomPoll() {
  if (!me) return;
  const rooms = [];
  loadedGroupsCache.forEach(function(g) { rooms.push({ id: g.id, title: g.name }); });
  matchedContacts.forEach(function(ct) { rooms.push({ id: [me.phone, ct.phone].sort().join("_"), title: ct.name }); });
  for (let i = 0; i < rooms.length; i++) {
    const rm = rooms[i];
    try {
      const res = await fetch(BASE_URL + "/chats/" + encodeURIComponent(rm.id) + "/messages?pageSize=20");
      const data = await res.json();
      const docs = (data.documents || []).sort(function(a, b) { return Number(a.fields.time.integerValue) - Number(b.fields.time.integerValue); });
      if (docs.length === 0) continue;
      let unread = 0;
      docs.forEach(function(d) {
        const f = d.fields;
        if (normPhone(f.sender.stringValue) !== me.phone && !(f.read && f.read.booleanValue === true)) unread++;
      });
      const lastDoc = docs[docs.length - 1], lf = lastDoc.fields;
      const prevTxt = lf.text && lf.text.stringValue ? await decryptText(lf.text.stringValue, rm.id) : (lf.mediaType ? lf.mediaType.stringValue : "Message");
      chatPreviews[rm.id] = { text: prevTxt, time: lf.time.integerValue, unread: activeChatId === rm.id ? 0 : unread };
      localStorage.setItem("ts_previews", JSON.stringify(chatPreviews));
      if (activeChatId !== rm.id && unread > 0 && lastNotifiedMsgId !== lastDoc.name) {
        lastNotifiedMsgId = lastDoc.name;
        notifyUser(rm.title, prevTxt, rm.id);
      }
    } catch (e) {}
  }
  if (!activeChatId) renderChatList(document.getElementById("search-contact-input").value.trim().toLowerCase());
}

function renderChatList(flt) {
  const c = document.getElementById("chats-list"); c.innerHTML = "";
  loadedGroupsCache.forEach(function(g) {
    if (flt && g.name.toLowerCase().indexOf(flt) === -1) return;
    const pv = chatPreviews[g.id] || { text: "Group - " + g.members.split(",").length + " members", time: "", unread: 0 };
    const item = createListRow(g.name, pv.text, true, false, "", fmtTime(pv.time), pv.unread);
    item.onclick = function() { openChat(g.id, g.name, true, "", g.members); }; c.appendChild(item);
  });
  matchedContacts.forEach(function(ct) {
    if (flt && ct.name.toLowerCase().indexOf(flt) === -1 && ct.phone.indexOf(flt) === -1) return;
    const rId = [me.phone, ct.phone].sort().join("_");
    const prof = userProfiles[ct.phone] || { about: ct.phone, dp: "", status: "" };
    const pv = chatPreviews[rId] || { text: prof.status === "Online" ? "Online - " + prof.about : prof.about, time: "", unread: 0 };
    const item = createListRow(ct.name, pv.text, false, false, prof.dp, fmtTime(pv.time), pv.unread);
    item.onclick = function() { openChat(rId, ct.name, false, ct.phone, ""); }; c.appendChild(item);
  });
  if (c.children.length === 0) {
    c.innerHTML = "<div style='padding:30px; text-align:center; color:#666;'>Neeche <b>+</b> dabakar phone contacts sync karein ya team member ka number save karein!</div>";
  }
}

function createListRow(t, s, isG, isS, dpUrl, timeStr, unreadCount) {
  const item = document.createElement("div"); item.className = "list-item";
  const av = document.createElement("div"); av.className = "avatar" + (isG ? " group" : "") + (isS ? " status-ring" : "");
  if (dpUrl) { const im = document.createElement("img"); im.src = dpUrl; av.appendChild(im); }
  else { av.innerText = isG ? "G" : t.charAt(0).toUpperCase(); }
  const info = document.createElement("div"); info.className = "item-info";
  const topRow = document.createElement("div"); topRow.className = "item-top-row";
  const h4 = document.createElement("h4"); h4.innerText = t; topRow.appendChild(h4);
  if (timeStr) { const tm = document.createElement("span"); tm.className = "item-time"; tm.innerText = timeStr; topRow.appendChild(tm); }
  const botRow = document.createElement("div"); botRow.className = "item-bottom-row";
  const p = document.createElement("p"); p.innerText = s; botRow.appendChild(p);
  if (unreadCount && unreadCount > 0) {
    const bd = document.createElement("span"); bd.className = "unread-badge"; bd.innerText = unreadCount; botRow.appendChild(bd);
  }
  info.appendChild(topRow); info.appendChild(botRow); item.appendChild(av); item.appendChild(info); return item;
}

function openGroupModal() {
  document.getElementById("group-name-input").value = "";
  const list = document.getElementById("group-members-checklist"); list.innerHTML = "";
  matchedContacts.forEach(function(u) {
    const row = document.createElement("label"); row.className = "list-item"; row.style.justifyContent = "space-between";
    const span = document.createElement("span"); span.innerText = u.name + " (" + u.phone + ")";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = u.phone; cb.style.width = "18px"; cb.style.height = "18px";
    row.appendChild(span); row.appendChild(cb); list.appendChild(row);
  });
  document.getElementById("group-modal").classList.add("active"); pushNavState("group");
}
document.getElementById("new-group-btn").onclick = openGroupModal;
document.getElementById("close-group-modal").onclick = function() { document.getElementById("group-modal").classList.remove("active"); };
document.getElementById("create-group-submit").onclick = async function() {
  const gName = document.getElementById("group-name-input").value.trim(); if (!gName) return alert("Group naam likhein!");
  const sel = [me.phone]; document.querySelectorAll("#group-members-checklist input:checked").forEach(function(cb) { sel.push(cb.value); });
  if (sel.length === 1) return alert("Member select karein!");
  await fetch(BASE_URL + "/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { name: { stringValue: gName }, members: { stringValue: sel.join(",") } } }) });
  document.getElementById("group-modal").classList.remove("active"); loadChatsAndGroups();
};

function openChat(cId, title, isG, peerPhone, gMembers) {
  activeChatId = cId; activeChatTitle = title; isGroupChat = isG; activePeerPhone = peerPhone; activeGroupMembers = gMembers || ""; lastMsgHash = ""; replyToText = ""; chatSearchFilter = "";
  if (chatPreviews[cId]) { chatPreviews[cId].unread = 0; localStorage.setItem("ts_previews", JSON.stringify(chatPreviews)); }
  document.getElementById("reply-bar").style.display = "none";
  document.getElementById("emoji-bar").classList.remove("active");
  document.getElementById("chat-search-bar").classList.remove("active");
  document.getElementById("chat-dots-menu").classList.remove("active");
  document.getElementById("menu-mute-chat").innerText = mutedChats[cId] ? "Unmute Notifications" : "Mute Notifications";
  document.getElementById("chat-title").innerText = title;
  const prof = userProfiles[peerPhone] || { status: "End-to-End Encrypted", dp: "" };
  document.getElementById("chat-subtitle").innerText = isG ? "Encrypted Group" : prof.status;
  const dpBox = document.getElementById("chat-dp-box"); dpBox.innerHTML = "";
  if (!isG && prof.dp) { const im = document.createElement("img"); im.src = prof.dp; dpBox.appendChild(im); }
  else { dpBox.innerText = isG ? "G" : title.charAt(0).toUpperCase(); }
  showScreen("chat-screen"); pushNavState("chat"); fetchMessages(true);
  if (chatTimer) clearInterval(chatTimer);
  chatTimer = setInterval(function() { fetchMessages(false); loadChatsAndGroups(); }, 2500);
}

document.getElementById("back-btn").onclick = goBackHome;
document.getElementById("chat-dots-btn").onclick = function(e) { e.stopPropagation(); document.getElementById("chat-dots-menu").classList.toggle("active"); };

function openChatInfoModal() {
  document.getElementById("chat-dots-menu").classList.remove("active");
  const dpBox = document.getElementById("info-dp-box"); dpBox.innerHTML = "";
  document.getElementById("info-name").innerText = activeChatTitle;
  if (isGroupChat) {
    dpBox.innerText = "G";
    document.getElementById("info-phone").innerText = "Group Chat";
    document.getElementById("info-about").innerText = "Members: " + activeGroupMembers;
  } else {
    const prof = userProfiles[activePeerPhone] || { about: "Available", dp: "", status: "" };
    if (prof.dp) { const im = document.createElement("img"); im.src = prof.dp; im.style.width = "100%"; im.style.height = "100%"; im.style.objectFit = "cover"; dpBox.appendChild(im); }
    else { dpBox.innerText = activeChatTitle.charAt(0).toUpperCase(); }
    document.getElementById("info-phone").innerText = activePeerPhone + " (" + prof.status + ")";
    document.getElementById("info-about").innerText = prof.about;
  }
  document.getElementById("info-modal").classList.add("active"); pushNavState("info");
}
document.getElementById("header-info-tap").onclick = openChatInfoModal;
document.getElementById("menu-view-info").onclick = openChatInfoModal;
document.getElementById("close-info-modal").onclick = function() { document.getElementById("info-modal").classList.remove("active"); };

document.getElementById("menu-search-chat").onclick = function() {
  document.getElementById("chat-dots-menu").classList.remove("active");
  document.getElementById("chat-search-bar").classList.add("active");
  document.getElementById("chat-search-input").value = "";
  document.getElementById("chat-search-input").focus();
};
document.getElementById("chat-search-input").oninput = function() { chatSearchFilter = this.value.trim().toLowerCase(); lastMsgHash = ""; fetchMessages(true); };
document.getElementById("close-chat-search").onclick = function() { chatSearchFilter = ""; document.getElementById("chat-search-bar").classList.remove("active"); lastMsgHash = ""; fetchMessages(true); };

document.getElementById("menu-mute-chat").onclick = function() {
  document.getElementById("chat-dots-menu").classList.remove("active");
  if (mutedChats[activeChatId]) { delete mutedChats[activeChatId]; alert("Notifications Unmuted"); }
  else { mutedChats[activeChatId] = true; alert("Notifications Muted"); }
  localStorage.setItem("ts_muted", JSON.stringify(mutedChats));
  this.innerText = mutedChats[activeChatId] ? "Unmute Notifications" : "Mute Notifications";
};
document.getElementById("menu-clear-chat").onclick = async function() {
  document.getElementById("chat-dots-menu").classList.remove("active");
  if (!confirm("Clear all messages in this chat?")) return;
  const res = await fetch(BASE_URL + "/chats/" + encodeURIComponent(activeChatId) + "/messages?pageSize=100");
  const data = await res.json();
  const docs = data.documents || [];
  for (let i = 0; i < docs.length; i++) { await fetch("https://" + host + "/v1/" + docs[i].name, { method: "DELETE" }); }
  lastMsgHash = ""; fetchMessages(true);
};
document.getElementById("menu-block-chat").onclick = function() {
  document.getElementById("chat-dots-menu").classList.remove("active");
  if (isGroupChat) return alert("Group cannot be blocked here.");
  if (confirm("Remove and block " + activeChatTitle + "?")) { delete savedContacts[activePeerPhone]; localStorage.setItem("ts_contacts", JSON.stringify(savedContacts)); goBackHome(); }
};

document.getElementById("emoji-btn").onclick = function() { document.getElementById("emoji-bar").classList.toggle("active"); };
document.querySelectorAll("#emoji-bar span").forEach(function(sp) {
  sp.onclick = function() {
    const inp = document.getElementById("msg-input");
    inp.value += sp.innerText;
    inp.focus();
  };
});
document.getElementById("msg-input").addEventListener("input", function() {
  if (!isGroupChat && activePeerPhone) {
    sendHeartbeat(activePeerPhone);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function() { sendHeartbeat(""); }, 3000);
  }
});

document.getElementById("act-cancel").onclick = function() { document.getElementById("msg-action-sheet").classList.remove("active"); };
document.getElementById("act-reply").onclick = function() {
  document.getElementById("msg-action-sheet").classList.remove("active");
  if (!selectedMsgObj) return;
  replyToText = selectedMsgObj.text || "Media";
  document.getElementById("reply-preview-text").innerText = "Replying: " + replyToText;
  document.getElementById("reply-bar").style.display = "flex";
};
document.getElementById("act-copy").onclick = function() {
  document.getElementById("msg-action-sheet").classList.remove("active");
  if (selectedMsgObj && selectedMsgObj.text) { navigator.clipboard.writeText(selectedMsgObj.text); alert("Copied!"); }
};
document.getElementById("act-delete").onclick = async function() {
  document.getElementById("msg-action-sheet").classList.remove("active");
  if (selectedMsgObj && confirm("Delete message for everyone?")) {
    await fetch("https://" + host + "/v1/" + selectedMsgObj.docName, { method: "DELETE" });
    lastMsgHash = ""; fetchMessages(false);
  }
};
document.getElementById("act-forward").onclick = function() {
  document.getElementById("msg-action-sheet").classList.remove("active");
  if (!selectedMsgObj) return;
  forwardPayload = selectedMsgObj;
  const fList = document.getElementById("forward-list"); fList.innerHTML = "";
  loadedGroupsCache.forEach(function(g) {
    const row = createListRow(g.name, "Group", true, false, "", "", 0);
    row.onclick = async function() { await sendForward(g.id, g.name); };
    fList.appendChild(row);
  });
  matchedContacts.forEach(function(ct) {
    const rId = [me.phone, ct.phone].sort().join("_");
    const row = createListRow(ct.name, ct.phone, false, false, "", "", 0);
    row.onclick = async function() { await sendForward(rId, ct.name); };
    fList.appendChild(row);
  });
  document.getElementById("forward-modal").classList.add("active"); pushNavState("forward");
};
document.getElementById("close-forward-modal").onclick = function() { document.getElementById("forward-modal").classList.remove("active"); };
async function sendForward(targetRoomId, targetTitle) {
  await fetch(BASE_URL + "/chats/" + encodeURIComponent(targetRoomId) + "/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {
      sender: { stringValue: me.phone }, senderName: { stringValue: me.name },
      text: { stringValue: forwardPayload.text ? await encryptText(forwardPayload.text, targetRoomId) : "" },
      forwarded: { booleanValue: true }, mediaType: { stringValue: forwardPayload.mediaType || "text" },
      mediaUrl: { stringValue: forwardPayload.mediaUrl ? await encryptText(forwardPayload.mediaUrl, targetRoomId) : "" },
      read: { booleanValue: false }, time: { integerValue: String(Date.now()) }
    } })
  });
  document.getElementById("forward-modal").classList.remove("active");
  alert("Forwarded to " + targetTitle);
}

document.getElementById("cancel-reply-btn").onclick = function() { replyToText = ""; document.getElementById("reply-bar").style.display = "none"; };

async function fetchMessages(forceScrollBottom) {
  if (!activeChatId) return;
  try {
    const res = await fetch(BASE_URL + "/chats/" + encodeURIComponent(activeChatId) + "/messages?pageSize=200");
    const data = await res.json();
    const docs = (data.documents || []).sort(function(a, b) { return Number(a.fields.time.integerValue) - Number(b.fields.time.integerValue); });
    const h = docs.map(function(d) { return d.name + ":" + (d.fields.read ? d.fields.read.booleanValue : false); }).join(",") + "|" + chatSearchFilter;
    if (h === lastMsgHash) return;
    lastMsgHash = h;

    const box = document.getElementById("messages-container");
    const isNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 120;
    const prevScrollHeight = box.scrollHeight;
    const prevScrollTop = box.scrollTop;

    box.innerHTML = "";
    for (let i = 0; i < docs.length; i++) {
      const docObj = docs[i], f = docObj.fields, sP = normPhone(f.sender.stringValue), isMe = sP === me.phone;
      const isRead = f.read && f.read.booleanValue === true;
      if (!isMe && !isRead) {
        fetch("https://" + host + "/v1/" + docObj.name + "?updateMask.fieldPaths=read", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { read: { booleanValue: true } } }) }).catch(function() {});
      }
      let plainMsg = f.text && f.text.stringValue ? await decryptText(f.text.stringValue, activeChatId) : "";
      if (chatSearchFilter && plainMsg.toLowerCase().indexOf(chatSearchFilter) === -1) continue;
      const div = document.createElement("div"); div.className = "msg " + (isMe ? "me" : "them");
      if (f.forwarded && f.forwarded.booleanValue) { const fw = document.createElement("div"); fw.className = "msg-fwd"; fw.innerText = "\u27A1 Forwarded"; div.appendChild(fw); }
      if (isGroupChat && !isMe) { const st = document.createElement("div"); st.className = "msg-sender"; st.innerText = savedContacts[sP] || sP; div.appendChild(st); }
      if (f.replyTo && f.replyTo.stringValue) { const qDiv = document.createElement("div"); qDiv.className = "msg-quote"; qDiv.innerText = await decryptText(f.replyTo.stringValue, activeChatId); div.appendChild(qDiv); }
      const mT = f.mediaType ? f.mediaType.stringValue : "text", mU = f.mediaUrl && f.mediaUrl.stringValue ? await decryptText(f.mediaUrl.stringValue, activeChatId) : "";
      if (mT === "image" && mU) { const img = document.createElement("img"); img.src = mU; img.onclick = function(ev) { ev.stopPropagation(); window.open(mU, "_blank"); }; div.appendChild(img); }
      else if (mT === "video" && mU) { const vid = document.createElement("video"); vid.src = mU; vid.controls = true; vid.onclick = function(ev) { ev.stopPropagation(); }; div.appendChild(vid); }
      else if (mT === "audio" && mU) { const aud = document.createElement("audio"); aud.src = mU; aud.controls = true; aud.onclick = function(ev) { ev.stopPropagation(); }; div.appendChild(aud); }
      else if (mT === "doc" && mU) { const a = document.createElement("a"); a.href = mU; a.target = "_blank"; a.innerText = "\uD83D\uDCC4 Open Document"; a.style.color = "#b71c1c"; a.onclick = function(ev) { ev.stopPropagation(); }; div.appendChild(a); }
      if (plainMsg) { const txt = document.createElement("div"); txt.innerText = plainMsg; div.appendChild(txt); }
      const meta = document.createElement("div"); meta.className = "msg-meta";
      const tSpan = document.createElement("span"); tSpan.innerText = fmtTime(f.time.integerValue); meta.appendChild(tSpan);
      if (isMe) {
        const tk = document.createElement("span"); tk.className = "ticks" + (isRead ? " read" : ""); tk.innerText = " \u2713\u2713"; meta.appendChild(tk);
      }
      div.onclick = function() {
        selectedMsgObj = { docName: docObj.name, text: plainMsg, mediaType: mT, mediaUrl: mU, isMe: isMe };
        document.getElementById("act-delete").style.display = isMe ? "block" : "none";
        document.getElementById("msg-action-sheet").classList.add("active");
        pushNavState("actions");
      };
      div.appendChild(meta); box.appendChild(div);
    }

    if (forceScrollBottom || isNearBottom) {
      box.scrollTop = box.scrollHeight;
    } else {
      box.scrollTop = prevScrollTop + (box.scrollHeight - prevScrollHeight);
    }
  } catch (e) {}
}

async function postChatPayload(pT, mT, pU) {
  const repEnc = replyToText ? await encryptText(replyToText, activeChatId) : "";
  replyToText = ""; document.getElementById("reply-bar").style.display = "none";
  sendHeartbeat("");
  await fetch(BASE_URL + "/chats/" + encodeURIComponent(activeChatId) + "/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { sender: { stringValue: me.phone }, senderName: { stringValue: me.name }, text: { stringValue: pT ? await encryptText(pT, activeChatId) : "" }, replyTo: { stringValue: repEnc }, mediaType: { stringValue: mT || "text" }, mediaUrl: { stringValue: pU ? await encryptText(pU, activeChatId) : "" }, read: { booleanValue: false }, time: { integerValue: String(Date.now()) } } })
  });
  lastMsgHash = ""; fetchMessages(true);
}

document.getElementById("send-msg-btn").onclick = function() { const i = document.getElementById("msg-input"), t = i.value.trim(); if (t && activeChatId) { i.value = ""; postChatPayload(t, "text", ""); } };
document.getElementById("msg-input").addEventListener("keypress", function(e) { if (e.key === "Enter") document.getElementById("send-msg-btn").click(); });

document.getElementById("mic-btn").onclick = async function() {
  const btn = document.getElementById("mic-btn");
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = []; mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function(ev) { if (ev.data.size > 0) audioChunks.push(ev.data); };
      mediaRecorder.onstop = function() {
        stream.getTracks().forEach(function(t) { t.stop(); });
        const blob = new Blob(audioChunks, { type: "audio/webm" });
        const r = new FileReader(); r.onload = function() { postChatPayload("Voice Note", "audio", r.result); }; r.readAsDataURL(blob);
      };
      mediaRecorder.start(); btn.classList.add("recording");
    } catch (e) { alert("Microphone permission allow karein!"); }
  } else { mediaRecorder.stop(); btn.classList.remove("recording"); }
};

document.getElementById("attach-btn").onclick = function() { document.getElementById("media-picker").click(); };
document.getElementById("media-picker").onchange = async function(e) {
  const file = e.target.files[0]; e.target.value = ""; if (!file || !activeChatId) return;
  const b = document.getElementById("upload-banner"); b.style.display = "block";
  try {
    if (file.type.indexOf("image/") === 0) {
      const r = new FileReader(); r.onload = function(ev) { const img = new Image(); img.onload = async function() { const c = document.createElement("canvas"), sc = img.width > 720 ? 720 / img.width : 1; c.width = img.width * sc; c.height = img.height * sc; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); await postChatPayload("Photo", "image", c.toDataURL("image/jpeg", 0.65)); b.style.display = "none"; }; img.src = ev.target.result; }; r.readAsDataURL(file); return;
    } else {
      const fd = new FormData(); fd.append("reqtype", "fileupload"); fd.append("fileToUpload", file);
      const res = await fetch("https://" + ["catbox", "moe"].join(".") + "/user/api.php", { method: "POST", body: fd });
      const fUrl = (await res.text()).trim();
      if (fUrl.indexOf("http") === 0) await postChatPayload(file.name, file.type.indexOf("video/") === 0 ? "video" : "doc", fUrl);
    }
  } catch (err) {} b.style.display = "none";
};

// STRICT AUDIO vs VIDEO CALL UI & STREAMING
const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ]
};

function setupCallStage(isVideo, peerTitle) {
  document.getElementById("call-peer-name").innerText = peerTitle;
  document.getElementById("call-type-badge").innerText = isVideo ? "VIDEO CALL" : "AUDIO CALL";
  document.getElementById("audio-call-avatar").innerText = (peerTitle || "M").charAt(0).toUpperCase();
  document.getElementById("video-stage").style.display = isVideo ? "flex" : "none";
  document.getElementById("audio-stage").style.display = isVideo ? "none" : "flex";
}

async function startDirectCall(isVideo) {
  if (!activePeerPhone && !isGroupChat) return;
  if (isGroupChat) return alert("Direct call 1-on-1 chat ke liye hai!");
  setupCallStage(isVideo, activeChatTitle);
  document.getElementById("call-status-text").innerText = isVideo ? "Starting camera..." : "Connecting audio...";
  document.getElementById("incoming-controls").style.display = "none";
  document.getElementById("active-controls").style.display = "flex";
  document.getElementById("call-overlay").classList.add("active");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    if (isVideo) document.getElementById("local-video").srcObject = localStream;
    pc = new RTCPeerConnection(ICE_CONFIG);
    localStream.getTracks().forEach(function(tr) { pc.addTrack(tr, localStream); });
    pc.ontrack = function(ev) {
      if (ev.streams && ev.streams[0]) {
        if (isVideo) document.getElementById("remote-video").srcObject = ev.streams[0];
        else document.getElementById("remote-audio").srcObject = ev.streams[0];
      }
      document.getElementById("call-status-text").innerText = "Connected";
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(function(r) {
      if (pc.iceGatheringState === "complete") return r();
      pc.onicegatheringstatechange = function() { if (pc.iceGatheringState === "complete") r(); };
      setTimeout(r, 2000);
    });
    const res = await fetch(BASE_URL + "/calls", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {
        callerPhone: { stringValue: me.phone }, caller: { stringValue: me.name },
        receiverPhone: { stringValue: activePeerPhone }, receiver: { stringValue: activeChatTitle },
        type: { stringValue: isVideo ? "Video Call" : "Voice Call" }, status: { stringValue: "ringing" },
        offer: { stringValue: JSON.stringify(pc.localDescription) }, answer: { stringValue: "" },
        time: { integerValue: String(Date.now()) }
      } })
    });
    const docData = await res.json();
    activeCallDocId = docData.name;
    document.getElementById("call-status-text").innerText = "Ringing...";
    if (callPollTimer) clearInterval(callPollTimer);
    callPollTimer = setInterval(async function() {
      if (!activeCallDocId) return;
      try {
        const r = await fetch("https://" + host + "/v1/" + activeCallDocId);
        const d = await r.json();
        if (!d.fields) return;
        const st = d.fields.status.stringValue;
        if (st === "ended") { closeCallUI(); }
        else if (st === "answered" && d.fields.answer.stringValue && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(d.fields.answer.stringValue)));
          document.getElementById("call-status-text").innerText = "In Call";
        }
      } catch (e) {}
    }, 1500);
  } catch (e) { alert("Permission error: " + e.message); closeCallUI(); }
}

async function checkIncomingCalls() {
  if (!me || activeCallDocId) return;
  try {
    const res = await fetch(BASE_URL + "/calls?pageSize=25");
    const data = await res.json();
    const docs = data.documents || [];
    for (let i = 0; i < docs.length; i++) {
      const f = docs[i].fields;
      if (f && f.receiverPhone && normPhone(f.receiverPhone.stringValue) === me.phone && f.status.stringValue === "ringing" && (Date.now() - Number(f.time.integerValue)) < 50000) {
        activeCallDocId = docs[i].name;
        incomingCallData = f;
        const isVid = f.type.stringValue === "Video Call";
        const cPhone = normPhone(f.callerPhone.stringValue);
        const callerTitle = savedContacts[cPhone] || f.caller.stringValue;
        setupCallStage(isVid, callerTitle);
        document.getElementById("call-status-text").innerText = "Incoming " + f.type.stringValue + "...";
        document.getElementById("incoming-controls").style.display = "flex";
        document.getElementById("active-controls").style.display = "none";
        document.getElementById("call-overlay").classList.add("active");
        startRinging();
        notifyUser("Incoming " + f.type.stringValue, callerTitle + " is calling you...", "");

        if (callPollTimer) clearInterval(callPollTimer);
        callPollTimer = setInterval(async function() {
          if (!activeCallDocId) return;
          try {
            const r = await fetch("https://" + host + "/v1/" + activeCallDocId);
            const d = await r.json();
            if (d.fields && d.fields.status.stringValue === "ended") closeCallUI();
          } catch (e) {}
        }, 1800);
        break;
      }
    }
  } catch (e) {}
}

document.getElementById("accept-call-btn").onclick = async function() {
  if (!activeCallDocId || !incomingCallData) return;
  stopRinging();
  const isVid = incomingCallData.type.stringValue === "Video Call";
  setupCallStage(isVid, document.getElementById("call-peer-name").innerText);
  document.getElementById("call-status-text").innerText = "Connecting...";
  document.getElementById("incoming-controls").style.display = "none";
  document.getElementById("active-controls").style.display = "flex";
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVid });
    if (isVid) document.getElementById("local-video").srcObject = localStream;
    pc = new RTCPeerConnection(ICE_CONFIG);
    localStream.getTracks().forEach(function(tr) { pc.addTrack(tr, localStream); });
    pc.ontrack = function(ev) {
      if (ev.streams && ev.streams[0]) {
        if (isVid) document.getElementById("remote-video").srcObject = ev.streams[0];
        else document.getElementById("remote-audio").srcObject = ev.streams[0];
      }
      document.getElementById("call-status-text").innerText = "In Call";
    };
    await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(incomingCallData.offer.stringValue)));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await new Promise(function(r) {
      if (pc.iceGatheringState === "complete") return r();
      pc.onicegatheringstatechange = function() { if (pc.iceGatheringState === "complete") r(); };
      setTimeout(r, 2000);
    });
    await fetch("https://" + host + "/v1/" + activeCallDocId + "?updateMask.fieldPaths=status&updateMask.fieldPaths=answer", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { status: { stringValue: "answered" }, answer: { stringValue: JSON.stringify(pc.localDescription) } } })
    });
    document.getElementById("call-status-text").innerText = "Connected";
  } catch (err) {
    alert("Call connect error: " + err.message);
    endDirectCall();
  }
};

document.getElementById("reject-call-btn").onclick = endDirectCall;
document.getElementById("end-call-btn").onclick = endDirectCall;

async function endDirectCall() {
  stopRinging();
  if (activeCallDocId) {
    fetch("https://" + host + "/v1/" + activeCallDocId + "?updateMask.fieldPaths=status", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { status: { stringValue: "ended" } } })
    }).catch(function() {});
  }
  closeCallUI();
}
function closeCallUI() {
  stopRinging();
  if (callPollTimer) clearInterval(callPollTimer);
  if (localStream) localStream.getTracks().forEach(function(t) { t.stop(); });
  if (pc) pc.close();
  pc = null; localStream = null; activeCallDocId = null; incomingCallData = null;
  document.getElementById("remote-video").srcObject = null;
  document.getElementById("local-video").srcObject = null;
  document.getElementById("remote-audio").srcObject = null;
  document.getElementById("call-overlay").classList.remove("active");
}
document.getElementById("mute-call-btn").onclick = function() {
  if (!localStream) return;
  const tr = localStream.getAudioTracks()[0];
  if (tr) { tr.enabled = !tr.enabled; this.style.background = tr.enabled ? "#424242" : "#b71c1c"; }
};
document.getElementById("voice-call-btn").onclick = function() { startDirectCall(false); };
document.getElementById("video-call-btn").onclick = function() { startDirectCall(true); };

// STATUS
document.getElementById("add-status-item").onclick = function() {
  tempStatusImg = "";
  document.getElementById("status-img-preview").style.display = "none";
  document.getElementById("status-text-input").value = "";
  document.getElementById("status-modal").classList.add("active");
  pushNavState("status");
};
document.getElementById("close-status-modal").onclick = function() { document.getElementById("status-modal").classList.remove("active"); };
document.getElementById("pick-status-img-btn").onclick = function() { document.getElementById("status-img-picker").click(); };
document.getElementById("status-img-picker").onchange = function(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = function(ev) {
    const img = new Image(); img.onload = function() {
      const c = document.createElement("canvas"), sc = img.width > 640 ? 640 / img.width : 1;
      c.width = img.width * sc; c.height = img.height * sc;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      tempStatusImg = c.toDataURL("image/jpeg", 0.65);
      const prev = document.getElementById("status-img-preview");
      prev.src = tempStatusImg; prev.style.display = "block";
    }; img.src = ev.target.result;
  }; r.readAsDataURL(f);
};
document.getElementById("post-status-submit").onclick = async function() {
  const t = document.getElementById("status-text-input").value.trim();
  if (!t && !tempStatusImg) return alert("Text likhein ya photo select karein!");
  await fetch(BASE_URL + "/statuses", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { authorPhone: { stringValue: me.phone }, author: { stringValue: me.name }, text: { stringValue: t }, image: { stringValue: tempStatusImg }, time: { integerValue: String(Date.now()) } } })
  });
  document.getElementById("status-modal").classList.remove("active"); loadStatuses();
};
async function loadStatuses() {
  const list = document.getElementById("status-list"); list.innerHTML = "";
  try {
    const res = await fetch(BASE_URL + "/statuses?pageSize=50"); const data = await res.json();
    const dayMs = 24 * 60 * 60 * 1000;
    (data.documents || []).sort(function(a, b) { return Number(b.fields.time.integerValue) - Number(a.fields.time.integerValue); }).forEach(function(d) {
      const f = d.fields, ts = Number(f.time.integerValue);
      if (Date.now() - ts > dayMs) return;
      const aP = f.authorPhone ? normPhone(f.authorPhone.stringValue) : "";
      if (aP && aP !== me.phone && !savedContacts[aP]) return;
      const author = aP === me.phone ? "My Status (You)" : (savedContacts[aP] || f.author.stringValue);
      const imgUrl = f.image ? f.image.stringValue : "";
      const row = createListRow(author, f.text.stringValue || "Photo Status", false, true, imgUrl, fmtTime(ts), 0);
      row.onclick = function() {
        document.getElementById("viewer-author").innerText = author + " \u2022 " + fmtTime(ts);
        const vImg = document.getElementById("viewer-img");
        if (imgUrl) { vImg.src = imgUrl; vImg.style.display = "block"; } else { vImg.style.display = "none"; }
        document.getElementById("viewer-text").innerText = f.text.stringValue || "";
        document.getElementById("status-viewer").classList.add("active"); pushNavState("viewer");
      };
      list.appendChild(row);
    });
  } catch (e) {}
}
document.getElementById("close-viewer").onclick = function() { document.getElementById("status-viewer").classList.remove("active"); };

async function loadCalls() {
  const list = document.getElementById("calls-list"); list.innerHTML = "";
  try {
    const res = await fetch(BASE_URL + "/calls?pageSize=50"); const data = await res.json();
    (data.documents || []).sort(function(a, b) { return Number(b.fields.time.integerValue) - Number(a.fields.time.integerValue); }).forEach(function(d) {
      const f = d.fields, cP = f.callerPhone ? normPhone(f.callerPhone.stringValue) : "", rP = f.receiverPhone ? normPhone(f.receiverPhone.stringValue) : "";
      if (cP !== me.phone && rP !== me.phone) return;
      const isOut = cP === me.phone;
      const peerName = isOut ? (savedContacts[rP] || f.receiver.stringValue) : (savedContacts[cP] || f.caller.stringValue);
      const dir = isOut ? "\u2197 Outgoing " : "\u2199 Incoming ";
      list.appendChild(createListRow(peerName, dir + f.type.stringValue, false, false, "", fmtTime(f.time.integerValue), 0));
    });
  } catch (e) {}
}

if (me) startApp();
// 1. Service Worker Register karein (Lock screen popup ke liye zaroori)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

// 2. Three Dots Menu Logic
function toggleMainMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('whatsappDropdown');
  menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}
document.addEventListener('click', () => {
  const menu = document.getElementById('whatsappDropdown');
  if (menu) menu.style.display = 'none';
});
function openSettingsModal() {
  document.getElementById('settingsModal').style.display = 'flex';
}
function closeSettingsModal() {
  document.getElementById('settingsModal').style.display = 'none';
}
function openMenuFeature(name) {
  alert(name + ' feature active hai!');
}

// 3. Message Tune (Clean WhatsApp-style double chime)
function playMessageTune() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [587.33, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.12);
      gain.gain.setValueAtTime(0.25, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.35);
    });
  } catch (e) {}
}

// 4. Lock Screen + Unlocked Popup Notification Trigger
async function triggerPopupNotification(senderName, messageText) {
  playMessageTune();
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') {
    await Notification.requestPermission();
  }
  if (Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker.getRegistration();
    const options = {
      body: messageText,
      icon: './icon.png',
      badge: './icon.png',
      vibrate: [200, 100, 200],
      tag: 'team-servis-msg',
      renotify: true,
      requireInteraction: true // Heads-up popup screen par rukne ke liye
    };
    if (reg) {
      reg.showNotification(senderName || 'Team Servis', options);
    } else {
      new Notification(senderName || 'Team Servis', options);
    }
  }
}

function testNotificationSound() {
  triggerPopupNotification('Team Servis', 'New message alert! Lock & unlock popup active.');
}