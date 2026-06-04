const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Undercover WS Server");
});

const wss = new WebSocketServer({ server });
const rooms = {};

function genCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

const DEFAULT_WORD_PAIRS = [
  ["Chien", "Chat"], ["Pizza", "Tarte flambée"], ["Plage", "Piscine"],
  ["Voiture", "Moto"], ["Café", "Thé"], ["Cinéma", "Théâtre"],
  ["Football", "Rugby"], ["Paris", "Lyon"], ["Chocolat", "Caramel"],
  ["Soleil", "Lune"], ["Hiver", "Automne"], ["Avion", "Hélicoptère"],
  ["Livre", "Revue"], ["Guitare", "Violon"], ["Champagne", "Prosecco"],
  ["Château", "Manoir"], ["Médecin", "Infirmier"], ["Requin", "Dauphin"],
  ["Fraise", "Framboise"], ["Montagne", "Colline"], ["Bière", "Cidre"],
  ["Vampire", "Zombie"], ["Astronaute", "Cosmonaute"], ["Instagram", "TikTok"],
  ["iPhone", "Samsung"],
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(data); });
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastAll(room) {
  room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) sendTo(p.ws, roomState(room, p.id)); });
}

function roomState(room, forPlayerId = null) {
  return {
    type: "room_state",
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, alive: p.alive, voted: p.voted,
      isUndercover: room.phase === "end" ? p.isUndercover : undefined,
      isMrWhite: room.phase === "end" ? p.isMrWhite : undefined,
    })),
    round: room.round,
    currentTurn: room.currentTurn,
    descriptionRound: room.descriptionRound,
    // How many times each player has spoken this round
    descCounts: room.descCounts || {},
    votes: room.phase === "vote" ? room.votes : undefined,
    lastEliminated: room.lastEliminated,
    winner: room.winner,
    wordWinner: room.wordWinner,
    wordsRevealed: room.wordsRevealed,
    civilWord: (room.phase === "end" || room.phase === "word_end") && room.wordsRevealed ? room.civilWord : undefined,
    undercoverWord: (room.phase === "end" || room.phase === "word_end") && room.wordsRevealed ? room.undercoverWord : undefined,
    myRole: forPlayerId ? getRoleInfo(room, forPlayerId) : undefined,
    descriptions: room.descriptions,
    settings: room.settings,
    customWords: room.customWords,
    wordsLeft: room.wordQueue ? room.wordQueue.length : 0,
    currentWordIndex: room.currentWordIndex,
    totalWords: room.settings.wordsPerGame,
  };
}

function getRoleInfo(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return null;
  if (player.isMrWhite) return { word: null, isMrWhite: true };
  if (player.isUndercover) return { word: room.undercoverWord, isMrWhite: false };
  return { word: room.civilWord, isMrWhite: false };
}

function buildWordQueue(room) {
  const pool = room.customWords.length > 0
    ? [...DEFAULT_WORD_PAIRS, ...room.customWords]
    : DEFAULT_WORD_PAIRS;
  return shuffle(pool).slice(0, Math.min(room.settings.wordsPerGame, pool.length));
}

function assignRolesAndWord(room) {
  const { nbUndercover, nbMrWhite } = room.settings;
  const alive = room.players.filter(p => p.alive);
  const pair = room.wordQueue.shift();
  const flip = Math.random() < 0.5;
  room.civilWord = flip ? pair[0] : pair[1];
  room.undercoverWord = flip ? pair[1] : pair[0];
  const shuffled = shuffle(alive);
  let uc = 0, mw = 0;
  shuffled.forEach(p => {
    p.isUndercover = false; p.isMrWhite = false;
    if (uc < nbUndercover) { p.isUndercover = true; uc++; }
    else if (mw < nbMrWhite) { p.isMrWhite = true; mw++; }
  });
}

// Returns the next player who still needs to speak in current sub-round
// Sub-round: each player speaks once before anyone speaks twice, etc.
function nextTurnPlayer(room) {
  const dpt = room.settings.descriptionsPerTurn || 1;
  const alive = room.players.filter(p => p.alive);

  // Find the minimum number of descriptions given so far
  const minGiven = Math.min(...alive.map(p => room.descCounts[p.id] || 0));

  // If everyone has spoken minGiven times and minGiven >= dpt → go to vote
  if (minGiven >= dpt) return null;

  // Find next player after current who hasn't spoken minGiven+1 times yet
  const currentIdx = alive.findIndex(p => p.id === room.currentTurn);
  for (let i = 1; i <= alive.length; i++) {
    const p = alive[(currentIdx + i) % alive.length];
    if ((room.descCounts[p.id] || 0) <= minGiven) return p.id;
  }
  return null;
}

function startWordRound(room) {
  room.players.forEach(p => { p.alive = true; p.voted = false; });
  assignRolesAndWord(room);
  room.phase = "describe";
  room.round++;
  room.descriptionRound = 1;
  room.votes = {};
  room.descriptions = {};
  room.descCounts = {};
  room.currentTurn = shuffle(room.players)[0]?.id;
  room.lastEliminated = null;
  room.wordsRevealed = false;
  broadcastAll(room);
}

