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

const WORD_PAIRS = [
  ["Chien", "Chat"],
  ["Pizza", "Tarte flambée"],
  ["Plage", "Piscine"],
  ["Voiture", "Moto"],
  ["Café", "Thé"],
  ["Cinéma", "Théâtre"],
  ["Football", "Rugby"],
  ["Paris", "Lyon"],
  ["Chocolat", "Caramel"],
  ["Soleil", "Lune"],
  ["Hiver", "Automne"],
  ["Avion", "Hélicoptère"],
  ["Livre", "Revue"],
  ["Guitare", "Violon"],
  ["Champagne", "Prosecco"],
  ["Château", "Manoir"],
  ["Médecin", "Infirmier"],
  ["Requin", "Dauphin"],
  ["Fraise", "Framboise"],
  ["Montagne", "Colline"],
  ["Bière", "Cidre"],
  ["Vampire", "Zombie"],
  ["Astronaute", "Cosmonaute"],
  ["Instagram", "TikTok"],
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
  room.players.forEach((p) => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function roomState(room, forPlayerId = null) {
  return {
    type: "room_state",
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      alive: p.alive,
      voted: p.voted,
      isUndercover: room.phase === "results" || room.phase === "end" ? p.isUndercover : undefined,
      isMrWhite: room.phase === "results" || room.phase === "end" ? p.isMrWhite : undefined,
    })),
    round: room.round,
    currentTurn: room.currentTurn,
    votes: room.phase === "vote" || room.phase === "results" ? room.votes : undefined,
    lastEliminated: room.lastEliminated,
    winner: room.winner,
    wordsRevealed: room.wordsRevealed,
    myRole: forPlayerId ? getRoleInfo(room, forPlayerId) : undefined,
    descriptions: room.descriptions,
    settings: room.settings,
  };
}

function getRoleInfo(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return null;
  if (player.isMrWhite) return { role: "mrwhite", word: null };
  if (player.isUndercover) return { role: "undercover", word: room.undercoverWord };
  return { role: "civil", word: room.civilWord };
}

function startGame(room) {
  const { nbUndercover, nbMrWhite, wordsPerGame } = room.settings;
  const alive = room.players.filter((p) => p.alive);

  const pairIdx = Math.floor(Math.random() * WORD_PAIRS.length);
  const [w1, w2] = WORD_PAIRS[pairIdx];
  const flip = Math.random() < 0.5;
  room.civilWord = flip ? w1 : w2;
  room.undercoverWord = flip ? w2 : w1;

  const shuffled = shuffle(alive);
  let uc = 0, mw = 0;
  shuffled.forEach((p, i) => {
    p.isUndercover = false;
    p.isMrWhite = false;
    if (uc < nbUndercover) { p.isUndercover = true; uc++; }
    else if (mw < nbMrWhite) { p.isMrWhite = true; mw++; }
  });

  room.phase = "describe";
  room.round++;
  room.votes = {};
  room.descriptions = {};
  room.currentTurn = shuffle(room.players.filter(p => p.alive))[0]?.id;
  room.lastEliminated = null;
  room.wordsRevealed = false;
  room.wordsPerGame = wordsPerGame;
  room.wordsSubmittedCount = 0;

  room.players.forEach((p) => {
    if (p.ws && p.ws.readyState === 1) {
      sendTo(p.ws, roomState(room, p.id));
    }
  });
}

function checkGameEnd(room) {
  const alive = room.players.filter((p) => p.alive);
  const civils = alive.filter((p) => !p.isUndercover && !p.isMrWhite);
  const undercovers = alive.filter((p) => p.isUndercover);
  const mrWhites = alive.filter((p) => p.isMrWhite);

  if (undercovers.length === 0 && mrWhites.length === 0) {
    room.winner = "civil";
    room.phase = "end";
    room.wordsRevealed = true;
    civils.forEach(p => p.score += 2);
    return true;
  }
  if (undercovers.length + mrWhites.length >= civils.length) {
    room.winner = "undercover";
    room.phase = "end";
    room.wordsRevealed = true;
    [...undercovers, ...mrWhites].forEach(p => p.score += 2);
    return true;
  }
  return false;
}

