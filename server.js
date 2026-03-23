const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static('.'));

// ── Per-client sessions ──────────────────────────────────────────────────────
// Map<ws, { tiktokConnection, username, isConnected }>
const sessions = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────
function getAvatar(user, data) {
  return (user && user.profilePictureUrl) || (data && data.profilePictureUrl) || '';
}
function getUser(user, data, fallback) {
  var u = user || {};
  return (u.uniqueId || (data && data.uniqueId) || u.nickname || (data && data.nickname) || fallback || '').toLowerCase();
}
function getNick(user, data, fallback) {
  return (user && user.nickname) || (data && data.nickname) || fallback || '';
}

function send(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (e) { /* ignore closed sockets */ }
}

// ── Connect a single client to TikTok ────────────────────────────────────────
function connectTikTok(ws, username) {
  var session = sessions.get(ws);
  // Disconnect previous connection if any
  if (session && session.tiktokConnection) {
    try { session.tiktokConnection.disconnect(); } catch (e) {}
  }

  var opts = {
    processInitialData: true,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,  // 2s instead of default 1s to reduce rate-limit risk
    requestOptions: { timeout: 15000 },
    websocketOptions: { timeout: 15000 }
  };
  if (process.env.TIKTOK_SESSION_ID) opts.sessionId = process.env.TIKTOK_SESSION_ID;

  var tiktok = new WebcastPushConnection(username, opts);

  sessions.set(ws, { tiktokConnection: tiktok, username: username, isConnected: false, lastConnectAttempt: Date.now() });

  console.log('[TikTok] Connecting to @' + username + '...');

  tiktok.connect().then(function(state) {
    console.log('[TikTok] Connected to @' + username + ' | roomId:', state.roomId);
    var s = sessions.get(ws);
    if (s) s.isConnected = true;
    send(ws, { type: 'connected', username: username, roomId: state.roomId });
  }).catch(function(err) {
    console.error('[TikTok] Connection failed for @' + username + ':', err.message);
    send(ws, { type: 'error', message: 'TikTok connection failed: ' + err.message });
  });

  // ── Chat ──
  tiktok.on('chat', function(data) {
    var user = data.user || {};
    var uid = getUser(user, data, username);
    var nick = getNick(user, data, uid);
    var avatar = getAvatar(user, data);
    console.log('[Chat] @' + uid + ': ' + (data.comment || ''));
    send(ws, { type: 'chat', user: uid, nickname: nick, avatar: avatar, comment: data.comment || '' });
  });

  // ── Member join ──
  tiktok.on('member', function(data) {
    var user = data.user || {};
    var uid = getUser(user, data, '');
    var nick = getNick(user, data, uid);
    var avatar = getAvatar(user, data);
    if (!uid) return;
    console.log('[Member] @' + uid + ' joined');
    send(ws, { type: 'member', user: uid, nickname: nick, avatar: avatar });
  });

  // ── Gift ──
  tiktok.on('gift', function(data) {
    var user = data.user || {};
    var uid = getUser(user, data, 'unknown');
    var nick = getNick(user, data, uid);
    var avatar = getAvatar(user, data);
    var giftName = (data.giftName || data.describe || '').toLowerCase();
    var diamonds = data.diamondCount || 1;
    var repeat = data.repeatCount || 1;
    console.log('[Gift] @' + uid + ' sent ' + giftName + ' x' + repeat + ' (' + diamonds + ' diamonds)');
    send(ws, {
      type: 'gift', user: uid, nickname: nick, avatar: avatar,
      giftName: giftName, diamondCount: diamonds, repeatCount: repeat,
      giftId: data.giftId || 0
    });
  });

  // ── Like ──
  tiktok.on('like', function(data) {
    var user = data.user || {};
    var uid = getUser(user, data, '');
    var nick = getNick(user, data, uid);
    var avatar = getAvatar(user, data);
    if (!uid) return;
    console.log('[Like] @' + uid + ' x' + (data.likeCount || 1));
    send(ws, { type: 'like', user: uid, nickname: nick, avatar: avatar, likeCount: data.likeCount || 1 });
  });

  // ── Follow ──
  tiktok.on('follow', function(data) {
    var user = data.user || {};
    var uid = getUser(user, data, 'unknown');
    var nick = getNick(user, data, uid);
    var avatar = getAvatar(user, data);
    console.log('[Follow] @' + uid);
    send(ws, { type: 'follow', user: uid, nickname: nick, avatar: avatar });
  });

  // ── Share ──
  tiktok.on('share', function(data) {
    var user = data.user || {};
    var uid = getUser(user, data, 'unknown');
    var nick = getNick(user, data, uid);
    var avatar = getAvatar(user, data);
    console.log('[Share] @' + uid);
    send(ws, { type: 'share', user: uid, nickname: nick, avatar: avatar });
  });

  // ── Social ──
  tiktok.on('social', function(data) {
    var user = data.user || {};
    var uid = getUser(user, data, '');
    var nick = getNick(user, data, uid);
    var avatar = getAvatar(user, data);
    if (!uid) return;
    var label = data.displayType || data.label || 'social';
    console.log('[Social] @' + uid + ' → ' + label);
    send(ws, { type: 'social', user: uid, nickname: nick, avatar: avatar, label: label });
  });

  // ── Room user count ──
  tiktok.on('roomUser', function(data) {
    send(ws, { type: 'roomUser', viewerCount: data.viewerCount || 0 });
  });

  // ── Stream end ──
  tiktok.on('streamEnd', function(actionId) {
    console.log('[TikTok] Stream ended for @' + username);
    var s = sessions.get(ws);
    if (s) s.isConnected = false;
    send(ws, { type: 'streamEnd', actionId: actionId });
  });

  // ── Disconnected ──
  tiktok.on('disconnected', function() {
    console.log('[TikTok] Disconnected from @' + username);
    var s = sessions.get(ws);
    if (s) s.isConnected = false;
    send(ws, { type: 'disconnected' });
  });

  // ── Error ──
  tiktok.on('error', function(err) {
    console.error('[TikTok] Error for @' + username + ':', err.message);
    send(ws, { type: 'error', message: err.message });
  });

  // ── Raw data (debug) ──
  tiktok.on('rawData', function(messageTypeName) {
    // Only log uncommon events
    if (!['WebcastChatMessage','WebcastMemberMessage','WebcastGiftMessage','WebcastLikeMessage','WebcastSocialMessage'].includes(messageTypeName)) {
      console.log('[Raw] @' + username + ':', messageTypeName);
    }
  });
}

