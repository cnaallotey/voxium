import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Voxium",
  description: "Keep developers and coding agents inside your architecture.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand">Voxium</a>
          <nav>
            <a href="/dashboard">Dashboard</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
