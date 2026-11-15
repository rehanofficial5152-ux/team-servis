const host = ["firestore", "googleapis", "com"].join(".");
const BASE_URL = "https://" + host + "/v1/projects/team-servis/databases/(default)/documents";
let myPhone = "";
let myContacts = {};
let seenCallIds = {};
let seenMsgCounts = {};

function loadStateFromDB() {
  return new Promise(function(resolve) {
    try {
      const req = indexedDB.open("TeamServisDB", 1);
      req.onupgradeneeded = function(ev) { ev.target.result.createObjectStore("state"); };
      req.onsuccess = function(ev) {
        const db = ev.target.result;
        const tx = db.transaction("state", "readonly");
        const getReq = tx.objectStore("state").get("user_info");
        getReq.onsuccess = function() {
          if (getReq.result) {
            myPhone = getReq.result.phone || myPhone;
            myContacts = getReq.result.contacts || myContacts;
          }
          resolve();
        };
        getReq.onerror = function() { resolve(); };
      };
      req.onerror = function() { resolve(); };
    } catch (e) { resolve(); }
  });
}

self.addEventListener("install", function(e) {
  self.skipWaiting();
});

self.addEventListener("activate", function(e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("message", function(e) {
  if (e.data && e.data.type === "SET_USER") {
    myPhone = e.data.phone || "";
    myContacts = e.data.contacts || {};
  }
});

function normP(p) {
  let s = (p || "").replace(/\D/g, "");
  if (s.indexOf("92") === 0 && s.length === 12) s = "0" + s.slice(2);
  return s;
}

async function pollBackground() {
  if (!myPhone) await loadStateFromDB();
  if (!myPhone) return;
  try {
    const cRes = await fetch(BASE_URL + "/calls?pageSize=15");
    const cData = await cRes.json();
    (cData.documents || []).forEach(function(doc) {
      const f = doc.fields;
      if (f && f.receiverPhone && normP(f.receiverPhone.stringValue) === myPhone && f.status.stringValue === "ringing" && (Date.now() - Number(f.time.integerValue)) < 45000) {
        if (!seenCallIds[doc.name]) {
          seenCallIds[doc.name] = true;
          const cp = normP(f.callerPhone.stringValue);
          const cname = myContacts[cp] || f.caller.stringValue;
          self.registration.showNotification("Incoming " + f.type.stringValue, {
            body: cname + " is calling you on Team Servis...",
            vibrate: [500, 200, 500, 200, 500],
            requireInteraction: true,
            tag: "incoming_call"
          });
        }
      }
    });

    const peers = Object.keys(myContacts);
    for (let i = 0; i < peers.length; i++) {
      const roomId = [myPhone, peers[i]].sort().join("_");
      const mRes = await fetch(BASE_URL + "/chats/" + encodeURIComponent(roomId) + "/messages?pageSize=10");
      const mData = await mRes.json();
      const docs = mData.documents || [];
      let unread = 0;
      docs.forEach(function(d) {
        const f = d.fields;
        if (normP(f.sender.stringValue) !== myPhone && !(f.read && f.read.booleanValue === true)) unread++;
      });
      if (unread > 0 && seenMsgCounts[roomId] !== unread) {
        seenMsgCounts[roomId] = unread;
        self.registration.showNotification(myContacts[peers[i]], {
          body: unread + " new message(s) on Team Servis",
          vibrate: [200, 100, 200],
          tag: roomId
        });
      }
    }
  } catch (e) {}
}

setInterval(pollBackground, 4500);

self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        if ("focus" in clientList[i]) return clientList[i].focus();
      }
      if (clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});