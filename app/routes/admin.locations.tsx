import { type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction, json } from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { LocationPicker } from "~/components/LocationPicker";
import { useConfirm } from "~/components/ConfirmModal";
import { Toast } from "~/components/Toast";
import { requireAdmin } from "~/lib/session.server";
import { createLocation, listLocations, updateLocation, deleteLocation, getSchedulesForLocation, createLocationSchedule, updateLocationSchedule, deleteLocationSchedule, listSatsangTypes, type LocationSchedule } from "~/lib/db.server";
import { getAdminPermissions, can } from "~/lib/permissions.server";
import { logAudit, getClientIp } from "~/lib/audit.server";

export const meta: MetaFunction = () => [{ title: "Locations — Sevadal Admin" }];
function todayISO(){ return new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Kolkata"}); }
function fmtTime(t:string){ const[h,m]=t.split(":").map(Number); return `${h%12||12}:${String(m).padStart(2,"0")} ${h>=12?"PM":"AM"}`; }
function fmtDateWithDay(d:string){ return new Date(d+"T00:00:00").toLocaleDateString("en-IN",{weekday:"short",day:"numeric",month:"short",year:"numeric"}); }

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { DB, SESSION_SECRET } = context.cloudflare.env;
  const session = await requireAdmin(request, SESSION_SECRET, DB);
  const perms = await getAdminPermissions(DB, session.memberId, session.isSuperAdmin);
  const [locations, satsangTypes] = await Promise.all([listLocations(DB), listSatsangTypes(DB,true)]);
  const schedulesMap: Record<number,LocationSchedule[]> = {};
  for (const loc of locations) {
    const s = await getSchedulesForLocation(DB, loc.id);
    schedulesMap[loc.id] = s.sort((a,b)=>b.date.localeCompare(a.date));
  }
  return json({
    locations, schedulesMap, satsangTypes,
    canView:      can(perms,"view_locations")    || session.isSuperAdmin,
    canAdd:       can(perms,"add_locations")     || session.isSuperAdmin,
    canEdit:      can(perms,"edit_locations")    || session.isSuperAdmin,
    canDeleteLoc: can(perms,"delete_locations")  || session.isSuperAdmin,
    canToggle:    can(perms,"toggle_locations")  || session.isSuperAdmin,
    canAddSch: can(perms,"add_schedules")    || session.isSuperAdmin,
    canEditSch:can(perms,"edit_schedules")   || session.isSuperAdmin,
    canDelSch: can(perms,"delete_schedules") || session.isSuperAdmin,
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
  const { DB, SESSION_SECRET } = context.cloudflare.env;
  const session = await requireAdmin(request, SESSION_SECRET, DB);
  const form = await request.formData();
  const intent = form.get("intent") as string;
  const perms = await getAdminPermissions(DB, session.memberId, session.isSuperAdmin);
  const ip = getClientIp(request);
  const actor = { actorId:session.memberId, actorName:session.memberName, actorRole:session.isSuperAdmin?"super_admin":"admin" as const, ip };

  if (intent==="create-location") {
    if (!can(perms,"add_locations")) return json({err:"No permission to add locations."});
    const name=(form.get("name") as string)?.trim();
    const lat=parseFloat(form.get("lat") as string), lng=parseFloat(form.get("lng") as string);
    const radius=parseInt(form.get("radius_meters") as string)||200;
    if (!name) return json({err:"Name required."});
    if (isNaN(lat)||isNaN(lng)) return json({err:"Valid GPS required."});
    if (radius<50||radius>5000) return json({err:"Radius: 50–5000m."});
    await createLocation(DB,{name,address:(form.get("address") as string)||undefined,lat,lng,radius_meters:radius});
    await logAudit(DB,{...actor,action:"location_created",details:{name,lat,lng,radius}});
    return json({ok:"Location created."});
  }
  if (intent==="edit-location") {
    if (!can(perms,"edit_locations")) return json({err:"No permission to edit locations."});
    const id=parseInt(form.get("locationId") as string);
    const lat=parseFloat(form.get("lat") as string), lng=parseFloat(form.get("lng") as string);
    if (isNaN(lat)||isNaN(lng)) return json({err:"Valid coordinates required."});
    await updateLocation(DB,id,{name:(form.get("name") as string)||undefined,address:(form.get("address") as string)||undefined,lat,lng,radius_meters:parseInt(form.get("radius_meters") as string)||undefined});
    await logAudit(DB,{...actor,action:"location_updated",targetType:"location",targetId:String(id)});
    return json({ok:"Location updated."});
  }
  if (intent==="toggle-location") {
    if (!can(perms,"toggle_locations")) return json({err:"No permission to activate/deactivate locations."});
    const id=parseInt(form.get("locationId") as string);
    const cur=form.get("currentActive")==="1";
    await updateLocation(DB,id,{is_active:cur?0:1});
    await logAudit(DB,{...actor,action:"location_toggled",targetType:"location",targetId:String(id),details:{active:!cur}});
    return json({ok:`Location ${cur?"deactivated":"activated"}.`});
  }
  if (intent==="add-schedule") {
    if (!can(perms,"add_schedules")) return json({err:"No permission to add schedules."});
    const locationId=parseInt(form.get("locationId") as string);
    const label=(form.get("label") as string)?.trim(), date=form.get("date") as string;
    const allDay=form.get("all_day")==="1";
    const start=!allDay?(form.get("start_time") as string)||undefined:undefined;
    const end=!allDay?(form.get("end_time") as string)||undefined:undefined;
    if (!label||!date) return json({err:"Label and date required."});
    if (!allDay&&start&&end&&start>=end) return json({err:"Start must be before end."});
    await createLocationSchedule(DB,{location_id:locationId,label,satsang_type_name:(form.get("satsang_type") as string)||undefined,date,all_day:allDay,start_time:start,end_time:end});
    await logAudit(DB,{...actor,action:"schedule_created",targetType:"location",targetId:String(locationId),details:{label,date}});
    return json({ok:"Schedule added."});
  }
  if (intent==="edit-schedule") {
    if (!can(perms,"edit_schedules")) return json({err:"No permission to edit schedules."});
    const id=parseInt(form.get("scheduleId") as string);
    const allDay=form.get("all_day")==="1";
    await updateLocationSchedule(DB,id,{label:(form.get("label") as string)||undefined,satsang_type_name:(form.get("satsang_type") as string)||null,date:(form.get("date") as string)||undefined,all_day:allDay?1:0,start_time:allDay?null:((form.get("start_time") as string)||null),end_time:allDay?null:((form.get("end_time") as string)||null)});
    await logAudit(DB,{...actor,action:"schedule_updated",targetType:"schedule",targetId:String(id)});
    return json({ok:"Schedule updated."});
  }
  if (intent==="delete-location") {
    if (!can(perms,"delete_locations")) return json({err:"No permission to delete locations."});
    const id=parseInt(form.get("locationId") as string);
    await deleteLocation(DB,id);
    await logAudit(DB,{...actor,action:"location_deleted",targetType:"location",targetId:String(id)});
    return json({ok:"Location deleted."});
  }
  if (intent==="delete-schedule") {
    if (!can(perms,"delete_schedules")) return json({err:"No permission to delete schedules."});
    const id=parseInt(form.get("scheduleId") as string);
    await deleteLocationSchedule(DB,id);
    await logAudit(DB,{...actor,action:"schedule_deleted",targetType:"schedule",targetId:String(id)});
    return json({ok:"Schedule deleted."});
  }
  return json({err:"Unknown action."});
  } catch(e:any) {
    console.error("[Locations Action Error]",e);
    return json({err: e?.message ?? "Something went wrong. Please try again."});
  }
}

export default function AdminLocationsPage() {
  const { locations, schedulesMap, satsangTypes, canView, canAdd, canEdit, canDeleteLoc, canToggle, canAddSch, canEditSch, canDelSch } = useLoaderData<typeof loader>();
  const ad = useActionData<typeof action>() as any;
  const nav = useNavigation();
  const submitting = nav.state==="submitting";
  const { confirm, ConfirmDialog } = useConfirm();
  const [showAdd,setShowAdd]=useState(false);
  const [editLoc,setEditLoc]=useState<typeof locations[0]|null>(null);
  const [schedModal,setSchedModal]=useState<number|null>(null);
  const [editSched,setEditSched]=useState<LocationSchedule|null>(null);
  const [allDay,setAllDay]=useState(false);
  const [editAllDay,setEditAllDay]=useState(false);

  return (
    <>
      <div className="admin-topbar">
        <h1 className="admin-topbar__title">Satsang Locations</h1>
        {canAdd&&<button className="btn btn-primary btn-md" onClick={()=>setShowAdd(true)}>+ Add Location</button>}
      </div>

      <div className="admin-content">
        {ad?.ok&&<div className="alert alert-success" style={{marginBottom:"16px"}}>✅ {ad.ok}</div>}
        {ad?.err&&<div className="alert alert-error" style={{marginBottom:"16px"}}>⚠️ {ad.err}</div>}

        {!canView ? (
          <div className="alert alert-error">⚠️ You do not have permission to view locations.</div>
        ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(360px,1fr))",gap:"20px"}}>
          {locations.length===0&&<div className="card"><div className="empty-state"><div className="empty-state__icon">📍</div><div className="empty-state__text">No locations yet.</div></div></div>}
          {locations.map(loc=>{
            const schedules=schedulesMap[loc.id]??[];
            return (
              <div key={loc.id} className="card" style={{opacity:loc.is_active?1:0.65}}>
                <div className="card-header">
                  <div><h3>{loc.name}</h3>{loc.address&&<div style={{fontSize:"12px",color:"var(--gray-400)",marginTop:"2px"}}>{loc.address}</div>}</div>
                  <span className={`badge ${loc.is_active?"badge-success":"badge-error"}`}>{loc.is_active?"Active":"Inactive"}</span>
                </div>
                <div className="card-body">
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"10px",marginBottom:"14px",fontSize:"13px"}}>
                    <div><div style={{fontSize:"10px",color:"var(--gray-400)",textTransform:"uppercase"}}>Lat</div><strong>{loc.lat.toFixed(5)}</strong></div>
                    <div><div style={{fontSize:"10px",color:"var(--gray-400)",textTransform:"uppercase"}}>Lng</div><strong>{loc.lng.toFixed(5)}</strong></div>
                    <div><div style={{fontSize:"10px",color:"var(--gray-400)",textTransform:"uppercase"}}>Radius</div><strong>{loc.radius_meters}m</strong></div>
                  </div>

                  <div style={{marginBottom:"12px"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"8px"}}>
                      <div style={{fontSize:"12px",fontWeight:"700",color:"var(--gray-600)",textTransform:"uppercase",letterSpacing:".04em"}}>
                        Schedules <span style={{color:"var(--gray-400)",fontWeight:"400",textTransform:"none",fontSize:"10px"}}>↓ newest</span>{schedules.length===0&&<span style={{color:"var(--warning, #b45309)",fontWeight:"600",textTransform:"none"}}> — No schedule configured (inactive)</span>}
                      </div>
                      {canAddSch&&<button type="button" className="btn btn-sm btn-outline" onClick={()=>setSchedModal(loc.id)}>+ Add</button>}
                    </div>
                    {schedules.map(s=>(
                      <div key={s.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 10px",background:"var(--gray-50)",borderRadius:"var(--radius-sm)",fontSize:"12px",gap:"8px",marginBottom:"4px"}}>
                        <div>
                          <div style={{fontWeight:"600"}}>{s.label}</div>
                          <div style={{color:"var(--gray-500)"}}>
                            {fmtDateWithDay(s.date)}{" · "}
                            {s.all_day?"All Day":s.start_time&&s.end_time?`${fmtTime(s.start_time)} – ${fmtTime(s.end_time)}`:"—"}
                            {s.satsang_type_name?` · ${s.satsang_type_name}`:""}
                          </div>
                        </div>
                        <div style={{display:"flex",gap:"4px"}}>
                          {canEditSch&&<button type="button" className="btn btn-sm btn-secondary" onClick={()=>{setEditSched(s);setEditAllDay(s.all_day===1);}}>✏️</button>}
                          {canDelSch?(
                            <Form method="post" onSubmit={async e=>{e.preventDefault();if(await confirm(`Delete schedule "${s.label}" on ${fmtDateWithDay(s.date)}?`,{danger:true,title:"Delete Schedule",confirmLabel:"Delete"}))(e.target as HTMLFormElement).submit();}}>
                              <input type="hidden" name="intent" value="delete-schedule"/>
                              <input type="hidden" name="scheduleId" value={s.id}/>
                              <button type="submit" className="btn btn-sm btn-danger">✕</button>
                            </Form>
                          ):(
                            <button type="button" className="btn btn-sm btn-secondary" disabled style={{opacity:0.35}} title="No permission to delete schedules">✕</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
                    {canEdit&&<button type="button" className="btn btn-sm btn-secondary" onClick={()=>setEditLoc(loc)}>✏️ Edit</button>}
                    {canToggle&&(
                      <Form method="post" onSubmit={async e=>{e.preventDefault();if(await confirm(loc.is_active?`Deactivate "${loc.name}"?`:`Activate "${loc.name}"?`,{danger:loc.is_active,title:loc.is_active?"Deactivate":"Activate",confirmLabel:loc.is_active?"Deactivate":"Activate"}))(e.target as HTMLFormElement).submit();}}>
                        <input type="hidden" name="intent" value="toggle-location"/>
                        <input type="hidden" name="locationId" value={loc.id}/>
                        <input type="hidden" name="currentActive" value={loc.is_active?"1":"0"}/>
                        <button type="submit" className={`btn btn-sm ${loc.is_active?"btn-danger":"btn-secondary"}`}>{loc.is_active?"Deactivate":"Activate"}</button>
                      </Form>
                    )}
                    {canDeleteLoc&&(
                      <Form method="post" onSubmit={async e=>{e.preventDefault();if(await confirm(`Delete "${loc.name}"? All schedules removed too. Cannot undo.`,{danger:true,title:"Delete Location",confirmLabel:"Delete"}))(e.target as HTMLFormElement).submit();}}>
                        <input type="hidden" name="intent" value="delete-location"/>
                        <input type="hidden" name="locationId" value={loc.id}/>
                        <button type="submit" className="btn btn-sm btn-danger">🗑️ Delete</button>
                      </Form>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>

      {/* Add Location Modal */}
      {showAdd&&(
        <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)setShowAdd(false);}}>
          <div className="modal-box">
            <div className="modal-header"><h3>Add Satsang Location</h3><button className="modal-close" type="button" onClick={()=>setShowAdd(false)}>✕</button></div>
            <Form method="post" onSubmit={()=>setShowAdd(false)}>
              <div className="modal-body">
                <input type="hidden" name="intent" value="create-location"/>
                <div style={{display:"flex",flexDirection:"column",gap:"14px"}}>
                  <div className="form-group"><label className="form-label">Location Name *</label><input name="name" type="text" className="form-input" placeholder="Main Satsang Bhavan" required/></div>
                  <div className="form-group"><label className="form-label">Address</label><input name="address" type="text" className="form-input"/></div>
                  <LocationPicker />
                  <div className="form-group"><label className="form-label">Radius (metres) *</label><input name="radius_meters" type="number" min="50" max="5000" className="form-input" defaultValue="200" required/><span className="form-hint">150–300m recommended.</span></div>
                </div>
              </div>
              <div className="modal-footer"><button type="button" className="btn btn-secondary btn-md" onClick={()=>setShowAdd(false)}>Cancel</button><button type="submit" className="btn btn-primary btn-md" disabled={submitting}>{submitting?"Creating…":"Add Location"}</button></div>
            </Form>
          </div>
        </div>
      )}

      {/* Edit Location Modal */}
      {editLoc&&(
        <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)setEditLoc(null);}}>
          <div className="modal-box">
            <div className="modal-header"><h3>Edit — {editLoc.name}</h3><button className="modal-close" type="button" onClick={()=>setEditLoc(null)}>✕</button></div>
            <Form method="post" onSubmit={()=>setEditLoc(null)}>
              <div className="modal-body">
                <input type="hidden" name="intent" value="edit-location"/><input type="hidden" name="locationId" value={editLoc.id}/>
                <div style={{display:"flex",flexDirection:"column",gap:"14px"}}>
                  <div className="form-group"><label className="form-label">Name *</label><input name="name" type="text" className="form-input" defaultValue={editLoc.name} required/></div>
                  <div className="form-group"><label className="form-label">Address</label><input name="address" type="text" className="form-input" defaultValue={editLoc.address??""}/></div>
                  <LocationPicker defaultLat={editLoc.lat} defaultLng={editLoc.lng} />
                  <div className="form-group"><label className="form-label">Radius (m)</label><input name="radius_meters" type="number" min="50" max="5000" className="form-input" defaultValue={editLoc.radius_meters}/></div>
                </div>
              </div>
              <div className="modal-footer"><button type="button" className="btn btn-secondary btn-md" onClick={()=>setEditLoc(null)}>Cancel</button><button type="submit" className="btn btn-primary btn-md" disabled={submitting}>{submitting?"Saving…":"Save"}</button></div>
            </Form>
          </div>
        </div>
      )}

      {/* Add Schedule Modal */}
      {schedModal!==null&&(
        <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)setSchedModal(null);}}>
          <div className="modal-box">
            <div className="modal-header"><h3>Add Schedule — {locations.find(l=>l.id===schedModal)?.name}</h3><button className="modal-close" type="button" onClick={()=>setSchedModal(null)}>✕</button></div>
            <Form method="post" onSubmit={()=>setSchedModal(null)}>
              <div className="modal-body">
                <input type="hidden" name="intent" value="add-schedule"/><input type="hidden" name="locationId" value={schedModal}/>
                <div style={{display:"flex",flexDirection:"column",gap:"14px"}}>
                  <div className="form-group"><label className="form-label">Label *</label><input name="label" type="text" className="form-input" placeholder="e.g. Morning Satsang" required/></div>
                  <div className="form-group"><label className="form-label">Satsang Type</label><select name="satsang_type" className="form-select"><option value="">— Optional —</option>{satsangTypes.map(t=><option key={t.id} value={t.name}>{t.name}</option>)}</select></div>
                  <div className="form-group"><label className="form-label">Date *</label><input name="date" type="date" className="form-input" defaultValue={todayISO()} required/></div>
                  <label style={{display:"flex",alignItems:"center",gap:"8px",cursor:"pointer"}}><input type="checkbox" name="all_day" value="1" checked={allDay} onChange={e=>setAllDay(e.target.checked)} style={{width:"16px",height:"16px"}}/><span style={{fontSize:"13px",fontWeight:"500"}}>Full Day (no time restriction)</span></label>
                  {!allDay&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
                    <div className="form-group"><label className="form-label">Start Time</label><input name="start_time" type="time" className="form-input" required/></div>
                    <div className="form-group"><label className="form-label">End Time</label><input name="end_time" type="time" className="form-input" required/></div>
                  </div>}
                </div>
              </div>
              <div className="modal-footer"><button type="button" className="btn btn-secondary btn-md" onClick={()=>setSchedModal(null)}>Cancel</button><button type="submit" className="btn btn-primary btn-md" disabled={submitting}>Add Schedule</button></div>
            </Form>
          </div>
        </div>
      )}

      {/* Edit Schedule Modal */}
      {editSched&&(
        <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)setEditSched(null);}}>
          <div className="modal-box">
            <div className="modal-header"><h3>Edit Schedule</h3><button className="modal-close" type="button" onClick={()=>setEditSched(null)}>✕</button></div>
            <Form method="post" onSubmit={()=>setEditSched(null)}>
              <div className="modal-body">
                <input type="hidden" name="intent" value="edit-schedule"/><input type="hidden" name="scheduleId" value={editSched.id}/>
                <div style={{display:"flex",flexDirection:"column",gap:"14px"}}>
                  <div className="form-group"><label className="form-label">Label *</label><input name="label" type="text" className="form-input" defaultValue={editSched.label} required/></div>
                  <div className="form-group"><label className="form-label">Satsang Type</label><select name="satsang_type" className="form-select" defaultValue={editSched.satsang_type_name??""}><option value="">— Optional —</option>{satsangTypes.map(t=><option key={t.id} value={t.name}>{t.name}</option>)}</select></div>
                  <div className="form-group"><label className="form-label">Date</label><input name="date" type="date" className="form-input" defaultValue={editSched.date}/></div>
                  <label style={{display:"flex",alignItems:"center",gap:"8px",cursor:"pointer"}}><input type="checkbox" name="all_day" value="1" checked={editAllDay} onChange={e=>setEditAllDay(e.target.checked)} style={{width:"16px",height:"16px"}}/><span style={{fontSize:"13px",fontWeight:"500"}}>Full Day</span></label>
                  {!editAllDay&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
                    <div className="form-group"><label className="form-label">Start Time</label><input name="start_time" type="time" className="form-input" defaultValue={editSched.start_time??""}/></div>
                    <div className="form-group"><label className="form-label">End Time</label><input name="end_time" type="time" className="form-input" defaultValue={editSched.end_time??""}/></div>
                  </div>}
                </div>
              </div>
              <div className="modal-footer"><button type="button" className="btn btn-secondary btn-md" onClick={()=>setEditSched(null)}>Cancel</button><button type="submit" className="btn btn-primary btn-md" disabled={submitting}>{submitting?"Saving…":"Save"}</button></div>
            </Form>
          </div>
        </div>
      )}

      {ConfirmDialog}
      <Toast message={ad?.err} type="error" />
      <Toast message={ad?.ok} type="success" />
    </>
  );
}
