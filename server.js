const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- JSON STORAGE ----------
const USERS_FILE = path.join(__dirname, "data", "users.json");

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let users = loadUsers();
const sessions = {};
const games = {};
const challenges = {};

function shortId() {
  return Math.random().toString(36).substring(2, 12);
}

function isExpired(game) {
  return game.expiresAt && game.expiresAt < Date.now();
}

// ---------- AUTH MIDDLEWARE ----------
function auth(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.username = sessions[token];
  next();
}

// ---------- REGISTER ----------
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing fields" });
  if (users[username]) return res.status(400).json({ error: "Username already exists" });

  users[username] = {
    username,
    password,
    wins: 0,
    losses: 0,
    friends: [],
    friendIncoming: [],
    friendOutgoing: [],
    challengeIncoming: [],
    challengeOutgoing: []
  };

  saveUsers();
  res.json({ success: true });
});

// ---------- LOGIN ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) {
    return res.status(400).json({ error: "Invalid credentials" });
  }
  const token = shortId() + shortId();
  sessions[token] = username;
  res.json({ token, username });
});

// ---------- CHANGE PASSWORD ----------
app.post("/api/change-password", auth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = users[req.username];

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: "Missing fields" });
  }

  if (user.password !== oldPassword) {
    return res.status(400).json({ error: "Old password incorrect" });
  }

  user.password = newPassword;
  saveUsers();
  res.json({ success: true });
});

// ---------- GAME CREATE ----------
app.post("/api/game/create", auth, (req, res) => {
  const id = shortId();
  games[id] = {
    id,
    players: [req.username],
    boardState: null,
    currentPlayer: "X",
    winner: null,
    expiresAt: Date.now() + 2 * 60 * 1000
  };
  res.json({ gameId: id });
});

// ---------- GAME JOIN ----------
app.post("/api/game/join", auth, (req, res) => {
  const { gameId } = req.body;
  const game = games[gameId];
  if (!game) return res.status(404).json({ error: "Game not found" });

  if (isExpired(game)) {
    delete games[gameId];
    return res.status(410).json({ error: "Game expired" });
  }

  if (game.players.length >= 2) return res.status(400).json({ error: "Game full" });
  if (!game.players.includes(req.username)) {
    game.players.push(req.username);
  }
  res.json({ success: true, gameId });
});

// ---------- GET GAME ----------
app.get("/api/game/:id", auth, (req, res) => {
  const game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });

  if (isExpired(game)) {
    delete games[req.params.id];
    return res.status(410).json({ error: "Game expired" });
  }

  res.json(game);
});

// ---------- BOT MOVE ----------
function botMove(game) {
  if (game.winner) return;
  const state = game.boardState;
  if (!state) return;

  const empty = [];
  state.cells.forEach((c, i) => {
    if (!c) empty.push(i);
  });
  if (empty.length === 0) return;

  const move = empty[Math.floor(Math.random() * empty.length)];
  state.cells[move] = "O";
  state.currentPlayer = "X";
}

// ---------- UPDATE GAME ----------
app.post("/api/game/:id/state", auth, (req, res) => {
  const game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });

  if (isExpired(game)) {
    delete games[req.params.id];
    return res.status(410).json({ error: "Game expired" });
  }

  const { boardState, currentPlayer, winner } = req.body;
  game.boardState = boardState;
  game.currentPlayer = currentPlayer;
  game.winner = winner || null;

  if (winner && game.players.length === 2) {
    const [p1, p2] = game.players;
    if (winner === "X") {
      users[p1].wins++;
      users[p2].losses++;
    } else {
      users[p2].wins++;
      users[p1].losses++;
    }
    saveUsers();
  }

  if (game.players.includes("BOT") && currentPlayer === "O" && !winner) {
    botMove(game);
  }

  res.json({ success: true });
});

// ---------- BOT GAME ----------
app.post("/api/game/bot", auth, (req, res) => {
  const id = shortId();
  games[id] = {
    id,
    players: [req.username, "BOT"],
    boardState: null,
    currentPlayer: "X",
    winner: null,
    expiresAt: Date.now() + 2 * 60 * 1000
  };
  res.json({ gameId: id });
});

