import type { ReactNode } from "react";
import { currentUser } from "@/lib/auth";
import "./globals.css";

// The header shows who is signed in, so every route, the built in 404 page too, is rendered for its request.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Voxium",
  description: "Keep developers and coding agents inside your architecture.",
};

/** Layers on top of each other, the one at the top set apart: the rules point down. */
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="5" rx="1.5" fill="currentColor" />
      <rect x="3" y="10" width="18" height="5" rx="1.5" fill="currentColor" opacity="0.6" />
      <rect x="3" y="17" width="18" height="4" rx="1.5" fill="currentColor" opacity="0.35" />
    </svg>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // A page must not fail because the header could not tell who is signed in.
  const user = await currentUser().catch(() => null);
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand">
            <Mark />
            Voxium
          </a>
          <nav aria-label="Main">
            {user && <a href="/dashboard">Dashboard</a>}
            <span className="site-links">
              <a href="/how-it-works">How it works</a>
              <a href="/agents">For agents</a>
              <a href="/security">Security</a>
              <a href="/pricing">Pricing</a>
            </span>
          </nav>
          <div className="who">
            {user ? (
              <>
                <span className="login">{user.login}</span>
                <a href="/api/auth/logout">Sign out</a>
              </>
            ) : (
              <a className="btn" href="/api/auth/login">Sign in with GitHub</a>
            )}
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="inner">
            <div>
              <a href="/" className="brand">
                <Mark />
                Voxium
              </a>
              <p className="fine">Keep developers and coding agents inside your architecture.</p>
            </div>
            <div>
              <h4>Product</h4>
              <ul>
                <li><a href="/how-it-works">How it works</a></li>
                <li><a href="/agents">For agents</a></li>
                <li><a href="/pricing">Pricing</a></li>
              </ul>
            </div>
            <div>
              <h4>Trust</h4>
              <ul>
                <li><a href="/security">Security</a></li>
                <li><a href="/legal/privacy">Privacy</a></li>
                <li><a href="/legal/cookies">Cookies</a></li>
              </ul>
            </div>
            <div>
              <h4>Legal</h4>
              <ul>
                <li><a href="/legal/terms">Terms of Service</a></li>
                <li><a href="/legal/privacy">Privacy Policy</a></li>
              </ul>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
