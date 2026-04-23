// server.js
const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory "database"
const users = {};    // username -> { username, password, wins, losses }
const sessions = {}; // token -> username
const games = {};    // gameId -> { id, players: [u1,u2], boardState, currentPlayer, winner }

// Simple auth middleware
function auth(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.username = sessions[token];
  next();
}

// Register
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing fields" });
  if (users[username]) return res.status(400).json({ error: "Username already exists" });

  users[username] = { username, password, wins: 0, losses: 0 };
  return res.json({ success: true });
});

// Login
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

// Create game
app.post("/api/game/create", auth, (req, res) => {
  const id = uuidv4();
  games[id] = {
    id,
    players: [req.username],
    boardState: null,
    currentPlayer: "X",
    winner: null,
  };
  res.json({ gameId: id });
});

// Join game
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

// Get game state
app.get("/api/game/:id", auth, (req, res) => {
  const game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });
  res.json(game);
});

// Update game state
app.post("/api/game/:id/state", auth, (req, res) => {
  const game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });

  const { boardState, currentPlayer, winner } = req.body;
  game.boardState = boardState;
  game.currentPlayer = currentPlayer;
  game.winner = winner || null;

  // Update leaderboard when game ends
  if (winner && game.players.length === 2) {
    const [p1, p2] = game.players;
    if (winner === "X") {
      users[p1].wins++;
      users[p2].losses++;
    } else if (winner === "O") {
      users[p2].wins++;
      users[p1].losses++;
    }
  }

  res.json({ success: true });
});

// Leaderboard
app.get("/api/leaderboard", (req, res) => {
  const list = Object.values(users)
    .map(u => ({ username: u.username, wins: u.wins, losses: u.losses }))
    .sort((a, b) => b.wins - a.wins);
  res.json(list);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
