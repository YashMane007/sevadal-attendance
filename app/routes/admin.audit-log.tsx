import { type LoaderFunctionArgs, type MetaFunction, json } from "@remix-run/cloudflare";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import { requireAdmin } from "~/lib/session.server";
import { useAdminLayout } from "~/routes/admin";
import { getAuditLog, type AuditLogRow } from "~/lib/audit.server";
import { ACTION_LABELS } from "~/lib/audit-labels";
import { getAdminPermissions, can } from "~/lib/permissions.server";

export const meta: MetaFunction = () => [{ title: "Audit Log — Sevadal Admin" }];

function fmtIST(iso: string) {
  const u = iso.endsWith("Z") ? iso : iso + "Z";
  return new Date(u).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { DB, SESSION_SECRET } = context.cloudflare.env;
  const session = await requireAdmin(request, SESSION_SECRET, DB);
  const perms   = await getAdminPermissions(DB, session.memberId, session.isSuperAdmin);
  if (!can(perms, "view_audit_log")) {
    return json({ rows: [], total: 0, page: 1, totalPages: 0, hasAccess: false });
  }
  const url     = new URL(request.url);
  const page    = parseInt(url.searchParams.get("page") ?? "1");
  const action  = url.searchParams.get("action") ?? "";
  const actorId = url.searchParams.get("actor") ?? "";
  const from    = url.searchParams.get("from") ?? "";
  const to      = url.searchParams.get("to") ?? "";
  const search  = url.searchParams.get("q") ?? "";
  const { rows, total } = await getAuditLog(DB, { page, pageSize: 50, action: action||undefined, actorId: actorId||undefined, from: from||undefined, to: to||undefined, search: search||undefined });
  return json({ rows, total, page, totalPages: Math.ceil(total / 50), hasAccess: true, action, actorId, from, to, search });
}

const ROLE_COLORS: Record<string, string> = {
  super_admin: "badge-warning",
  admin: "badge-primary",
  member: "badge-gray",
};

export default function AuditLogPage() {
  const { rows, total, page, totalPages, hasAccess, action, from, to, search } = useLoaderData<typeof loader>();
  const { isSuperAdmin } = useAdminLayout();
  const [sp, setSp] = useSearchParams();
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); if (k !== "page") n.set("page", "1"); setSp(n); };

  if (!hasAccess) return (
    <>
      <div className="admin-topbar"><h1 className="admin-topbar__title">📜 Audit Log</h1></div>
      <div className="admin-content"><div className="alert alert-error">You do not have permission to view the audit log.</div></div>
    </>
  );

  const actionOptions = Object.entries(ACTION_LABELS).map(([k, v]) => ({ k, v }));

  return (
    <>
      <div className="admin-topbar">
        <h1 className="admin-topbar__title">📜 Audit Log ({total} entries)</h1>
        <a href={`/api/export?from=${from || "2020-01-01"}&to=${to || new Date().toLocaleDateString("en-CA")}&format=csv`} className="btn btn-secondary btn-md" title="Export audit log (not available — use attendance export)">📥 Export CSV</a>
      </div>
      <div className="admin-content">
        <div className="toolbar" style={{ flexWrap: "wrap", gap: "10px", marginBottom: "16px" }}>
          <input type="text" className="form-input" placeholder="Search actor / action…" style={{ maxWidth: "200px" }} defaultValue={search} onChange={e => set("q", e.target.value)} />
          <select className="form-select" style={{ width: "auto" }} value={action} onChange={e => set("action", e.target.value)}>
            <option value="">All Actions</option>
            {actionOptions.map(({ k, v }) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="date" className="form-input" style={{ width: "auto" }} defaultValue={from} onChange={e => set("from", e.target.value)} title="From date" />
          <input type="date" className="form-input" style={{ width: "auto" }} defaultValue={to} onChange={e => set("to", e.target.value)} title="To date" />
        </div>

        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time (IST)</th>
                  <th>Actor</th>
                  <th>Role</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Details</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--gray-400)", padding: "40px" }}>No audit entries found.</td></tr>}
                {rows.map(r => {
                  let details = "";
                  try { const d = JSON.parse(r.details ?? "{}"); details = Object.entries(d).slice(0, 2).map(([k, v]) => `${k}: ${String(v).slice(0, 30)}`).join(", "); } catch {}
                  return (
                    <tr key={r.id}>
                      <td style={{ fontSize: "12px", whiteSpace: "nowrap" }}>{fmtIST(r.created_at)}</td>
                      <td>
                        <div style={{ fontWeight: "600", fontSize: "13px" }}>{r.actor_name ?? "System"}</div>
                        <div style={{ fontSize: "11px", color: "var(--gray-400)" }}>{r.actor_id ?? ""}</div>
                      </td>
                      <td><span className={`badge ${ROLE_COLORS[r.actor_role ?? "member"] ?? "badge-gray"}`}>{r.actor_role ?? "—"}</span></td>
                      <td style={{ fontSize: "13px" }}>{ACTION_LABELS[r.action] ?? r.action}</td>
                      <td style={{ fontSize: "12px", color: "var(--gray-500)" }}>{r.target_type ? `${r.target_type}: ${r.target_id ?? ""}` : "—"}</td>
                      <td style={{ fontSize: "11px", color: "var(--gray-400)", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={details}>{details || "—"}</td>
                      <td style={{ fontSize: "11px", color: "var(--gray-400)" }}>{r.ip_address ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="pagination">
              <button className="page-btn" disabled={page <= 1} onClick={() => set("page", String(page - 1))}>‹</button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => i + 1).map(p => (
                <button key={p} className={`page-btn${p === page ? " active" : ""}`} onClick={() => set("page", String(p))}>{p}</button>
              ))}
              <button className="page-btn" disabled={page >= totalPages} onClick={() => set("page", String(page + 1))}>›</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