function startGame(room) {
  room.wordQueue = buildWordQueue(room);
  room.currentWordIndex = 0;
  room.round = 0;
  room.players.forEach(p => { p.score = 0; p.alive = true; p.voted = false; });
  startWordRound(room);
}

function checkGameEnd(room) {
  const alive = room.players.filter(p => p.alive);
  const civils = alive.filter(p => !p.isUndercover && !p.isMrWhite);
  const undercovers = alive.filter(p => p.isUndercover);
  const mrWhites = alive.filter(p => p.isMrWhite);
  if (undercovers.length === 0 && mrWhites.length === 0) { civils.forEach(p => p.score += 2); return "civil"; }
  if (undercovers.length + mrWhites.length >= civils.length) { [...undercovers, ...mrWhites].forEach(p => p.score += 2); return "undercover"; }
  return null;
}

function nextWordOrEnd(room, wordWinner) {
  room.currentWordIndex++;
  const hasMore = room.wordQueue && room.wordQueue.length > 0;
  if (hasMore) {
    room.phase = "word_end";
    room.wordWinner = wordWinner;
    room.wordsRevealed = true;
  } else {
    room.winner = wordWinner;
    room.phase = "end";
    room.wordsRevealed = true;
  }
  broadcastAll(room);
}

function goToVote(room) {
  room.phase = "vote";
  room.players.forEach(p => p.voted = false);
  room.votes = {};
  broadcastAll(room);
}

