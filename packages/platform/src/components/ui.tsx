import type { ReactNode } from "react";

/** Server components shared by the pages. Plain HTML, no scripts. */

export type Crumb = [label: ReactNode, href?: string];

export function PageHeader({ crumbs = [], title, meta, lead, actions }: { crumbs?: Crumb[]; title: ReactNode; meta?: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      {crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map(([label, href], i) => (
            <span key={i}>
              {i > 0 && <span aria-hidden="true">/ </span>}
              {href ? <a href={href}>{label}</a> : <span aria-current="page">{label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="head-row">
        <div>
          <h1>{title}</h1>
          {meta && <div className="meta">{meta}</div>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
      {lead && <p className="lead">{lead}</p>}
    </header>
  );
}

export function Tabs({ label, items }: { label: string; items: Array<{ label: string; href: string; current?: boolean; show?: boolean }> }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items
        .filter((t) => t.show !== false)
        .map((t) => (
          <a key={t.href} href={t.href} aria-current={t.current ? "page" : undefined}>
            {t.label}
          </a>
        ))}
    </nav>
  );
}

export type RepoTab = "overview" | "proposals" | "drift" | "diagram" | "setup";

/** The sections of a repository. Drift and the diagram need rules on the default branch; setup is for managers before them. */
export function RepoTabs({ id, current, active, manager }: { id: number; current: RepoTab; active: boolean; manager: boolean }) {
  return (
    <Tabs
      label="Repository"
      items={[
        { label: "Overview", href: `/repos/${id}`, current: current === "overview" },
        { label: "Proposals", href: `/repos/${id}/proposals`, current: current === "proposals" },
        { label: "Drift", href: `/repos/${id}/drift`, current: current === "drift", show: active || current === "drift" },
        { label: "Diagram", href: `/repos/${id}/diagram`, current: current === "diagram", show: active || current === "diagram" },
        { label: "Setup", href: `/repos/${id}/setup`, current: current === "setup", show: (!active && manager) || current === "setup" },
      ]}
    />
  );
}

export type OrgTab = "overview" | "rules" | "people" | "audit";

/** The sections of an organization, as far as the person's role on record shows them. Each page checks with GitHub again. */
export function OrgTabs({ id, current, role }: { id: number; current: OrgTab; role: string | null }) {
  const manager = role === "owner" || role === "team_leader";
  return (
    <Tabs
      label="Organization"
      items={[
        { label: "Overview", href: `/orgs/${id}/overview`, current: current === "overview" },
        { label: "Organization rules", href: `/orgs/${id}/rules`, current: current === "rules", show: manager || current === "rules" },
        { label: "People", href: `/orgs/${id}`, current: current === "people", show: role === "owner" || current === "people" },
        { label: "Audit log", href: `/orgs/${id}/audit`, current: current === "audit", show: role === "owner" || current === "audit" },
      ]}
    />
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "warn" | "ok"; children: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === "error" ? "alert" : undefined}>
      {children}
    </div>
  );
}

/** The error a route sent back, if any. */
export function ErrorNotice({ error }: { error?: string }) {
  return error ? <Notice tone="error">{error}</Notice> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "ok" | "bad" }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

/** A check's outcome as a badge, in words and not only in colour. */
export function StateBadge({ state }: { state: string }) {
  const tone = state === "success" ? "ok" : state === "pending" ? "warn" : "bad";
  const label = state === "success" ? "passed" : state === "failure" ? "failed" : state === "error" ? "error" : state;
  return <span className={`badge ${tone}`}>{label}</span>;
}

/** A table that scrolls on its own on a narrow screen instead of the page. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap">{children}</div>;
}

/** A section that opens on a click, without scripts. */
export function Section({ title, hint, open, id, children }: { title: ReactNode; hint?: ReactNode; open?: boolean; id?: string; children: ReactNode }) {
  return (
    <details className="section" open={open} id={id}>
      <summary>
        <span>{title}</span>
        {hint && <span className="muted small">{hint}</span>}
      </summary>
      <div className="body">{children}</div>
    </details>
  );
}

const PROPOSAL_TONE: Record<string, string> = { pending: "warn", pr_open: "info", merged: "ok", rejected: "bad" };

/** A proposal's status as a badge, its label in words. */
export function ProposalBadge({ status, label }: { status: string; label: string }) {
  return <span className={`badge ${PROPOSAL_TONE[status] ?? ""}`}>{label}</span>;
}
