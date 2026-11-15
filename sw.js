const host = ["firestore", "googleapis", "com"].join(".");
const BASE_URL = "https://" + host + "/v1/projects/team-servis/databases/(default)/documents";
let myPhone = "";
let myContacts = {};
let seenCallIds = {};
let seenMsgCounts = {};

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
  if (!myPhone) return;
  try {
    // 1. Check Incoming Calls
    const cRes = await fetch(BASE_URL + "/calls?pageSize=15");
    const cData = await cRes.json();
    (cData.documents || []).forEach(function(doc) {
      const f = doc.fields;
      if (f && f.receiverPhone && normP(f.receiverPhone.stringValue) === myPhone && f.status.stringValue === "ringing" && (Date.now() - Number(f.time.integerValue)) < 40000) {
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

    // 2. Check New Messages in Saved Contacts
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

setInterval(pollBackground, 5000);

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