function resolveVote(room) {
  const tally = {};
  Object.values(room.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
  let maxVotes = 0, eliminated = null, tie = false;
  for (const [id, count] of Object.entries(tally)) {
    if (count > maxVotes) { maxVotes = count; eliminated = id; tie = false; }
    else if (count === maxVotes) { tie = true; }
  }
  if (tie) {
    room.phase = "describe";
    room.descriptionRound++;
    room.votes = {};
    room.descriptions = {};
    room.descCounts = {};
    room.players.forEach(p => p.voted = false);
    room.currentTurn = shuffle(room.players.filter(p => p.alive))[0]?.id;
    return;
  }
  const player = room.players.find(p => p.id === eliminated);
  if (player) {
    player.alive = false;
    room.lastEliminated = { id: player.id, name: player.name, isUndercover: player.isUndercover, isMrWhite: player.isMrWhite };
    if (player.isMrWhite) {
      room.phase = "mrwhite_guess";
      room.mrWhiteId = player.id;
    } else {
      const result = checkGameEnd(room);
      if (result) { nextWordOrEnd(room, result); return; }
      room.phase = "describe";
      room.descriptionRound++;
      room.votes = {};
      room.descriptions = {};
      room.descCounts = {};
      room.players.forEach(p => p.voted = false);
      room.currentTurn = shuffle(room.players.filter(p => p.alive))[0]?.id;
    }
  }
}

wss.on("connection", ws => {
  let playerId = crypto.randomUUID();
  let playerRoom = null;

  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "create_room") {
      const code = genCode();
      const player = { id: playerId, name: msg.name.trim().slice(0, 20), ws, score: 0, alive: true, isUndercover: false, isMrWhite: false, voted: false };
      rooms[code] = {
        code, hostId: playerId, players: [player], phase: "lobby",
        round: 0, descriptionRound: 1, currentTurn: null,
        civilWord: null, undercoverWord: null, votes: {}, descriptions: {},
        descCounts: {}, lastEliminated: null, winner: null, wordWinner: null,
        wordsRevealed: false, mrWhiteId: null, wordQueue: [], currentWordIndex: 0, customWords: [],
        settings: { nbUndercover: 1, nbMrWhite: 0, wordsPerGame: 3, descriptionsPerTurn: 1 },
      };
      playerRoom = code;
      sendTo(ws, roomState(rooms[code], playerId));
      return;
    }

    if (msg.type === "join_room") {
      const room = rooms[msg.code?.toUpperCase()];
      if (!room) { sendTo(ws, { type: "error", message: "Salon introuvable." }); return; }
      if (room.phase !== "lobby") { sendTo(ws, { type: "error", message: "Partie déjà en cours." }); return; }
      if (room.players.length >= 10) { sendTo(ws, { type: "error", message: "Salon complet (10 max)." }); return; }
      const player = { id: playerId, name: msg.name.trim().slice(0, 20), ws, score: 0, alive: true, isUndercover: false, isMrWhite: false, voted: false };
      room.players.push(player);
      playerRoom = msg.code.toUpperCase();
      broadcastAll(room);
      return;
    }

    if (msg.type === "start_game") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId) return;
      if (room.players.length < 3) { sendTo(ws, { type: "error", message: "Il faut au moins 3 joueurs." }); return; }
      const total = room.settings.nbUndercover + room.settings.nbMrWhite;
      if (total >= room.players.length) { sendTo(ws, { type: "error", message: "Trop de rôles spéciaux." }); return; }
      startGame(room);
      return;
    }

    if (msg.type === "update_settings") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId || room.phase !== "lobby") return;
      room.settings = {
        nbUndercover: Math.max(1, parseInt(msg.nbUndercover) || 1),
        nbMrWhite: Math.max(0, parseInt(msg.nbMrWhite) || 0),
        wordsPerGame: Math.max(1, Math.min(20, parseInt(msg.wordsPerGame) || 3)),
        descriptionsPerTurn: Math.max(1, Math.min(5, parseInt(msg.descriptionsPerTurn) || 1)),
      };
      broadcastAll(room);
      return;
    }

    if (msg.type === "update_custom_words") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId || room.phase !== "lobby") return;
      const pairs = (msg.pairs || []).filter(p => Array.isArray(p) && p[0] && p[1]).slice(0, 50);
      room.customWords = pairs.map(p => [p[0].trim().slice(0, 30), p[1].trim().slice(0, 30)]);
      // Don't broadcast on every keystroke — only on explicit save
      sendTo(ws, roomState(room, playerId));
      return;
    }

    if (msg.type === "submit_description") {
      const room = rooms[playerRoom];
      if (!room || room.phase !== "describe") return;
      if (room.currentTurn !== playerId) return;
      const desc = (msg.description || "").trim().slice(0, 80);
      if (!desc) return;

      const player = room.players.find(p => p.id === playerId);
      if (!room.descriptions[playerId]) room.descriptions[playerId] = { name: player.name, entries: [] };
      room.descriptions[playerId].entries.push(desc);
      room.descCounts[playerId] = (room.descCounts[playerId] || 0) + 1;

      const dpt = room.settings.descriptionsPerTurn || 1;
      const alive = room.players.filter(p => p.alive);

      // Check if everyone has spoken dpt times
      const allDone = alive.every(p => (room.descCounts[p.id] || 0) >= dpt);
      if (allDone) {
        goToVote(room);
        return;
      }

      // Find next player in rotation (1 per player before cycling)
      const next = nextTurnPlayer(room);
      if (next === null) {
        goToVote(room);
      } else {
        room.currentTurn = next;
        broadcastAll(room);
      }
      return;
    }

    if (msg.type === "skip_to_vote") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId || room.phase !== "describe") return;
      goToVote(room);
      return;
    }

    if (msg.type === "vote") {
      const room = rooms[playerRoom];
      if (!room || room.phase !== "vote") return;
      const voter = room.players.find(p => p.id === playerId);
      if (!voter || !voter.alive || voter.voted) return;
      if (msg.targetId === playerId) return;
      room.votes[playerId] = msg.targetId;
      voter.voted = true;
      const allVoted = room.players.filter(p => p.alive).every(p => p.voted);
      if (allVoted) resolveVote(room);
      broadcastAll(room);
      return;
    }

    if (msg.type === "mrwhite_guess") {
      const room = rooms[playerRoom];
      if (!room || room.phase !== "mrwhite_guess") return;
      if (room.mrWhiteId !== playerId) return;
      const guess = (msg.guess || "").trim().toLowerCase();
      const correct = room.civilWord.toLowerCase();
      if (guess === correct) {
        const mw = room.players.find(p => p.id === playerId);
        if (mw) mw.score += 3;
        nextWordOrEnd(room, "mrwhite");
      } else {
        const result = checkGameEnd(room);
        if (result) { nextWordOrEnd(room, result); }
        else {
          room.phase = "describe";
          room.descriptionRound++;
          room.votes = {};
          room.descriptions = {};
          room.descCounts = {};
          room.players.forEach(p => p.voted = false);
          room.currentTurn = shuffle(room.players.filter(p => p.alive))[0]?.id;
          broadcastAll(room);
        }
      }
      return;
    }

    if (msg.type === "next_word") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId || room.phase !== "word_end") return;
      startWordRound(room);
      return;
    }

    if (msg.type === "next_round") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId) return;
      room.players.forEach(p => { p.alive = true; p.voted = false; p.isUndercover = false; p.isMrWhite = false; });
      room.phase = "lobby"; room.round = 0; room.votes = {}; room.descriptions = {};
      room.descCounts = {}; room.lastEliminated = null; room.winner = null;
      room.wordWinner = null; room.wordsRevealed = false; room.wordQueue = []; room.currentWordIndex = 0;
      broadcastAll(room);
      return;
    }
  });

  ws.on("close", () => {
    if (!playerRoom || !rooms[playerRoom]) return;
    const room = rooms[playerRoom];
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx !== -1) room.players[idx].ws = null;
    room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) sendTo(p.ws, roomState(room, p.id)); });
    const allGone = room.players.every(p => !p.ws || p.ws.readyState !== 1);
    if (allGone) setTimeout(() => { if (rooms[playerRoom]) delete rooms[playerRoom]; }, 60000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Undercover server on port ${PORT}`));
