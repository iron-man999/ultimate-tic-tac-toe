const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const users = {};      // username -> { username, password, wins, losses, friends, friendIncoming, friendOutgoing, challengeIncoming, challengeOutgoing }
const sessions = {};   // token -> username
const games = {};      // gameId -> { id, players, boardState, currentPlayer, winner }
const challenges = {}; // challengeId -> { id, from, to, status, gameId: optional }

// ---------- AUTH MIDDLEWARE ----------
function auth(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.username = sessions[token];
  next();
}

// ---------- AUTH ROUTES ----------
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

  res.json({ success: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) {
    return res.status(400).json({ error: "Invalid credentials" });
  }
  const token = uuidv4();
  sessions[token] = username;
  res.json({ token, username });
});

// ---------- GAME ROUTES ----------
app.post("/api/game/create", auth, (req, res) => {
  const id = uuidv4();
  games[id] = {
    id,
    players: [req.username],
    boardState: null,
    currentPlayer: "X",
    winner: null
  };
  res.json({ gameId: id });
});

app.post("/api/game/join", auth, (req, res) => {
  const { gameId } = req.body;
  const game = games[gameId];
  if (!game) return res.status(404).json({ error: "Game not found" });
  if (game.players.length >= 2) return res.status(400).json({ error: "Game full" });
  if (!game.players.includes(req.username)) {
    game.players.push(req.username);
  }
  res.json({ success: true, gameId });
});

app.get("/api/game/:id", auth, (req, res) => {
  const game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });
  res.json(game);
});

// BOT helper
function botMove(game) {
  if (game.winner) return;
  const state = game.boardState;
  if (!state) return;

  const emptyIndexes = [];
  state.cells.forEach((c, i) => {
    if (!c) emptyIndexes.push(i);
  });
  if (emptyIndexes.length === 0) return;

  const move = emptyIndexes[Math.floor(Math.random() * emptyIndexes.length)];
  state.cells[move] = "O";
  state.currentPlayer = "X";
}

// update game state
app.post("/api/game/:id/state", auth, (req, res) => {
  const game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });

  const { boardState, currentPlayer, winner } = req.body;
  game.boardState = boardState;
  game.currentPlayer = currentPlayer;
  game.winner = winner || null;

  // scoring
  if (winner && game.players.length === 2) {
    const [p1, p2] = game.players;
    if (winner === "X") {
      if (users[p1]) users[p1].wins++;
      if (users[p2]) users[p2].losses++;
    } else if (winner === "O") {
      if (users[p2]) users[p2].wins++;
      if (users[p1]) users[p1].losses++;
    }
  }

  // bot move if needed
  if (game.players.includes("BOT") && currentPlayer === "O" && !winner) {
    botMove(game);
  }

  res.json({ success: true });
});

// play vs bot
app.post("/api/game/bot", auth, (req, res) => {
  const id = uuidv4();
  games[id] = {
    id,
    players: [req.username, "BOT"],
    boardState: null,
    currentPlayer: "X",
    winner: null
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

// ---------- FRIEND SYSTEM ----------
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

  res.json({ success: true });
});

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

  if (!r.friends.includes(from)) r.friends.push(from);
  if (!f.friends.includes(receiver)) f.friends.push(receiver);

  res.json({ success: true });
});

app.get("/api/friends/list", auth, (req, res) => {
  const u = users[req.username];
  res.json({
    friends: u.friends,
    incoming: u.friendIncoming,
    outgoing: u.friendOutgoing
  });
});

// ---------- CHALLENGE SYSTEM ----------
app.post("/api/challenge/send", auth, (req, res) => {
  const { to } = req.body;
  const from = req.username;

  if (!users[to]) return res.status(404).json({ error: "User not found" });
  if (to === from) return res.status(400).json({ error: "Cannot challenge yourself" });

  const id = uuidv4();
  challenges[id] = { id, from, to, status: "pending", gameId: null };

  users[to].challengeIncoming.push(id);
  users[from].challengeOutgoing.push(id);

  res.json({ success: true, challengeId: id });
});

app.post("/api/challenge/accept", auth, (req, res) => {
  const { id } = req.body;
  const ch = challenges[id];
  if (!ch) return res.status(404).json({ error: "Challenge not found" });
  if (ch.to !== req.username) return res.status(403).json({ error: "Not your challenge" });
  if (ch.status !== "pending") return res.status(400).json({ error: "Already handled" });

  const gameId = uuidv4();
  games[gameId] = {
    id: gameId,
    players: [ch.from, ch.to],
    boardState: null,
    currentPlayer: "X",
    winner: null
  };

  ch.status = "accepted";
  ch.gameId = gameId;

  res.json({ gameId });
});

app.post("/api/challenge/decline", auth, (req, res) => {
  const { id } = req.body;
  const ch = challenges[id];
  if (!ch) return res.status(404).json({ error: "Challenge not found" });
  if (ch.to !== req.username) return res.status(403).json({ error: "Not your challenge" });
  if (ch.status !== "pending") return res.status(400).json({ error: "Already handled" });

  ch.status = "declined";
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