// ── WebSocket connection handler ─────────────────────────────────────────────
wss.on('connection', function(ws) {
  console.log('[WS] New client connected. Total:', wss.clients.size);

  ws.on('message', function(raw) {
    try {
      var msg = JSON.parse(raw);

      if (msg.action === 'connect' && msg.username) {
        var uname = msg.username.replace(/^@/, '').trim();
        if (!uname) {
          send(ws, { type: 'error', message: 'Username is required.' });
          return;
        }
        // Rate-limit: prevent reconnecting too fast (min 10s between attempts)
        var existing = sessions.get(ws);
        if (existing && existing.lastConnectAttempt && (Date.now() - existing.lastConnectAttempt < 10000)) {
          var wait = Math.ceil((10000 - (Date.now() - existing.lastConnectAttempt)) / 1000);
          console.log('[WS] Rate-limited reconnect for @' + uname + ', wait ' + wait + 's');
          send(ws, { type: 'error', message: 'Please wait ' + wait + 's before reconnecting.' });
          return;
        }
        console.log('[WS] Client wants to connect to @' + uname);
        connectTikTok(ws, uname);
      }

      else if (msg.action === 'disconnect') {
        var session = sessions.get(ws);
        if (session && session.tiktokConnection) {
          try { session.tiktokConnection.disconnect(); } catch (e) {}
          session.isConnected = false;
          console.log('[WS] Client disconnected from TikTok @' + session.username);
        }
        send(ws, { type: 'disconnected' });
      }

      else if (msg.action === 'status') {
        var session = sessions.get(ws);
        send(ws, {
          type: 'status',
          connected: !!(session && session.isConnected),
          username: session ? session.username : null
        });
      }

    } catch (e) {
      console.error('[WS] Bad message:', e.message);
    }
  });

  ws.on('close', function() {
    var session = sessions.get(ws);
    if (session) {
      if (session.tiktokConnection) {
        try { session.tiktokConnection.disconnect(); } catch (e) {}
      }
      console.log('[WS] Client disconnected. Was connected to @' + (session.username || '?'));
      sessions.delete(ws);
    }
    console.log('[WS] Clients remaining:', wss.clients.size);
  });

  ws.on('error', function(err) {
    console.error('[WS] Client error:', err.message);
  });
});

// ── Health check endpoint (keeps Render awake) ──────────────────────────────
app.get('/health', function(req, res) {
  res.json({ status: 'ok', sessions: sessions.size, uptime: process.uptime() });
});

// ── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, function() {
  console.log('=== Pickaxe Drop TikTok Server ===');
  console.log('Game:   http://localhost:' + PORT);
  console.log('Multi-session: each browser gets its own TikTok connection');
  console.log('==================================');

  // Keep Render free tier awake by self-pinging every 14 min
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(function() {
      var url = process.env.RENDER_EXTERNAL_URL + '/health';
      require('http').get(url.replace('https:', 'http:'), function() {}).on('error', function() {});
      console.log('[Keep-alive] Pinged ' + url);
    }, 14 * 60 * 1000);
  }
});
