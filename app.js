const SECRET_CODE = "SERVIS2026";
const host = ["firestore", "googleapis", "com"].join(".");
const BASE_URL = "https://" + host + "/v1/projects/team-servis/databases/(default)/documents";
let me = JSON.parse(localStorage.getItem("ts_user") || "null");
let savedContacts = JSON.parse(localStorage.getItem("ts_contacts") || "{}");
let matchedContacts = [], loadedGroupsCache = [], onlineMap = {}, activeChatId = null, activePeerPhone = "", activeChatTitle = "", isGroupChat = false, chatTimer = null, lastMsgHash = "";
let pc = null, localStream = null, activeCallDocId = null, callPollTimer = null, mediaRecorder = null, audioChunks = [];

function normPhone(p) {
  let s = (p || "").replace(/\D/g, "");
  if (s.indexOf("92") === 0 && s.length === 12) s = "0" + s.slice(2);
  return s;
}
function fmtTime(ts) {
  const d = new Date(Number(ts));
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
      body: JSON.stringify({ fields: { name: { stringValue: name }, phone: { stringValue: phone }, lastSeen: { integerValue: String(Date.now()) } } })
    });
    if (!res.ok) throw new Error("Server Error: " + res.status);
    me = { name: name, phone: phone }; localStorage.setItem("ts_user", JSON.stringify(me)); startApp();
  } catch (e) { status.innerText = "Error: " + e.message; btn.disabled = false; btn.innerText = "Agree & Continue"; }
};
function sendHeartbeat() {
  if (!me) return;
  fetch(BASE_URL + "/users/" + encodeURIComponent(me.phone) + "?updateMask.fieldPaths=lastSeen", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { lastSeen: { integerValue: String(Date.now()) } } })
  }).catch(function() {});
}
function startApp() {
  showScreen("home-screen");
  loadChatsAndGroups();
  sendHeartbeat();
  setInterval(sendHeartbeat, 15000);
  setInterval(checkIncomingCalls, 3000);
}
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
            item.tel.forEach(function(rawTel) { const p = normPhone(rawTel); if (p.length >= 10 && p !== me.phone) savedContacts[p] = cName; });
          }
        });
        localStorage.setItem("ts_contacts", JSON.stringify(savedContacts)); loadChatsAndGroups(); return;
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
  const container = document.getElementById("chats-list");
  try {
    const [uR, gR] = await Promise.all([fetch(BASE_URL + "/users"), fetch(BASE_URL + "/groups")]);
    const uD = await uR.json(), gD = await gR.json();
    loadedGroupsCache = [];
    (gD.documents || []).forEach(function(g) {
      const f = g.fields; if (!f || !f.members) return;
      const m = f.members.stringValue || ""; if (m.indexOf(me.phone) === -1) return;
      loadedGroupsCache.push({ id: g.name.split("/").pop(), name: f.name.stringValue, members: m });
    });
    matchedContacts = []; onlineMap = {};
    (uD.documents || []).forEach(function(u) {
      const f = u.fields; if (!f) return;
      const uP = normPhone(f.phone.stringValue);
      const ls = f.lastSeen ? Number(f.lastSeen.integerValue) : 0;
      onlineMap[uP] = (Date.now() - ls) < 35000 ? "Online" : (ls ? "Last seen " + fmtTime(ls) : "Offline");
      if (uP !== me.phone && savedContacts[uP]) matchedContacts.push({ name: savedContacts[uP], phone: uP });
    });
    renderChatList("");
  } catch (e) {}
}
function renderChatList(flt) {
  const c = document.getElementById("chats-list"); c.innerHTML = "";
  loadedGroupsCache.forEach(function(g) {
    if (flt && g.name.toLowerCase().indexOf(flt) === -1) return;
    const item = createListRow(g.name, "Group • " + g.members.split(",").length + " members", true, false);
    item.onclick = function() { openChat(g.id, g.name, true, ""); }; c.appendChild(item);
  });
  matchedContacts.forEach(function(ct) {
    if (flt && ct.name.toLowerCase().indexOf(flt) === -1 && ct.phone.indexOf(flt) === -1) return;
    const st = onlineMap[ct.phone] || ct.phone;
    const item = createListRow(ct.name, st, false, false);
    item.onclick = function() { openChat([me.phone, ct.phone].sort().join("_"), ct.name, false, ct.phone); }; c.appendChild(item);
  });
  if (c.children.length === 0) { c.innerText = "Neeche + dabakar team member ka number save karein!"; c.style.padding = "25px"; c.style.textAlign = "center"; }
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
function openChat(cId, title, isG, peerPhone) {
  activeChatId = cId; activeChatTitle = title; isGroupChat = isG; activePeerPhone = peerPhone; lastMsgHash = "";
  document.getElementById("chat-title").innerText = title;
  document.getElementById("chat-subtitle").innerText = isG ? "Encrypted Group" : (onlineMap[peerPhone] || "End-to-End Encrypted");
  showScreen("chat-screen"); fetchMessages(); if (chatTimer) clearInterval(chatTimer); chatTimer = setInterval(fetchMessages, 2500);
}
document.getElementById("back-btn").onclick = function() { if (chatTimer) clearInterval(chatTimer); showScreen("home-screen"); loadChatsAndGroups(); };
async function fetchMessages() {
  if (!activeChatId) return;
  try {
    const res = await fetch(BASE_URL + "/chats/" + encodeURIComponent(activeChatId) + "/messages?pageSize=100");
    const data = await res.json();
    const docs = (data.documents || []).sort(function(a, b) { return Number(a.fields.time.integerValue) - Number(b.fields.time.integerValue); });
    const h = docs.map(function(d) { return d.name; }).join(",");
    if (h === lastMsgHash) return; lastMsgHash = h;
    const box = document.getElementById("messages-container"); box.innerHTML = "";
    for (let i = 0; i < docs.length; i++) {
      const docObj = docs[i], f = docObj.fields, sP = normPhone(f.sender.stringValue), isMe = sP === me.phone;
      const div = document.createElement("div"); div.className = "msg " + (isMe ? "me" : "them");
      if (isGroupChat && !isMe) { const st = document.createElement("div"); st.className = "msg-sender"; st.innerText = savedContacts[sP] || sP; div.appendChild(st); }
      const mT = f.mediaType ? f.mediaType.stringValue : "text", mU = f.mediaUrl && f.mediaUrl.stringValue ? await decryptText(f.mediaUrl.stringValue, activeChatId) : "";
      if (mT === "image" && mU) { const img = document.createElement("img"); img.src = mU; img.onclick = function() { window.open(mU, "_blank"); }; div.appendChild(img); }
      else if (mT === "video" && mU) { const vid = document.createElement("video"); vid.src = mU; vid.controls = true; div.appendChild(vid); }
      else if (mT === "audio" && mU) { const aud = document.createElement("audio"); aud.src = mU; aud.controls = true; div.appendChild(aud); }
      else if (mT === "doc" && mU) { const a = document.createElement("a"); a.href = mU; a.target = "_blank"; a.innerText = "?? Open Document"; a.style.color = "#b71c1c"; div.appendChild(a); }
      if (f.text && f.text.stringValue) { const txt = document.createElement("div"); txt.innerText = await decryptText(f.text.stringValue, activeChatId); div.appendChild(txt); }
      const meta = document.createElement("div"); meta.className = "msg-meta"; meta.innerText = fmtTime(f.time.integerValue) + (isMe ? " ??" : "");
      if (isMe) { meta.style.cursor = "pointer"; meta.title = "Click to delete"; meta.onclick = async function() { if (confirm("Delete this message?")) { await fetch("https://" + host + "/v1/" + docObj.name, { method: "DELETE" }); lastMsgHash = ""; fetchMessages(); } }; }
      div.appendChild(meta); box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  } catch (e) {}
}
async function postChatPayload(pT, mT, pU) {
  await fetch(BASE_URL + "/chats/" + encodeURIComponent(activeChatId) + "/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { sender: { stringValue: me.phone }, senderName: { stringValue: me.name }, text: { stringValue: pT ? await encryptText(pT, activeChatId) : "" }, mediaType: { stringValue: mT || "text" }, mediaUrl: { stringValue: pU ? await encryptText(pU, activeChatId) : "" }, time: { integerValue: String(Date.now()) } } })
  });
  lastMsgHash = ""; fetchMessages();
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
        const r = new FileReader(); r.onload = function() { postChatPayload("?? Voice Note", "audio", r.result); }; r.readAsDataURL(blob);
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
      const r = new FileReader(); r.onload = function(ev) { const img = new Image(); img.onload = async function() { const c = document.createElement("canvas"), sc = img.width > 720 ? 720 / img.width : 1; c.width = img.width * sc; c.height = img.height * sc; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); await postChatPayload("?? Photo", "image", c.toDataURL("image/jpeg", 0.65)); b.style.display = "none"; }; img.src = ev.target.result; }; r.readAsDataURL(file); return;
    } else {
      const fd = new FormData(); fd.append("reqtype", "fileupload"); fd.append("fileToUpload", file);
      const res = await fetch("https://" + ["catbox", "moe"].join(".") + "/user/api.php", { method: "POST", body: fd });
      const fUrl = (await res.text()).trim();
      if (fUrl.indexOf("http") === 0) await postChatPayload(file.name, file.type.indexOf("video/") === 0 ? "video" : "doc", fUrl);
    }
  } catch (err) {} b.style.display = "none";
};
async function startDirectCall(isVideo) {
  if (!activePeerPhone && !isGroupChat) return;
  if (isGroupChat) return alert("Direct WebRTC call 1-on-1 chat ke liye hai!");
  document.getElementById("call-peer-name").innerText = activeChatTitle;
  document.getElementById("call-status-text").innerText = "Calling...";
  document.getElementById("incoming-controls").style.display = "none";
  document.getElementById("active-controls").style.display = "flex";
  document.getElementById("call-overlay").classList.add("active");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    document.getElementById("local-video").srcObject = localStream;
    pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:://google.com" }] });
    localStream.getTracks().forEach(function(tr) { pc.addTrack(tr, localStream); });
    pc.ontrack = function(ev) { document.getElementById("remote-video").srcObject = ev.streams[0]; document.getElementById("call-status-text").innerText = "Connected"; };
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await new Promise(function(r) { setTimeout(r, 1200); });
    const res = await fetch(BASE_URL + "/calls", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { callerPhone: { stringValue: me.phone }, caller: { stringValue: me.name }, receiverPhone: { stringValue: activePeerPhone }, receiver: { stringValue: activeChatTitle }, type: { stringValue: isVideo ? "Video Call" : "Voice Call" }, status: { stringValue: "ringing" }, offer: { stringValue: JSON.stringify(pc.localDescription) }, answer: { stringValue: "" }, time: { integerValue: String(Date.now()) } } })
    });
    const docData = await res.json(); activeCallDocId = docData.name;
    callPollTimer = setInterval(async function() {
      if (!activeCallDocId) return;
      const r = await fetch("https://" + host + "/v1/" + activeCallDocId); const d = await r.json();
      if (!d.fields) return;
      const st = d.fields.status.stringValue;
      if (st === "ended") { closeCallUI(); }
      else if (st === "answered" && d.fields.answer.stringValue && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(d.fields.answer.stringValue)));
        document.getElementById("call-status-text").innerText = "In Call";
      }
    }, 2000);
  } catch (e) { alert("Camera/Mic permission allow karein!"); closeCallUI(); }
}

