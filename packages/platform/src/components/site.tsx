import type { ReactNode } from "react";
import { isPlaceholder, LEGAL } from "@/lib/legal";
import { Notice } from "./ui";

/** A fact from LEGAL: shown marked while it is still a placeholder, so a draft cannot pass for the final text. */
export function Fill({ value }: { value: string }) {
  return isPlaceholder(value) ? <span className="placeholder">{value}</span> : <>{value}</>;
}

/** An email address from LEGAL, as a link once it is filled in. */
export function Mail({ value }: { value: string }) {
  return isPlaceholder(value) ? <Fill value={value} /> : <a href={`mailto:${value}`}>{value}</a>;
}

/** Said on every legal page until LEGAL.reviewed is set. */
export function DraftBanner() {
  if (LEGAL.reviewed) return null;
  return (
    <Notice tone="warn">
      <strong>Draft, pending legal review.</strong> This page describes what Voxium does today, but it is not final and does not yet bind
      anyone. The marked parts are to be filled in by the operator of Voxium.
    </Notice>
  );
}

export function Cta({ title = "Put your architecture in front of every agent.", children }: { title?: string; children?: ReactNode }) {
  return (
    <section className="cta band">
      <h2>{title}</h2>
      <p className="muted">{children ?? "Sign in with GitHub, install the app on a repository and review what Voxium infers. Nothing is written until you open the setup pull request."}</p>
      <div className="form-actions">
        <a className="btn" href="/api/auth/login">Sign in with GitHub</a>
        <a className="btn secondary" href="/how-it-works">How it works</a>
      </div>
    </section>
  );
}

/** The header of a marketing page. */
export function Intro({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return (
    <section className="hero">
      <p className="kicker">{kicker}</p>
      <h1>{title}</h1>
      <p className="lead">{children}</p>
    </section>
  );
}

/** A legal page: title, effective date, the draft banner and a table of contents of its sections. */
export function LegalPage({ title, sections, children }: { title: string; sections: Array<[id: string, heading: string]>; children: ReactNode }) {
  return (
    <article className="prose">
      <header className="page-head">
        <nav className="crumbs" aria-label="Breadcrumb">
          <span>Legal</span>
        </nav>
        <h1>{title}</h1>
        <div className="meta">
          Effective <Fill value={LEGAL.effectiveDate} /> · <Fill value={LEGAL.company} />
        </div>
      </header>
      <DraftBanner />
      <nav className="toc card" aria-label="Contents">
        <strong>Contents</strong>
        <ol>
          {sections.map(([id, heading]) => (
            <li key={id}>
              <a href={`#${id}`}>{heading}</a>
            </li>
          ))}
        </ol>
      </nav>
      {children}
    </article>
  );
}
