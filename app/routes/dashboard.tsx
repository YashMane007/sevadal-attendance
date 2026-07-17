import { Toast } from "~/components/Toast";
import { type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction, json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { requireMember } from "~/lib/session.server";
import PWAInstallPrompt from "~/components/PWAInstallPrompt";
import { getMemberById, getTodayAttendanceAll, getMemberMonthAttendanceCount, getMemberTotalAttendanceCount, getMemberAttendanceHistory, markAttendance, listLocations, getActiveSchedulesForDate, listSevaRoles, getLocationsWithAnySchedule, type ScheduleWithLocation } from "~/lib/db.server";
import { checkGeofence } from "~/lib/geofence";
import { checkRateLimit } from "~/lib/ratelimit.server";
import { getKillSwitch, shouldBlock } from "~/lib/killswitch.server";
import { getAppSettings } from "~/lib/appsettings.server";
import { listAnnouncements } from "~/lib/db.server";
import { logAudit } from "~/lib/audit.server";

export const meta: MetaFunction = () => [{ title: "Dashboard — Sevadal Attendance" }];
function todayISO() { return new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Kolkata"}); }
function nowHHMM() { return new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Kolkata"}).replace(".",":"); }
function formatTimeIST(iso:string|null){if(!iso)return"";const u=iso.endsWith("Z")?iso:iso+"Z";return new Date(u).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Kolkata"});}
function formatDateIST(iso:string){return new Date(iso+"T00:00:00").toLocaleDateString("en-IN",{weekday:"short",day:"numeric",month:"short",year:"numeric"});}
function isScheduleActiveNow(s:ScheduleWithLocation,hhmm:string){if(s.all_day)return true;if(!s.start_time||!s.end_time)return true;return hhmm>=s.start_time&&hhmm<=s.end_time;}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { DB, SESSION_SECRET } = context.cloudflare.env;
  const session = await requireMember(request, SESSION_SECRET, DB);
  if (session.isAdmin || session.isSuperAdmin) throw redirect("/admin");

  const ks = await getKillSwitch(DB);
  const blocked = shouldBlock(ks, "member");
  if (blocked) throw redirect("/maintenance");

  const today = todayISO();
  const [member, todayRecords, monthCount, totalCount, history, locations, schedules, sevaRoles, allScheduledLocationIds, announcements, appSettings] =
    await Promise.all([
      getMemberById(DB,session.memberId), getTodayAttendanceAll(DB,session.memberId,today),
      getMemberMonthAttendanceCount(DB,session.memberId,today.slice(0,7)),
      getMemberTotalAttendanceCount(DB,session.memberId),
      getMemberAttendanceHistory(DB,session.memberId,10),
      listLocations(DB,true), getActiveSchedulesForDate(DB,today), listSevaRoles(DB,true),
      getLocationsWithAnySchedule(DB),
      listAnnouncements(DB, { activeOnly: true, showTo: "member" }),
      getAppSettings(DB),
    ]);
  if (!member) throw redirect("/auth/logout");
  return json({ member, todayRecords, monthCount, totalCount, history, locations, schedules, sevaRoles, today, allScheduledLocationIds, announcements, appSettings });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { DB, SESSION_SECRET } = context.cloudflare.env;
  const session = await requireMember(request, SESSION_SECRET, DB);
  // Rate limit: per-member (10/hour) AND per-IP (30/hour shared)
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  const [rlMember, rlIp] = await Promise.all([
    checkRateLimit(DB, `attend:member:${session.memberId}`, 10, 3600),
    checkRateLimit(DB, `attend:ip:${ip}`, 30, 3600),
  ]);
  if (!rlMember.allowed || !rlIp.allowed) {
    return json({ error: "Too many attempts. Please wait a while, or ask an admin to mark your attendance." }, { status: 429 });
  }
  const form = await request.formData();
  const lat=parseFloat(form.get("lat") as string), lng=parseFloat(form.get("lng") as string), accuracy=parseFloat(form.get("accuracy") as string);
  const sevaRole=(form.get("sevaRole") as string)?.trim()||null;
  const customSeva=(form.get("customSevaRole") as string)?.trim()||null;
  const finalSeva=sevaRole==="__custom__"?customSeva:sevaRole;
  let scheduleIds:number[]=[];
  try{scheduleIds=JSON.parse(form.get("scheduleIds") as string);}catch{scheduleIds=[0];}
  if (!scheduleIds.length) scheduleIds=[0];
  if (isNaN(lat)||isNaN(lng)) return json({error:"Cannot get location. Enable GPS."},{status:400});
  if (!finalSeva) return json({error:"⚠️ Please select your Seva Role before marking attendance."},{status:400});
  const today=todayISO();
  const [allLocations, allScheduledLocIds] = await Promise.all([
    listLocations(DB,true),
    getLocationsWithAnySchedule(DB),
  ]);
  // Determine which locations to geofence against based on selected sessions
  let checkLocations = allLocations;
  if (scheduleIds.length===1 && scheduleIds[0]===0) {
    // Open Seva only — check against locations with NO schedules
    checkLocations = allLocations.filter(l=>!allScheduledLocIds.includes(l.id));
  } else {
    // Specific scheduled sessions — check only against those sessions' locations
    const schedules = await getActiveSchedulesForDate(DB, today);
    const selScheds = schedules.filter(s=>scheduleIds.includes(s.id));
    const locIds = [...new Set(selScheds.map(s=>s.location_id))];
    if (locIds.length>0) checkLocations = allLocations.filter(l=>locIds.includes(l.id));
  }
  const geo=checkGeofence(lat,lng,checkLocations);
  if (!geo) return json({error:"No satsang location is active for your area. If you think this is a mistake, please contact your admin."},{status:400});
  if (!geo.allowed) return json({error:`You are ${geo.distanceMeters}m from ${geo.locationName}. Must be within ${geo.radiusMeters}m.`},{status:403});
  const member=await getMemberById(DB,session.memberId);
  if (!member) throw redirect("/auth/logout");
  const schedules=await getActiveSchedulesForDate(DB,today);
  for (const schedId of scheduleIds) {
    const sched=schedules.find(s=>s.id===schedId);
    await markAttendance(DB,{memberId:session.memberId,memberName:member.name,sevaRole:finalSeva,locationId:sched?sched.location_id:geo.locationId,locationName:sched?sched.location_name:geo.locationName,date:today,lat,lng,accuracy,distanceMeters:geo.distanceMeters,scheduleId:schedId,satsangType:sched?.satsang_type_name??null,sessionLabel:sched?.label??null,markedById:null,markedByName:null});
  }
  await logAudit(DB,{ actorId:session.memberId, actorName:member.name, actorRole:"member", action:"attendance_marked", details:{date:today,location:geo.locationName,sevaRole:finalSeva,sessions:scheduleIds.length}, ip });
  return json({success:true,locationName:geo.locationName});
}

type GpsState={status:"idle"}|{status:"loading"}|{status:"success";lat:number;lng:number;accuracy:number}|{status:"error";message:string};

export default function DashboardPage() {
  const { member, todayRecords, monthCount, totalCount, history, locations, schedules, sevaRoles, today, allScheduledLocationIds, announcements, appSettings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as any;
  const nav = useNavigation();
  const submitting = nav.state==="submitting";
  const loading = nav.state==="loading";

  if (loading) {
    return (
      <div className="member-shell">
        <header className="member-header">
          <div className="member-header__logo">
            <div className="member-header__logo-mark">🙏</div>
            <span className="member-header__title">Sevadal</span>
          </div>
          <div className="skeleton skeleton-avatar" style={{width:32,height:32}}/>
        </header>
        <main className="member-content">
          <div className="skeleton skeleton-hero" style={{height:110}}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"1px",background:"var(--gray-100)"}}>
            {[0,1,2].map(i=><div key={i} style={{background:"white",padding:"14px 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:8}}><div className="skeleton skeleton-text" style={{width:40,height:22}}/><div className="skeleton skeleton-text" style={{width:60,height:11}}/></div>)}
          </div>
          <div className="skeleton-section">
            <div className="skeleton" style={{height:44}}/>
            <div className="skeleton skeleton-card"/>
            <div className="skeleton skeleton-card"/>
            <div className="skeleton" style={{height:52,borderRadius:"var(--radius-sm)"}}/>
            <div className="skeleton skeleton-btn"/>
          </div>
        </main>
        <nav className="bottom-nav">
          <div className="bottom-nav__item active"><div className="skeleton" style={{width:22,height:22,borderRadius:4}}/><div className="skeleton skeleton-text" style={{width:50,height:9}}/></div>
          <div className="bottom-nav__item"><div className="skeleton" style={{width:22,height:22,borderRadius:4}}/><div className="skeleton skeleton-text" style={{width:40,height:9}}/></div>
          <div className="bottom-nav__item"><div className="skeleton" style={{width:22,height:22,borderRadius:4}}/><div className="skeleton skeleton-text" style={{width:44,height:9}}/></div>
        </nav>
      </div>
    );
  }
  const [gps, setGps] = useState<GpsState>({status:"idle"});
  const [sevaRoleError, setSevaRoleError] = useState(false);
  const requestGps = useCallback(()=>{
    setGps({status:"loading"});
    // ── Notification permission ──────────────────────────────────────────────
    // Request HERE (same user-gesture context as GPS) so both dialogs appear
    // together. root.tsx only subscribes when permission is already granted.
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().then(perm => {
        if (perm !== "granted") return;
        if (!("serviceWorker" in navigator)) return;
        navigator.serviceWorker.ready.then(reg => {
          if (!("PushManager" in window)) return Promise.resolve(null);
          const vapidKey = document.querySelector('meta[name="vapid-public-key"]')?.content || '';
          if (!vapidKey) return Promise.resolve(null);
          return reg.pushManager.getSubscription().then((existing: PushSubscription | null) => {
            if (existing) return existing;
            const key = Uint8Array.from(atob(vapidKey.replace(/-/g,"+").replace(/_/g,"/")), (c:string) => c.charCodeAt(0));
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          });
        }).then((sub: any) => {
          if (!sub) return;
          const p256dh = btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
          const auth   = btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth")))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
          fetch("/api/push-subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"subscribe",endpoint:sub.endpoint,p256dh,auth})}).catch(()=>{});
        }).catch(()=>{});
      }).catch(()=>{});
    }
    // ────────────────────────────────────────────────────────────────────────
    navigator.geolocation.getCurrentPosition(
      p=>setGps({status:"success",lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy}),
      e=>setGps({status:"error",message:e.code===1?"Location denied. Allow permission.":"Cannot get GPS."}),
      {enableHighAccuracy:true,timeout:15000,maximumAge:0}
    );
  },[]);
  useEffect(()=>{if(locations.length>0&&todayRecords.length===0)requestGps();},[]);

  const currentHHMM=nowHHMM();
  const activeSessions=schedules.filter(s=>isScheduleActiveNow(s as any,currentHHMM));
  // A location with zero schedules configured is INACTIVE — it must never be offered
  // as an "Open Seva" fallback. A location only becomes markable once an admin adds
  // an actual schedule for it (see admin/locations).
  const markedIds=new Set(todayRecords.map(r=>r.schedule_id));
  const [selectedIds,setSelectedIds]=useState<Set<number>>(new Set());
  const [sevaRole,setSevaRole]=useState("");
  const [customSeva,setCustomSeva]=useState("");
  const sessionList=activeSessions.map(s=>({id:s.id,label:s.label,type:s.satsang_type_name,loc:s.location_name}));
  useEffect(()=>{const u=sessionList.filter(s=>!markedIds.has(s.id)).map(s=>s.id);setSelectedIds(new Set(u));},[]);

  const allMarked=sessionList.every(s=>markedIds.has(s.id));
  const greeting=new Date().getHours()<12?"Good morning":new Date().getHours()<17?"Good afternoon":"Good evening";

  return (
    <>
      <div className="member-shell">
        <header className="member-header">
          <div className="member-header__logo">
            <div className="member-header__logo-mark">🙏</div>
            <span className="member-header__title">Sevadal</span>
          </div>
          {member.photo_key?<img src={`/api/photo/${encodeURIComponent(member.photo_key)}`} alt={member.name} className="avatar avatar-sm" style={{objectFit:"cover"}}/>:<div className="avatar avatar-sm">{member.name[0]}</div>}
        </header>

      <main className="member-content">
        {appSettings?.announcement_banner && (
          <div style={{background:"var(--saffron-600)",color:"white",textAlign:"center",padding:"8px 14px",fontSize:"13px",fontWeight:"500"}}>
            📢 {appSettings.announcement_banner}
          </div>
        )}
        <div className="member-hero">
          <div className="member-hero__greeting">{greeting},</div>
          <div className="member-hero__name">{member.name}</div>
          <div suppressHydrationWarning className="member-hero__date">{formatDateIST(today)}</div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"1px",background:"var(--gray-100)",borderBottom:"1px solid var(--gray-100)"}}>
          {[{label:"This Month",value:monthCount},{label:"All Time",value:totalCount},{label:"Today",value:allMarked?"✓":todayRecords.length>0?todayRecords.length:"—",color:allMarked?"var(--success)":undefined}].map(({label,value,color})=>(
            <div key={label} style={{background:"white",padding:"14px 8px",textAlign:"center"}}>
              <div style={{fontFamily:"var(--font-heading)",fontSize:"22px",fontWeight:"800",color:color??"var(--gray-900)"}}>{value}</div>
              <div style={{fontSize:"11px",color:"var(--gray-400)",marginTop:"2px"}}>{label}</div>
            </div>
          ))}
        </div>

        <div className="attend-btn-wrap">
          {actionData?.success&&(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:"6px",padding:"20px",background:"var(--success-light)",borderRadius:"var(--radius-lg)",border:"1px solid #86efac",textAlign:"center"}}>
              <div style={{fontSize:"36px"}}>✅</div>
              <div style={{fontFamily:"var(--font-heading)",fontWeight:"700",fontSize:"16px",color:"var(--success)"}}>Attendance Marked!</div>
              <div style={{fontSize:"12px",color:"#15803d"}}>{actionData.locationName}</div>
            </div>
          )}

          {!actionData?.success&&(<>
            <div className={`gps-status ${gps.status==="success"?"gps-inside":gps.status==="error"?"gps-outside":"gps-loading"}`}>
              <div className="gps-dot"/>
              <span style={{fontSize:"13px"}}>
                {gps.status==="loading"&&"Getting your location…"}
                {gps.status==="idle"&&"Tap below to get location"}
                {gps.status==="success"&&`GPS ready · ±${Math.round(gps.accuracy)}m`}
                {gps.status==="error"&&gps.message}
              </span>
            </div>

            {sessionList.length>0&&(
              <div>
                <div style={{fontSize:"12px",fontWeight:"600",color:"var(--gray-500)",marginBottom:"8px",textTransform:"uppercase",letterSpacing:".04em"}}>Today's Sessions</div>
                {sessionList.map(sess=>{
                  const marked=markedIds.has(sess.id);
                  const sel=selectedIds.has(sess.id);
                  return (
                    <label key={sess.id} style={{display:"flex",alignItems:"center",gap:"10px",padding:"12px",borderRadius:"var(--radius-sm)",border:`1.5px solid ${marked?"var(--success)":sel?"var(--primary)":"var(--gray-200)"}`,background:marked?"var(--success-light)":sel?"var(--primary-light)":"white",marginBottom:"8px",cursor:marked?"default":"pointer"}}>
                      <input type="checkbox" checked={marked||sel} disabled={marked} onChange={()=>!marked&&setSelectedIds(p=>{const n=new Set(p);n.has(sess.id)?n.delete(sess.id):n.add(sess.id);return n;})} style={{width:"18px",height:"18px",accentColor:"var(--primary)"}}/>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:"600",fontSize:"14px"}}>{sess.label}</div>
                        <div style={{fontSize:"11px",color:"var(--gray-400)"}}>{sess.type&&`${sess.type} · `}{sess.loc}</div>
                      </div>
                      {marked&&<span className="badge badge-success">Marked</span>}
                    </label>
                  );
                })}
              </div>
            )}
            {sessionList.length===0&&<div style={{textAlign:"center",padding:"16px",background:"var(--gray-50)",borderRadius:"var(--radius-sm)",fontSize:"13px",color:"var(--gray-400)"}}>No sessions scheduled today</div>}

            {selectedIds.size>0&&(
              <div className="form-group">
                <label className="form-label">Your Seva Role Today *</label>
                <select className="form-select" value={sevaRole} onChange={e=>setSevaRole(e.target.value)}>
                  <option value="">— Select seva role —</option>
                  {sevaRoles.map(r=><option key={r.id} value={r.name}>{r.name}</option>)}
                  <option value="__custom__">Other (specify…)</option>
                </select>
                {sevaRole==="__custom__"&&<input type="text" className="form-input" style={{marginTop:"8px"}} placeholder="Type your seva role" value={customSeva} onChange={e=>setCustomSeva(e.target.value)}/>}
              </div>
            )}

            {actionData?.error&&<div className="alert alert-error"><span>⚠️</span><span>{actionData.error}</span></div>}
            {sevaRoleError&&<div className="alert alert-error"><span>⚠️</span><span>Please select your Seva Role before marking attendance.</span></div>}

            {gps.status!=="success"?(
              <button type="button" className="attend-btn attend-btn-disabled" onClick={requestGps} style={{cursor:"pointer"}}>📍 Get My Location First</button>
            ):selectedIds.size===0?(
              <div className="attend-btn attend-btn-done">All sessions marked ✓</div>
            ):(
              <Form method="post" onSubmit={e=>{const role=sevaRole==="__custom__"?customSeva:sevaRole;if(!role){e.preventDefault();setSevaRoleError(true);return;}setSevaRoleError(false);}}>
                <input type="hidden" name="lat" value={gps.status==="success"?gps.lat:""}/>
                <input type="hidden" name="lng" value={gps.status==="success"?gps.lng:""}/>
                <input type="hidden" name="accuracy" value={gps.status==="success"?gps.accuracy:""}/>
                <input type="hidden" name="sevaRole" value={sevaRole}/>
                <input type="hidden" name="customSevaRole" value={customSeva}/>
                <input type="hidden" name="scheduleIds" value={JSON.stringify(Array.from(selectedIds))}/>
                <button type="submit" className="attend-btn attend-btn-active" disabled={submitting}>
                  {submitting?<><span className="spinner" style={{borderTopColor:"white"}}/> Marking…</>:"✅ Mark Present"}
                </button>
              </Form>
            )}
            {gps.status==="error"&&<button className="btn btn-outline btn-md btn-full" type="button" onClick={requestGps}>🔄 Retry</button>}
          </>)}
        </div>
        
        {'UNCMT' == 'CMT' && (
        <div> 
          {announcements && announcements.length > 0 && (<>
          <div className="section-title" style={{marginTop:"16px"}}>Notices & Announcements</div>
            <div style={{padding:"0 16px",display:"flex",flexDirection:"column",gap:"10px"}}>
            {announcements.map((a: any) => {
              // image_key is a JSON array of attachments: [{key, name, type}]
              let firstImgKey: string | null = null;
              try {
                const atts = JSON.parse(a.image_key || "[]");
                const firstImg = Array.isArray(atts) ? atts.find((att: any) => /\.(jpg|jpeg|png|webp|gif)$/i.test(att.key || "")) : null;
                firstImgKey = firstImg?.key ?? null;
              } catch { firstImgKey = null; }
              return (
                <div key={a.id} className="card" style={{overflow:"hidden"}}>
                  {firstImgKey && <img src={`/api/photo/${encodeURIComponent(firstImgKey)}`} alt={a.title} style={{width:"100%",maxHeight:"180px",objectFit:"cover"}}/>}
                  <div style={{padding:"12px 14px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"4px"}}>
                      {a.is_pinned ? <span className="badge badge-warning" style={{fontSize:"10px"}}>Pinned</span> : null}
                      <span style={{fontWeight:"700",fontSize:"14px"}}>{a.title}</span>
                    </div>
                    {a.body && <div style={{fontSize:"13px",color:"var(--gray-500)",lineHeight:"1.5"}}>{a.body}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>)}
        
        </div>
        )}
        
        {history.length>0&&(<>
          <div className="section-title" style={{marginTop:"8px"}}>Recent Attendance</div>
          <div className="card" style={{margin:"0 16px"}}>
            {history.map(rec=>(
              <div key={rec.id} className="history-item">
                <div>
                  <div className="history-item__date">{formatDateIST(rec.date)}</div>
                  <div className="history-item__meta">{rec.session_label?`${rec.session_label} · `:""}{rec.location_name} · {formatTimeIST(rec.marked_at)}{rec.seva_role?` · ${rec.seva_role}`:""}</div>
                </div>
                <span className="badge badge-success">Present</span>
              </div>
            ))}
          </div>
          <div style={{height:"16px"}}/>
        </>)}
      </main>

      {/* PWA install prompt — shows to logged-in members on Android/iOS */}
      <div style={{ maxWidth: "var(--mobile-max)", margin: "0 auto", padding: "0 16px 8px" }}>
        <PWAInstallPrompt />
      </div>

      <nav className="bottom-nav">
        <Link to="/dashboard" className="bottom-nav__item active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9,22 9,12 15,12 15,22"/></svg>
          Attendance
        </Link>
        <Link to="/news" className="bottom-nav__item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>
          Notices
        </Link>
        <Link to="/profile" className="bottom-nav__item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          Profile
        </Link>
      </nav>
    </div>
    <Toast message={actionData?.error} type="error" />
    <Toast message={actionData?.success?"✅ Attendance marked!":undefined} type="success" />
    </>
  );
}