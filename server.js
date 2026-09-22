const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_SECRET_IN_PRODUCTION";
const DATA = path.join(__dirname, "data", "db.json");

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname, "public")));

function loadDB(){
  if(!fs.existsSync(DATA)){
    const seed = {
      users: [],
      rooms: [
        {id:"general", name:"الغرفة العامة", description:"دردشة وترفيه للجميع", online:0},
        {id:"games", name:"الألعاب", description:"تحديات ومسابقات", online:0},
        {id:"music", name:"الموسيقى", description:"جلسات واستماع", online:0}
      ],
      announcements: [{id:Date.now(), title:"أهلاً بك في التطبيق 🎉", body:"ابدأ غرفة أو انضم إلى أصدقائك."}]
    };
    fs.writeFileSync(DATA, JSON.stringify(seed,null,2));
  }
  return JSON.parse(fs.readFileSync(DATA,"utf8"));
}
function saveDB(db){ fs.writeFileSync(DATA, JSON.stringify(db,null,2)); }
function tokenFor(user){ return jwt.sign({id:user.id, role:user.role}, JWT_SECRET, {expiresIn:"7d"}); }
function auth(req,res,next){
  const h=req.headers.authorization||"";
  try { req.user=jwt.verify(h.replace("Bearer ",""), JWT_SECRET); next(); }
  catch { res.status(401).json({error:"غير مصرح"}); }
}
function admin(req,res,next){ if(req.user.role!=="admin") return res.status(403).json({error:"للمشرفين فقط"}); next(); }

app.post("/api/register", async (req,res)=>{
  const {name,email,password}=req.body||{};
  if(!name||!email||!password||password.length<6) return res.status(400).json({error:"أدخل الاسم والبريد وكلمة مرور 6 أحرف على الأقل"});
  const db=loadDB();
  if(db.users.some(u=>u.email===email.toLowerCase())) return res.status(409).json({error:"البريد مستخدم بالفعل"});
  const user={id:Date.now().toString(),name,email:email.toLowerCase(),password:await bcrypt.hash(password,10),role:"user",createdAt:new Date().toISOString()};
  db.users.push(user); saveDB(db);
  res.json({token:tokenFor(user),user:{id:user.id,name:user.name,email:user.email,role:user.role}});
});
app.post("/api/login", async (req,res)=>{
  const {email,password}=req.body||{}, db=loadDB();
  const user=db.users.find(u=>u.email===String(email||"").toLowerCase());
  if(!user || !(await bcrypt.compare(password||"",user.password))) return res.status(401).json({error:"بيانات الدخول غير صحيحة"});
  res.json({token:tokenFor(user),user:{id:user.id,name:user.name,email:user.email,role:user.role}});
});
app.get("/api/me",auth,(req,res)=>{
  const u=loadDB().users.find(x=>x.id===req.user.id);
  res.json(u?{id:u.id,name:u.name,email:u.email,role:u.role}:{});
});
app.get("/api/rooms",auth,(req,res)=>res.json(loadDB().rooms));
app.post("/api/rooms",auth,admin,(req,res)=>{
  const {name,description}=req.body||{};
  if(!name) return res.status(400).json({error:"اسم الغرفة مطلوب"});
  const db=loadDB(), room={id:Date.now().toString(),name,description:description||"",online:0};
  db.rooms.push(room); saveDB(db); io.emit("rooms:changed",db.rooms); res.json(room);
});
app.delete("/api/rooms/:id",auth,admin,(req,res)=>{
  const db=loadDB(); db.rooms=db.rooms.filter(r=>r.id!==req.params.id); saveDB(db);
  io.emit("rooms:changed",db.rooms); res.json({ok:true});
});
app.get("/api/announcements",auth,(req,res)=>res.json(loadDB().announcements));
app.post("/api/announcements",auth,admin,(req,res)=>{
  const {title,body}=req.body||{}; if(!title) return res.status(400).json({error:"العنوان مطلوب"});
  const db=loadDB(); const a={id:Date.now(),title,body:body||""}; db.announcements.unshift(a); saveDB(db); io.emit("announcement",a); res.json(a);
});
app.get("/api/admin/stats",auth,admin,(req,res)=>{
  const db=loadDB(); res.json({users:db.users.length,rooms:db.rooms.length,announcements:db.announcements.length});
});
app.get("/api/admin/users",auth,admin,(req,res)=>{
  const db=loadDB(); res.json(db.users.map(({password,...u})=>u));
});
app.patch("/api/admin/users/:id",auth,admin,(req,res)=>{
  const db=loadDB(), u=db.users.find(x=>x.id===req.params.id);
  if(!u) return res.status(404).json({error:"المستخدم غير موجود"});
  if(req.body.role) u.role=req.body.role; if(req.body.name) u.name=req.body.name;
  saveDB(db); res.json({id:u.id,name:u.name,email:u.email,role:u.role});
});

io.on("connection", socket=>{
  socket.on("joinRoom", ({roomId,userName})=>{
    const room=loadDB().rooms.find(r=>r.id===roomId); if(!room) return;
    socket.join(roomId); socket.data.roomId=roomId; socket.data.userName=userName||"ضيف";
    const clients=io.sockets.adapter.rooms.get(roomId); room.online=clients?clients.size:1;
    io.emit("roomOnline",{roomId,online:room.online});
    socket.to(roomId).emit("system",`${socket.data.userName} انضم للغرفة`);
  });
  socket.on("message", ({roomId,text})=>{
    if(!text || !roomId) return;
    io.to(roomId).emit("message",{user:socket.data.userName||"ضيف",text:String(text).slice(0,500),time:new Date().toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"})});
  });
  socket.on("disconnect",()=>{
    const id=socket.data.roomId; if(!id) return;
    const clients=io.sockets.adapter.rooms.get(id); io.emit("roomOnline",{roomId:id,online:clients?clients.size:0});
  });
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT,()=>console.log(`Fun Arabia running on http://localhost:${PORT}`));