async function checkIncomingCalls() {
  if (!me || activeCallDocId) return;
  try {
    const res = await fetch(BASE_URL + "/calls?pageSize=20"); const data = await res.json();
    const docs = data.documents || [];
    for (let i = 0; i < docs.length; i++) {
      const f = docs[i].fields;
      if (f && f.receiverPhone && normPhone(f.receiverPhone.stringValue) === me.phone && f.status.stringValue === "ringing" && (Date.now() - Number(f.time.integerValue)) < 30000) {
        activeCallDocId = docs[i].name;
        const cPhone = normPhone(f.callerPhone.stringValue);
        document.getElementById("call-peer-name").innerText = savedContacts[cPhone] || f.caller.stringValue;
        document.getElementById("call-status-text").innerText = "Incoming " + f.type.stringValue + "...";
        document.getElementById("incoming-controls").style.display = "flex";
        document.getElementById("active-controls").style.display = "none";
        document.getElementById("call-overlay").classList.add("active");
        document.getElementById("accept-call-btn").onclick = async function() {
          const isVid = f.type.stringValue === "Video Call";
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVid });
          document.getElementById("local-video").srcObject = localStream;
          pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:://google.com" }] });
          localStream.getTracks().forEach(function(tr) { pc.addTrack(tr, localStream); });
          pc.ontrack = function(ev) { document.getElementById("remote-video").srcObject = ev.streams[0]; };
          await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(f.offer.stringValue)));
          const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
          await new Promise(function(r) { setTimeout(r, 1200); });
          await fetch("https://" + host + "/v1/" + activeCallDocId + "?updateMask.fieldPaths=status&updateMask.fieldPaths=answer", {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { status: { stringValue: "answered" }, answer: { stringValue: JSON.stringify(pc.localDescription) } } })
          });
          document.getElementById("incoming-controls").style.display = "none";
          document.getElementById("active-controls").style.display = "flex";
          document.getElementById("call-status-text").innerText = "Connected";
        };
        document.getElementById("reject-call-btn").onclick = endDirectCall;
        break;
      }
    }
  } catch (e) {}
}