function resolveVote(room) {
  const tally = {};
  Object.values(room.votes).forEach((targetId) => {
    tally[targetId] = (tally[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let eliminated = null;
  let tie = false;

  for (const [id, count] of Object.entries(tally)) {
    if (count > maxVotes) { maxVotes = count; eliminated = id; tie = false; }
    else if (count === maxVotes) { tie = true; }
  }

  if (tie) {
    room.phase = "describe";
    room.votes = {};
    room.currentTurn = room.players.filter(p => p.alive)[0]?.id;
    return;
  }

  const player = room.players.find((p) => p.id === eliminated);
  if (player) {
    player.alive = false;
    room.lastEliminated = {
      id: player.id,
      name: player.name,
      isUndercover: player.isUndercover,
      isMrWhite: player.isMrWhite,
    };

    if (player.isMrWhite) {
      room.phase = "mrwhite_guess";
      room.mrWhiteId = player.id;
    } else {
      if (!checkGameEnd(room)) {
        room.phase = "describe";
        room.votes = {};
        room.descriptions = {};
        room.currentTurn = shuffle(room.players.filter(p => p.alive))[0]?.id;
      }
    }
  }
}

wss.on("connection", (ws) => {
  let playerId = crypto.randomUUID();
  let playerRoom = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "create_room") {
      const code = genCode();
      const player = {
        id: playerId, name: msg.name.trim().slice(0, 20),
        ws, score: 0, alive: true,
        isUndercover: false, isMrWhite: false, voted: false,
      };
      rooms[code] = {
        code, hostId: playerId,
        players: [player],
        phase: "lobby",
        round: 0, currentTurn: null,
        civilWord: null, undercoverWord: null,
        votes: {}, descriptions: {},
        lastEliminated: null, winner: null,
        wordsRevealed: false, mrWhiteId: null,
        settings: {
          nbUndercover: msg.nbUndercover || 1,
          nbMrWhite: msg.nbMrWhite || 0,
          wordsPerGame: msg.wordsPerGame || 3,
        },
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

      const player = {
        id: playerId, name: msg.name.trim().slice(0, 20),
        ws, score: 0, alive: true,
        isUndercover: false, isMrWhite: false, voted: false,
      };
      room.players.push(player);
      playerRoom = msg.code.toUpperCase();
      broadcast(room, roomState(room, null));
      sendTo(ws, roomState(room, playerId));
      return;
    }

    if (msg.type === "start_game") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId) return;
      if (room.players.length < 3) { sendTo(ws, { type: "error", message: "Il faut au moins 3 joueurs." }); return; }
      const totalSpecial = room.settings.nbUndercover + room.settings.nbMrWhite;
      if (totalSpecial >= room.players.length) { sendTo(ws, { type: "error", message: "Trop de rôles spéciaux pour ce nombre de joueurs." }); return; }
      startGame(room);
      return;
    }

    if (msg.type === "update_settings") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId || room.phase !== "lobby") return;
      room.settings = {
        nbUndercover: Math.max(1, parseInt(msg.nbUndercover) || 1),
        nbMrWhite: Math.max(0, parseInt(msg.nbMrWhite) || 0),
        wordsPerGame: Math.max(1, parseInt(msg.wordsPerGame) || 3),
      };
      broadcast(room, roomState(room));
      return;
    }

    if (msg.type === "submit_description") {
      const room = rooms[playerRoom];
      if (!room || room.phase !== "describe") return;
      if (room.currentTurn !== playerId) return;
      const desc = (msg.description || "").trim().slice(0, 80);
      if (!desc) return;

      const player = room.players.find(p => p.id === playerId);
      room.descriptions[playerId] = { name: player.name, text: desc };

      const alivePlayers = room.players.filter(p => p.alive);
      const allDescribed = alivePlayers.every(p => room.descriptions[p.id]);

      if (allDescribed) {
        room.phase = "vote";
        room.players.forEach(p => p.voted = false);
        room.votes = {};
      } else {
        const idx = alivePlayers.findIndex(p => p.id === playerId);
        room.currentTurn = alivePlayers[(idx + 1) % alivePlayers.length].id;
      }

      broadcast(room, roomState(room, null));
      room.players.forEach(p => {
        if (p.ws && p.ws.readyState === 1) sendTo(p.ws, roomState(room, p.id));
      });
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

      const alivePlayers = room.players.filter(p => p.alive);
      const allVoted = alivePlayers.every(p => p.voted);

      if (allVoted) {
        resolveVote(room);
      }

      room.players.forEach(p => {
        if (p.ws && p.ws.readyState === 1) sendTo(p.ws, roomState(room, p.id));
      });
      return;
    }

    if (msg.type === "mrwhite_guess") {
      const room = rooms[playerRoom];
      if (!room || room.phase !== "mrwhite_guess") return;
      if (room.mrWhiteId !== playerId) return;

      const guess = (msg.guess || "").trim().toLowerCase();
      const correct = room.civilWord.toLowerCase();

      if (guess === correct) {
        room.winner = "mrwhite";
        room.phase = "end";
        room.wordsRevealed = true;
        const mw = room.players.find(p => p.id === playerId);
        if (mw) mw.score += 3;
      } else {
        if (!checkGameEnd(room)) {
          room.phase = "describe";
          room.votes = {};
          room.descriptions = {};
          room.currentTurn = shuffle(room.players.filter(p => p.alive))[0]?.id;
        } else {
          room.wordsRevealed = true;
        }
      }

      room.players.forEach(p => {
        if (p.ws && p.ws.readyState === 1) sendTo(p.ws, roomState(room, p.id));
      });
      return;
    }

    if (msg.type === "next_round") {
      const room = rooms[playerRoom];
      if (!room || room.hostId !== playerId) return;
      room.players.forEach(p => { p.alive = true; p.voted = false; p.isUndercover = false; p.isMrWhite = false; });
      room.phase = "lobby";
      room.round = 0;
      room.votes = {};
      room.descriptions = {};
      room.lastEliminated = null;
      room.winner = null;
      room.wordsRevealed = false;
      broadcast(room, roomState(room));
      return;
    }
  });

  ws.on("close", () => {
    if (!playerRoom || !rooms[playerRoom]) return;
    const room = rooms[playerRoom];
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx !== -1) room.players[idx].ws = null;
    broadcast(room, roomState(room, null));
    const allGone = room.players.every(p => !p.ws || p.ws.readyState !== 1);
    if (allGone) setTimeout(() => { if (rooms[playerRoom]) delete rooms[playerRoom]; }, 60000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Undercover server on port ${PORT}`));
