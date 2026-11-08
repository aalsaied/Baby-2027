const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

const rooms = new Map();
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const code = () => crypto.randomBytes(3).toString("hex").toUpperCase();

function snapshot(room) {
  return {
    id: room.id,
    teams: room.teams.map(t => ({
      name:t.name, joined:t.joined, pieces:t.pieces, placedIndices:t.placedIndices,
      finished:t.finished, elapsed:t.elapsed
    })),
    started:room.started,
    startAt:room.startAt,
    winner:room.winner
  };
}
function broadcast(room) {
  io.to(room.id).emit("room:update", snapshot(room));
}
function fail(cb, message) { if (typeof cb === "function") cb({error:message}); }

io.on("connection", socket => {
  socket.on("admin:create", ({names, teamCodes, pin}, cb) => {
    if (!Array.isArray(names) || names.length !== 2 ||
        names.some(n => typeof n !== "string" || !n.trim() || n.trim().length > 24)) {
      return fail(cb, "اكتب اسمَي الفريقين بشكل صحيح.");
    }
    if (!Array.isArray(teamCodes) || teamCodes.length !== 2 ||
        teamCodes.some(c => typeof c !== "string" || c.trim().length < 3 || c.trim().length > 12)) {
      return fail(cb, "رموز الفرق يجب أن تكون من 3 إلى 12 خانة.");
    }
    if (teamCodes[0].trim().toLowerCase() === teamCodes[1].trim().toLowerCase())
      return fail(cb, "اختر رمزَين مختلفَين للفريقين.");
    if (typeof pin !== "string" || pin.length < 4 || pin.length > 32)
      return fail(cb, "رمز الأدمن يجب أن يكون من 4 إلى 32 خانة.");

    let id = code();
    while (rooms.has(id)) id = code();
    const room = {
      id, adminHash:hash(pin), started:false, startAt:null, winner:null,
      teams:names.map((name,i)=>({
        name:name.trim(), codeHash:hash(teamCodes[i].trim()),
        socketId:null, joined:false, pieces:0, placedIndices:[], finished:false, elapsed:null
      }))
    };
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId=id;
    socket.data.role="admin";
    cb?.({ok:true, room:snapshot(room), roomId:id});
    broadcast(room);
  });

  socket.on("room:enter", ({roomId, mode, credential, teamIndex}, cb) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room) return fail(cb, "غرفة المنافسة غير موجودة.");
    if (!["admin","team","display"].includes(mode)) return fail(cb, "نوع الدخول غير صحيح.");

    if (mode === "admin") {
      if (hash(credential || "") !== room.adminHash) return fail(cb, "رمز الأدمن غير صحيح.");
      socket.join(room.id); socket.data.roomId=room.id; socket.data.role="admin";
    } else if (mode === "team") {
      if (![0,1].includes(Number(teamIndex))) return fail(cb, "اختر الفريق الصحيح.");
      const idx=Number(teamIndex), team=room.teams[idx];
      if (hash(credential || "") !== team.codeHash) return fail(cb, "رمز دخول الفريق غير صحيح.");
      if (team.socketId && team.socketId !== socket.id) {
        const old=io.sockets.sockets.get(team.socketId);
        if (old?.connected) return fail(cb, "هذا الفريق متصل بالفعل من جهاز آخر.");
      }
      team.socketId=socket.id; team.joined=true;
      socket.join(room.id); socket.data.roomId=room.id;
      socket.data.role="team"; socket.data.teamIndex=idx;
    } else {
      // Display mode is read-only; room ID is the viewing key.
      socket.join(room.id); socket.data.roomId=room.id; socket.data.role="display";
    }
    cb?.({ok:true, room:snapshot(room), role:mode, teamIndex:Number(teamIndex)});
    broadcast(room);
  });

  socket.on("admin:start", ({roomId}, cb) => {
    const room=rooms.get(String(roomId || "").toUpperCase());
    if (!room || socket.data.role!=="admin" || socket.data.roomId!==room.id)
      return fail(cb, "غير مصرح لك ببدء المنافسة.");
    if (room.started) return fail(cb, "المنافسة بدأت بالفعل.");
    if (!room.teams.every(t=>t.joined)) return fail(cb, "ينبغي دخول الفريقين أولاً.");
    room.started=true; room.startAt=Date.now();
    broadcast(room); cb?.({ok:true});
    io.to(room.id).emit("game:started");
  });

  socket.on("team:progress", ({pieces, pieceIndex}, cb) => {
    const room=rooms.get(socket.data.roomId);
    const idx=socket.data.teamIndex;
    if (!room || socket.data.role!=="team" || idx===undefined)
      return fail(cb, "هذا الإجراء متاح للفرق فقط.");
    if (!room.started || room.winner!==null) return fail(cb, "المنافسة غير نشطة.");
    const team=room.teams[idx];
    const idxValue=Number(pieceIndex);
    const count=Math.max(0,Math.min(48,Number(pieces)||0));
    if (!Number.isInteger(idxValue) || idxValue<0 || idxValue>=48 ||
        team.placedIndices.includes(idxValue) || count!==team.pieces+1)
      return fail(cb, "تحديث التقدم غير صالح.");
    team.placedIndices.push(idxValue);
    team.pieces=team.placedIndices.length;
    if (team.pieces===48 && !team.finished) {
      team.finished=true;
      team.elapsed=Date.now()-room.startAt;
      room.winner=idx;
      io.to(room.id).emit("game:winner", {
        winner:idx, name:team.name, elapsed:team.elapsed
      });
    }
    broadcast(room); cb?.({ok:true});
  });

  socket.on("disconnect", () => {
    const room=rooms.get(socket.data.roomId);
    const idx=socket.data.teamIndex;
    if (room && socket.data.role==="team" && idx!==undefined &&
        room.teams[idx].socketId===socket.id) {
      room.teams[idx].socketId=null;
      room.teams[idx].joined=false;
      broadcast(room);
    }
  });
});

server.listen(PORT,()=>console.log("Baby Reveal Race v2 listening on "+PORT));