async function endDirectCall() {
  if (activeCallDocId) {
    fetch("https://" + host + "/v1/" + activeCallDocId + "?updateMask.fieldPaths=status", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { status: { stringValue: "ended" } } })
    }).catch(function() {});
  }
  closeCallUI();
}
function closeCallUI() {
  if (callPollTimer) clearInterval(callPollTimer);
  if (localStream) localStream.getTracks().forEach(function(t) { t.stop(); });
  if (pc) pc.close();
  pc = null; localStream = null; activeCallDocId = null;
  document.getElementById("call-overlay").classList.remove("active");
}
document.getElementById("end-call-btn").onclick = endDirectCall;
document.getElementById("mute-call-btn").onclick = function() {
  if (!localStream) return;
  const tr = localStream.getAudioTracks()[0];
  if (tr) { tr.enabled = !tr.enabled; this.innerText = tr.enabled ? "???" : "??"; }
};
document.getElementById("voice-call-btn").onclick = function() { startDirectCall(false); };
document.getElementById("video-call-btn").onclick = function() { startDirectCall(true); };

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
async function loadCalls() {
  const list = document.getElementById("calls-list"); list.innerHTML = "";
  try {
    const res = await fetch(BASE_URL + "/calls?pageSize=50"); const data = await res.json();
    (data.documents || []).sort(function(a, b) { return Number(b.fields.time.integerValue) - Number(a.fields.time.integerValue); }).forEach(function(d) {
      const f = d.fields, cP = f.callerPhone ? normPhone(f.callerPhone.stringValue) : "";
      if (cP && cP !== me.phone && !savedContacts[cP]) return;
      list.appendChild(createListRow((cP === me.phone ? "You" : (savedContacts[cP] || f.caller.stringValue)) + " -> " + f.receiver.stringValue, f.type.stringValue + " • " + fmtTime(f.time.integerValue), false, false));
    });
  } catch (e) {}
}
if (me) startApp();
