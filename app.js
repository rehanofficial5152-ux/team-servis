const SECRET_CODE = "SERVIS2026";
const host = ["firestore", "googleapis", "com"].join(".");
const BASE_URL = "https://" + host + "/v1/projects/team-servis/databases/(default)/documents";
let me = JSON.parse(localStorage.getItem("ts_user") || "null");
let savedContacts = JSON.parse(localStorage.getItem("ts_contacts") || "{}");
let matchedContacts = [], loadedGroupsCache = [], activeChatId = null, activeChatTitle = "", isGroupChat = false, chatTimer = null, lastMsgCount = -1;

function normPhone(p) {
  let s = (p || "").replace(/\D/g, "");
  if (s.indexOf("92") === 0 && s.length === 12) s = "0" + s.slice(2);
  return s;
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
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(function(s) { s.classList.remove("active"); });
  document.getElementById(id).classList.add("active");
}
document.querySelectorAll(".wa-tab").forEach(function(tab) {
  tab.onclick = function() {
    document.querySelectorAll(".wa-tab").forEach(function(t) { t.classList.remove("active"); });
    document.querySelectorAll(".tab-view").forEach(function(v) { v.classList.remove("active"); });
    tab.classList.add("active");
    const v = tab.getAttribute("data-tab");
    document.getElementById(v).classList.add("active");
    if (v === "status-view") loadStatuses();
    if (v === "calls-view") loadCalls();
  };
});
document.getElementById("login-btn").onclick = async function() {
  const name = document.getElementById("user-name").value.trim();
  const phone = normPhone(document.getElementById("phone-number").value);
  const code = document.getElementById("team-code").value.trim().toUpperCase();
  const status = document.getElementById("status-msg");
  if (!name || phone.length < 10) { status.innerText = "Naam aur sahi mobile number likhein!"; return; }
  if (code !== SECRET_CODE) { status.innerText = "Ghalat Team Secret Code!"; return; }
  const btn = document.getElementById("login-btn"); btn.disabled = true; btn.innerText = "Securing...";
  try {
    const res = await fetch(BASE_URL + "/users/" + encodeURIComponent(phone), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { name: { stringValue: name }, phone: { stringValue: phone } } })
    });
    if (!res.ok) throw new Error("Server Error: " + res.status);
    me = { name: name, phone: phone }; localStorage.setItem("ts_user", JSON.stringify(me)); startApp();
  } catch (e) { status.innerText = "Error: " + e.message; btn.disabled = false; btn.innerText = "Agree & Continue"; }
};
function startApp() { showScreen("home-screen"); loadChatsAndGroups(); }
document.getElementById("refresh-btn").onclick = function() { loadChatsAndGroups(); loadStatuses(); loadCalls(); };
document.getElementById("logout-btn").onclick = function() { localStorage.removeItem("ts_user"); me = null; if (chatTimer) clearInterval(chatTimer); showScreen("login-screen"); };
async function openContactModal() {
  if ("contacts" in navigator && "ContactsManager" in window) {
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      if (picked && picked.length > 0) {
        picked.forEach(function(item) {
          const cName = (item.name && item.name) ? item.name.trim() : "Member";
          if (item.tel && item.tel.length > 0) {
            item.tel.forEach(function(rawTel) {
              const p = normPhone(rawTel);
              if (p.length >= 10 && p !== me.phone) savedContacts[p] = cName;
            });
          }
        });
        localStorage.setItem("ts_contacts", JSON.stringify(savedContacts));
        loadChatsAndGroups();
        return;
      }
    } catch (e) {}
  }
  document.getElementById("new-contact-name").value = ""; document.getElementById("new-contact-phone").value = "";
  document.getElementById("contact-modal").classList.add("active");
}
document.getElementById("add-contact-btn").onclick = openContactModal;
document.getElementById("fab-contact-btn").onclick = openContactModal;
document.getElementById("close-contact-modal").onclick = function() { document.getElementById("contact-modal").classList.remove("active"); };
document.getElementById("save-contact-submit").onclick = function() {
  const cName = document.getElementById("new-contact-name").value.trim(), cPhone = normPhone(document.getElementById("new-contact-phone").value);
  if (!cName || cPhone.length < 10) return alert("Sahi naam aur number likhein!");
  savedContacts[cPhone] = cName; localStorage.setItem("ts_contacts", JSON.stringify(savedContacts));
  document.getElementById("contact-modal").classList.remove("active"); loadChatsAndGroups();
};
document.getElementById("search-contact-input").oninput = function() { renderChatList(this.value.trim().toLowerCase()); };
async function loadChatsAndGroups() {
  const container = document.getElementById("chats-list"); container.innerText = "Syncing...";
  try {
    const [uR, gR] = await Promise.all([fetch(BASE_URL + "/users"), fetch(BASE_URL + "/groups")]);
    const uD = await uR.json(), gD = await gR.json();
    loadedGroupsCache = [];
    (gD.documents || []).forEach(function(g) {
      const f = g.fields; if (!f || !f.members) return;
      const m = f.members.stringValue || ""; if (m.indexOf(me.phone) === -1) return;
      loadedGroupsCache.push({ id: g.name.split("/").pop(), name: f.name.stringValue, members: m });
    });
    matchedContacts = [];
    (uD.documents || []).forEach(function(u) {
      const f = u.fields; if (!f) return;
      const uP = normPhone(f.phone.stringValue);
      if (uP !== me.phone && savedContacts[uP]) matchedContacts.push({ name: savedContacts[uP], phone: uP });
    });
    renderChatList("");
  } catch (e) { container.innerText = "Load error."; }
}
function renderChatList(flt) {
  const c = document.getElementById("chats-list"); c.innerHTML = "";
  loadedGroupsCache.forEach(function(g) {
    if (flt && g.name.toLowerCase().indexOf(flt) === -1) return;
    const item = createListRow(g.name, "Group • " + g.members.split(",").length + " members", true, false);
    item.onclick = function() { openChat(g.id, g.name, true, g.members); }; c.appendChild(item);
  });
  matchedContacts.forEach(function(ct) {
    if (flt && ct.name.toLowerCase().indexOf(flt) === -1 && ct.phone.indexOf(flt) === -1) return;
    const item = createListRow(ct.name, ct.phone, false, false);
    item.onclick = function() { openChat([me.phone, ct.phone].sort().join("_"), ct.name, false, ct.phone); }; c.appendChild(item);
  });
  if (c.children.length === 0) { c.innerText = "Neeche + dabakar phone contacts open karein!"; c.style.padding = "25px"; c.style.textAlign = "center"; }
}
function createListRow(t, s, isG, isS) {
  const item = document.createElement("div"); item.className = "list-item";
  const av = document.createElement("div"); av.className = "avatar" + (isG ? " group" : "") + (isS ? " status-ring" : ""); av.innerText = isG ? "G" : t.charAt(0).toUpperCase();
  const info = document.createElement("div"); info.className = "item-info";
  const h4 = document.createElement("h4"); h4.innerText = t; const p = document.createElement("p"); p.innerText = s;
  info.appendChild(h4); info.appendChild(p); item.appendChild(av); item.appendChild(info); return item;
}
function openGroupModal() {
  document.getElementById("group-name-input").value = "";
  const list = document.getElementById("group-members-checklist"); list.innerHTML = "";
  matchedContacts.forEach(function(u) {
    const row = document.createElement("label"); row.className = "list-item"; row.style.justifyContent = "space-between";
    const span = document.createElement("span"); span.innerText = u.name + " (" + u.phone + ")";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = u.phone; cb.style.width = "20px"; cb.style.height = "20px";
    row.appendChild(span); row.appendChild(cb); list.appendChild(row);
  });
  document.getElementById("group-modal").classList.add("active");
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
function openChat(cId, title, isG, sub) {
  activeChatId = cId; activeChatTitle = title; isGroupChat = isG; lastMsgCount = -1;
  document.getElementById("chat-title").innerText = title; document.getElementById("chat-subtitle").innerText = isG ? "Encrypted Group" : "End-to-End Encrypted";
  showScreen("chat-screen"); fetchMessages(); if (chatTimer) clearInterval(chatTimer); chatTimer = setInterval(fetchMessages, 3000);
}
document.getElementById("back-btn").onclick = function() { if (chatTimer) clearInterval(chatTimer); showScreen("home-screen"); loadChatsAndGroups(); };
async function fetchMessages() {
  if (!activeChatId) return;
  try {
    const res = await fetch(BASE_URL + "/chats/" + encodeURIComponent(activeChatId) + "/messages?pageSize=100");
    const data = await res.json();
    const docs = (data.documents || []).sort(function(a, b) { return Number(a.fields.time.integerValue) - Number(b.fields.time.integerValue); });
    if (docs.length === lastMsgCount) return; lastMsgCount = docs.length;
    const box = document.getElementById("messages-container"); box.innerHTML = "";
    for (let i = 0; i < docs.length; i++) {
      const f = docs[i].fields, sP = normPhone(f.sender.stringValue), isMe = sP === me.phone;
      const div = document.createElement("div"); div.className = "msg " + (isMe ? "me" : "them");
      if (isGroupChat && !isMe) { const st = document.createElement("div"); st.className = "msg-sender"; st.innerText = savedContacts[sP] || sP; div.appendChild(st); }
      const mT = f.mediaType ? f.mediaType.stringValue : "text", mU = f.mediaUrl && f.mediaUrl.stringValue ? await decryptText(f.mediaUrl.stringValue, activeChatId) : "";
      if (mT === "image" && mU) { const img = document.createElement("img"); img.src = mU; img.onclick = function() { window.open(mU, "_blank"); }; div.appendChild(img); }
      else if (mT === "video" && mU) { const vid = document.createElement("video"); vid.src = mU; vid.controls = true; div.appendChild(vid); }
      if (f.text && f.text.stringValue) { const txt = document.createElement("div"); txt.innerText = await decryptText(f.text.stringValue, activeChatId); div.appendChild(txt); }
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  } catch (e) {}
}
async function postChatPayload(pT, mT, pU) {
  await fetch(BASE_URL + "/chats/" + encodeURIComponent(activeChatId) + "/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { sender: { stringValue: me.phone }, senderName: { stringValue: me.name }, text: { stringValue: pT ? await encryptText(pT, activeChatId) : "" }, mediaType: { stringValue: mT || "text" }, mediaUrl: { stringValue: pU ? await encryptText(pU, activeChatId) : "" }, time: { integerValue: String(Date.now()) } } })
  });
  lastMsgCount = -1; fetchMessages();
}
document.getElementById("send-msg-btn").onclick = function() { const i = document.getElementById("msg-input"), t = i.value.trim(); if (t && activeChatId) { i.value = ""; postChatPayload(t, "text", ""); } };
document.getElementById("msg-input").addEventListener("keypress", function(e) { if (e.key === "Enter") document.getElementById("send-msg-btn").click(); });
document.getElementById("attach-btn").onclick = function() { document.getElementById("media-picker").click(); };
document.getElementById("media-picker").onchange = async function(e) {
  const file = e.target.files; e.target.value = ""; if (!file || !activeChatId) return;
  const b = document.getElementById("upload-banner"); b.style.display = "block";
  try {
    if (file.type.indexOf("image/") === 0) {
      const r = new FileReader(); r.onload = function(ev) { const img = new Image(); img.onload = async function() { const c = document.createElement("canvas"), sc = img.width > 720 ? 720 / img.width : 1; c.width = img.width * sc; c.height = img.height * sc; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); await postChatPayload("Photo", "image", c.toDataURL("image/jpeg", 0.65)); b.style.display = "none"; }; img.src = ev.target.result; }; r.readAsDataURL(file); return;
    } else if (file.type.indexOf("video/") === 0 && file.size <= 25 * 1024 * 1024) {
      const fd = new FormData(); fd.append("reqtype", "fileupload"); fd.append("fileToUpload", file);
      const res = await fetch("https://" + ["catbox", "moe"].join(".") + "/user/api.php", { method: "POST", body: fd });
      const vU = (await res.text()).trim(); if (vU.indexOf("http") === 0) await postChatPayload("Video", "video", vU);
    }
  } catch (err) {} b.style.display = "none";
};
document.getElementById("add-status-item").onclick = function() { document.getElementById("status-text-input").value = ""; document.getElementById("status-modal").classList.add("active"); };
document.getElementById("close-status-modal").onclick = function() { document.getElementById("status-modal").classList.remove("active"); };
document.getElementById("post-status-submit").onclick = async function() {
  const t = document.getElementById("status-text-input").value.trim(); if (!t) return;
  await fetch(BASE_URL + "/statuses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { authorPhone: { stringValue: me.phone }, author: { stringValue: me.name }, text: { stringValue: t }, time: { integerValue: String(Date.now()) } } }) });
  document.getElementById("status-modal").classList.remove("active"); loadStatuses();
};
async function loadStatuses() {
  const list = document.getElementById("status-list"); list.innerHTML = "";
  try {
    const res = await fetch(BASE_URL + "/statuses?pageSize=50"); const data = await res.json();
    (data.documents || []).sort(function(a, b) { return Number(b.fields.time.integerValue) - Number(a.fields.time.integerValue); }).forEach(function(d) {
      const f = d.fields, aP = f.authorPhone ? normPhone(f.authorPhone.stringValue) : "";
      if (aP && aP !== me.phone && !savedContacts[aP]) return;
      const author = aP === me.phone ? "My Status (You)" : (savedContacts[aP] || f.author.stringValue);
      const row = createListRow(author, f.text.stringValue, false, true);
      row.onclick = function() { document.getElementById("viewer-author").innerText = author; document.getElementById("viewer-text").innerText = f.text.stringValue; document.getElementById("status-viewer").classList.add("active"); };
      list.appendChild(row);
    });
  } catch (e) {}
}
document.getElementById("close-viewer").onclick = function() { document.getElementById("status-viewer").classList.remove("active"); };
async function startCall(type) {
  await fetch(BASE_URL + "/calls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { callerPhone: { stringValue: me.phone }, caller: { stringValue: me.name }, receiver: { stringValue: activeChatTitle }, type: { stringValue: type }, time: { integerValue: String(Date.now()) } } }) });
  window.open("https://" + ["meet", "jit", "si"].join(".") + "/TeamServis_" + activeChatId, "_blank");
}
document.getElementById("voice-call-btn").onclick = function() { startCall("Voice Call"); };
document.getElementById("video-call-btn").onclick = function() { startCall("Video Call"); };
async function loadCalls() {
  const list = document.getElementById("calls-list"); list.innerHTML = "";
  try {
    const res = await fetch(BASE_URL + "/calls?pageSize=50"); const data = await res.json();
    (data.documents || []).sort(function(a, b) { return Number(b.fields.time.integerValue) - Number(a.fields.time.integerValue); }).forEach(function(d) {
      const f = d.fields, cP = f.callerPhone ? normPhone(f.callerPhone.stringValue) : "";
      if (cP && cP !== me.phone && !savedContacts[cP]) return;
      list.appendChild(createListRow((cP === me.phone ? "You" : (savedContacts[cP] || f.caller.stringValue)) + " -> " + f.receiver.stringValue, f.type.stringValue, false, false));
    });
  } catch (e) {}
}
if (me) startApp();