// ---------- LEADERBOARD ----------
app.get("/api/leaderboard", (req, res) => {
  const list = Object.values(users)
    .map(u => ({ username: u.username, wins: u.wins, losses: u.losses }))
    .sort((a, b) => b.wins - a.wins);
  res.json(list);
});

// ---------- FRIEND REQUEST ----------
app.post("/api/friends/request", auth, (req, res) => {
  const { target } = req.body;
  const sender = req.username;

  if (!users[target]) return res.status(404).json({ error: "User not found" });
  if (target === sender) return res.status(400).json({ error: "Cannot friend yourself" });

  const u = users[sender];
  const t = users[target];

  if (u.friends.includes(target)) {
    return res.status(400).json({ error: "Already friends" });
  }
  if (!t.friendIncoming.includes(sender)) {
    t.friendIncoming.push(sender);
    u.friendOutgoing.push(target);
  }

  saveUsers();
  res.json({ success: true });
});

// ---------- ACCEPT FRIEND ----------
app.post("/api/friends/accept", auth, (req, res) => {
  const { from } = req.body;
  const receiver = req.username;

  const r = users[receiver];
  const f = users[from];

  if (!f || !r.friendIncoming.includes(from)) {
    return res.status(400).json({ error: "No request from this user" });
  }

  r.friendIncoming = r.friendIncoming.filter(u => u !== from);
  f.friendOutgoing = f.friendOutgoing.filter(u => u !== receiver);

  r.friends.push(from);
  f.friends.push(receiver);

  saveUsers();
  res.json({ success: true });
});

// ---------- FRIEND LIST ----------
app.get("/api/friends/list", auth, (req, res) => {
  const u = users[req.username];
  res.json({
    friends: u.friends,
    incoming: u.friendIncoming,
    outgoing: u.friendOutgoing
  });
});

// ---------- CHALLENGES ----------
app.post("/api/challenge/send", auth, (req, res) => {
  const { to } = req.body;
  const from = req.username;

  if (!users[to]) return res.status(404).json({ error: "User not found" });
  if (to === from) return res.status(400).json({ error: "Cannot challenge yourself" });

  const id = shortId();
  challenges[id] = { id, from, to, status: "pending", gameId: null };

  users[to].challengeIncoming.push(id);
  users[from].challengeOutgoing.push(id);

  saveUsers();
  res.json({ success: true, challengeId: id });
});

app.post("/api/challenge/accept", auth, (req, res) => {
  const { id } = req.body;
  const ch = challenges[id];
  if (!ch) return res.status(404).json({ error: "Challenge not found" });
  if (ch.to !== req.username) return res.status(403).json({ error: "Not your challenge" });

  const gameId = shortId();
  games[gameId] = {
    id: gameId,
    players: [ch.from, ch.to],
    boardState: null,
    currentPlayer: "X",
    winner: null,
    expiresAt: Date.now() + 2 * 60 * 1000
  };

  ch.status = "accepted";
  ch.gameId = gameId;

  saveUsers();
  res.json({ gameId });
});

app.post("/api/challenge/decline", auth, (req, res) => {
  const { id } = req.body;
  const ch = challenges[id];
  if (!ch) return res.status(404).json({ error: "Challenge not found" });
  if (ch.to !== req.username) return res.status(403).json({ error: "Not your challenge" });

  ch.status = "declined";
  saveUsers();
  res.json({ success: true });
});

app.get("/api/challenge/list", auth, (req, res) => {
  const u = users[req.username];
  const incoming = u.challengeIncoming.map(id => challenges[id]).filter(Boolean);
  const outgoing = u.challengeOutgoing.map(id => challenges[id]).filter(Boolean);
  res.json({ incoming, outgoing });
});

// ---------- USER PROFILE ----------
app.get("/api/user/:username", (req, res) => {
  const u = users[req.params.username];
  if (!u) return res.status(404).json({ error: "User not found" });

  res.json({
    username: u.username,
    wins: u.wins,
    losses: u.losses,
    friends: u.friends
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
